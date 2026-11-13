/**
 * 登录安全：密码强度、口令哈希与登录锁定。
 *
 * 这是整个面板唯一的访问控制，之前完全没有测试。三个容易出事的点：
 *   1. 口令哈希的兼容路径（老数据是没有 salt 的 sha256），迁移期间两种格式都得能验；
 *   2. 失败计数与锁定必须真的累计到 5 次并锁 15 分钟 —— 少一次判定就等于少一道门；
 *   3. 锁定记录来自磁盘文件，加载时必须把非 `admin` / 非 `ip:` 的键丢掉，
 *      否则被写坏的记录能伪造出一个「永不过期」的锁定，把管理员永久锁在门外。
 *
 * 数据目录通过替换 runtime-paths 指到临时目录，不碰真实运行数据。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-auth-'));
const attemptsFile = path.join(tmpDir, 'login-attempts.json');

require.cache[require.resolve('../dist/config/runtime-paths')] = {
    exports: {
        getDataFile: name => path.join(tmpDir, name),
        ensureDataDir: () => tmpDir,
    },
};

const auth = require('../dist/models/auth-security');

function writeAttempts(data) {
    fs.writeFileSync(attemptsFile, JSON.stringify(data, null, 2), 'utf8');
    auth.loadLoginAttempts();
}

function readAttempts() {
    return JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
}

function resetAll() {
    try {
        fs.rmSync(attemptsFile);
    } catch {
        // 首次运行没有文件
    }
    auth.loadLoginAttempts();
}

test.beforeEach(resetAll);
test.after(() => {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
        // 清理失败不影响结论
    }
});

// ============ 密码强度 ============

test('密码长度边界：5 位拒绝、6 位接受、129 位拒绝', () => {
    assert.equal(auth.validatePasswordStrength('Ab1!x').valid, false);
    assert.equal(auth.validatePasswordStrength('Ab1!xy').valid, true);
    assert.equal(auth.validatePasswordStrength(`A1!${'a'.repeat(126)}`).valid, false);
});

test('密码必须包含至少两类字符', () => {
    const onlyLower = auth.validatePasswordStrength('abcdefgh');
    assert.equal(onlyLower.valid, false);
    assert.ok(onlyLower.errors.some(message => message.includes('至少两种')));

    assert.equal(auth.validatePasswordStrength('abcdefg1').valid, true);
    assert.equal(auth.validatePasswordStrength('ABCDEFG!').valid, true);
});

test('常见弱口令被明确拒绝（大小写不敏感）', () => {
    for (const weak of ['password', 'PASSWORD', '123456', 'Qwerty', 'abc123', '111111']) {
        const result = auth.validatePasswordStrength(weak);
        assert.equal(result.valid, false, `${weak} 不该通过`);
    }
});

test('强密码只返回 valid:true 且没有错误项', () => {
    const result = auth.validatePasswordStrength('Zx9#kLm2');
    assert.deepEqual(result, { valid: true, errors: [] });
});

// ============ 哈希与校验 ============

test('哈希结果形如 salt:hash，且每次盐不同', () => {
    const first = auth.hashPassword('Zx9#kLm2');
    const second = auth.hashPassword('Zx9#kLm2');
    assert.match(first, /^[0-9a-f]{64}:[0-9a-f]{128}$/);
    assert.notEqual(first, second, '每次都要有新盐');
});

test('哈希后可校验通过，错密码与串改哈希都不通过', () => {
    const stored = auth.hashPassword('Zx9#kLm2');
    assert.equal(auth.verifyPassword('Zx9#kLm2', stored), true);
    assert.equal(auth.verifyPassword('Zx9#kLm3', stored), false);
    assert.equal(auth.verifyPassword('Zx9#kLm2', `${stored.slice(0, -1)}0`), false);
});

test('兼容老的 sha256 格式（无盐），并标记为需要重新哈希', () => {
    const legacy = crypto.createHash('sha256').update('Zx9#kLm2').digest('hex');
    assert.equal(auth.verifyPassword('Zx9#kLm2', legacy), true);
    assert.equal(auth.verifyPassword('wrong', legacy), false);
    assert.equal(auth.needsRehash(legacy), true);
    assert.equal(auth.needsRehash(auth.hashPassword('Zx9#kLm2')), false);
});

// ============ 管理员失败锁定 ============

test('失败 4 次不锁，第 5 次锁定 15 分钟', () => {
    for (let index = 1; index <= 4; index += 1) {
        const result = auth.recordFailedAttempt();
        assert.equal(result.locked, false, `第 ${index} 次不该锁`);
        assert.equal(result.remainingAttempts, 5 - index);
    }

    const fifth = auth.recordFailedAttempt();
    assert.equal(fifth.locked, true);
    assert.ok(fifth.message.includes('15'));

    const lockout = auth.checkAdminLockout();
    assert.equal(lockout.locked, true);
    assert.ok(lockout.remainingMs > 14 * 60 * 1000 && lockout.remainingMs <= 15 * 60 * 1000);
});

test('登录成功后清空失败计数，后续不会被历史失败拖累', () => {
    for (let index = 0; index < 4; index += 1) auth.recordFailedAttempt();
    assert.equal(auth.checkAdminLockout().locked, false);

    auth.clearFailedAttempts();

    const after = auth.recordFailedAttempt();
    assert.equal(after.locked, false);
    assert.equal(after.remainingAttempts, 4, '清空后应重新从 1 开始计数');
});

test('锁定时间已过期时自动解锁', () => {
    writeAttempts({
        admin: { count: 5, firstAttempt: 1, lastAttempt: 1, lockedUntil: Date.now() - 1000 },
    });
    assert.equal(auth.checkAdminLockout().locked, false);
});

test('锁定记录会落盘，重新加载后仍然锁定', () => {
    for (let index = 0; index < 5; index += 1) auth.recordFailedAttempt();
    const persisted = readAttempts();
    assert.equal(persisted.admin.count, 5);
    assert.ok(persisted.admin.lockedUntil > Date.now());

    auth.loadLoginAttempts();
    assert.equal(auth.checkAdminLockout().locked, true, '重启进程后锁定必须仍然有效');
});

// ============ IP 限流 ============

test('同一 IP 前 10 次放行，第 11 次被限流', () => {
    for (let index = 1; index <= 10; index += 1) {
        assert.equal(auth.checkRateLimit('1.2.3.4').allowed, true, `第 ${index} 次应放行`);
    }
    const blocked = auth.checkRateLimit('1.2.3.4');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.message.includes('秒'));
    assert.ok(blocked.remainingMs > 0);
});

test('不同 IP 各自计数，互不影响', () => {
    for (let index = 0; index < 10; index += 1) auth.checkRateLimit('1.1.1.1');
    assert.equal(auth.checkRateLimit('1.1.1.1').allowed, false);
    assert.equal(auth.checkRateLimit('2.2.2.2').allowed, true);
});

test('统计窗口过期后计数清零', () => {
    writeAttempts({
        'ip:9.9.9.9': { count: 10, windowStart: Date.now() - 61 * 1000 },
    });
    const result = auth.checkRateLimit('9.9.9.9');
    assert.equal(result.allowed, true, '窗口过期应重新计数');
    assert.equal(readAttempts()['ip:9.9.9.9'].count, 1);
});

// ============ 记录文件加载的健壮性 ============

test('加载时只认 admin 与 ip: 前缀，写坏的记录伪造不出锁定', () => {
    writeAttempts({
        admin: { count: 1 },
        'ip:1.1.1.1': { count: 2, windowStart: Date.now() },
        // 伪造一个十年锁定：键名不符合 admin / ip: 约定，必须被忽略。
        'user:someone': { count: 99, lockedUntil: Date.now() + 10 * 365 * 24 * 3600 * 1000 },
        'garbage-key': { count: 5, lockedUntil: Date.now() + 10 * 365 * 24 * 3600 * 1000 },
        // 值不是对象，同样忽略；下次限流应当当成全新 IP。
        'ip:bad': 'not-an-object',
    });

    assert.equal(auth.checkAdminLockout().locked, false, '伪造的十年锁定不能生效');
    const fresh = auth.checkRateLimit('bad');
    assert.equal(fresh.allowed, true);
    assert.equal(readAttempts()['ip:bad'].count, 1, '非对象记录要被当作不存在，重新计数');
});

test('老版本 user:admin 键会被迁移成 admin', () => {
    writeAttempts({
        'user:admin': { count: 5, firstAttempt: 1, lockedUntil: Date.now() + 60 * 1000 },
    });
    assert.equal(auth.checkAdminLockout().locked, true, '老键位里的锁定状态不能丢');
});

test('记录文件损坏时回落到空状态，而不是崩在启动', () => {
    fs.writeFileSync(attemptsFile, '{ 这不是 JSON', 'utf8');
    auth.loadLoginAttempts();
    assert.equal(auth.checkAdminLockout().locked, false);
    assert.equal(auth.checkRateLimit('3.3.3.3').allowed, true);
});
