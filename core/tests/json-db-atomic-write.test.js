/**
 * 原子写盘：rename 的瞬时占用重试。
 *
 * 这是从一次**偶发失败的测试**追出来的真问题。`core/tests/email-daily-persistence.test.js`
 * 里有一条会偶尔红：重启后读不到当天 `result: 'error'`。最初以为是测试不稳定，
 * 单独跑 6 次全绿，只有跑全量（大量子进程、机器负载高）才偶发——这才去查写入路径。
 *
 * 实测（本机 Windows）：只要目标文件被另一个进程持有读句柄，`fs.renameSync` 覆盖它
 * 就 **200/200 稳定报 EPERM**，放开句柄后 200/200 成功。真实世界里杀毒软件、
 * Everything、OneDrive/坚果云同步、编辑器都会短暂持有句柄，
 * 于是「刚改完的设置重启后没了」「当日统计丢了」这类问题会偶发出现且无法复现。
 *
 * 修法是只对 EPERM / EACCES / EBUSY 做有限次退避重试；其他错误（磁盘满、路径不存在）
 * 必须立刻抛出，不能被重试掩盖。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const jsonDb = require('../dist/services/json-db');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-atomic-'));
}

test('正常情况直接成功，内容可读回', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'a.json');
        jsonDb.writeJsonFileAtomic(file, { hello: 'world' });
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hello: 'world' });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
});

test('EPERM 会被重试，占用消失后写入成功', () => {
    const dir = tempDir();
    const file = path.join(dir, 'b.json');
    jsonDb.writeJsonFileAtomic(file, { n: 0 });

    const realRename = fs.renameSync;
    let attempts = 0;
    // 前两次模拟「文件被占用」，第三次放行
    fs.renameSync = (from, to) => {
        attempts += 1;
        if (attempts <= 2) {
            const error = new Error('EPERM: operation not permitted, rename');
            error.code = 'EPERM';
            throw error;
        }
        return realRename(from, to);
    };
    try {
        jsonDb.writeJsonFileAtomic(file, { n: 1 });
    } finally {
        fs.renameSync = realRename;
    }

    assert.equal(attempts, 3, '应当重试到成功为止');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 1 });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('EBUSY 与 EACCES 同样重试', () => {
    const dir = tempDir();
    const file = path.join(dir, 'c.json');
    const realRename = fs.renameSync;

    for (const code of ['EBUSY', 'EACCES']) {
        let attempts = 0;
        fs.renameSync = (from, to) => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error(`${code}: busy`);
                error.code = code;
                throw error;
            }
            return realRename(from, to);
        };
        try {
            jsonDb.writeJsonFileAtomic(file, { code });
        } finally {
            fs.renameSync = realRename;
        }
        assert.equal(attempts, 2, `${code} 应当被重试`);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('不可重试的错误立刻抛出，不做退避等待', () => {
    const dir = tempDir();
    const file = path.join(dir, 'd.json');
    const realRename = fs.renameSync;
    let attempts = 0;

    fs.renameSync = () => {
        attempts += 1;
        const error = new Error('ENOSPC: no space left on device');
        error.code = 'ENOSPC';
        throw error;
    };
    try {
        const startedAt = Date.now();
        assert.throws(() => jsonDb.writeJsonFileAtomic(file, { n: 1 }), /ENOSPC/);
        const elapsed = Date.now() - startedAt;
        assert.equal(attempts, 1, '磁盘满重试也没用，必须只试一次');
        assert.ok(elapsed < 100, `不该为不可重试的错误等待，实际 ${elapsed}ms`);
    } finally {
        fs.renameSync = realRename;
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
});

test('重试耗尽后抛出最后一次错误，且不留下临时文件', () => {
    const dir = tempDir();
    const file = path.join(dir, 'e.json');
    const realRename = fs.renameSync;
    let attempts = 0;

    fs.renameSync = () => {
        attempts += 1;
        const error = new Error('EPERM: still locked');
        error.code = 'EPERM';
        throw error;
    };
    try {
        assert.throws(() => jsonDb.writeJsonFileAtomic(file, { n: 1 }), /still locked/);
        assert.ok(attempts > 1, '应当尝试过多次');
        const leftovers = fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
        assert.deepEqual(leftovers, [], '失败后必须清理临时文件，否则数据目录会被垃圾堆满');
    } finally {
        fs.renameSync = realRename;
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
});

test('真实占用场景：持有读句柄时写入会失败，放开后成功（验证异常路径本身是对的）', () => {
    const dir = tempDir();
    const file = path.join(dir, 'f.json');
    jsonDb.writeJsonFileAtomic(file, { n: 0 });

    const holder = fs.openSync(file, 'r');
    let failedWhileHeld = false;
    try {
        jsonDb.writeJsonFileAtomic(file, { n: 1 });
    } catch {
        failedWhileHeld = true;
    } finally {
        fs.closeSync(holder);
    }

    // 在 Windows 上持有句柄必然失败；在允许替换的平台（Linux）上会成功。
    // 这里只要求「不会挂死、不会写出半截文件」，两种情况都算通过。
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(content.n === 0 || content.n === 1, '文件必须是完整 JSON，不能是半截');
    if (failedWhileHeld) {
        // 放开句柄后应当能正常写
        jsonDb.writeJsonFileAtomic(file, { n: 2 });
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 2);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
