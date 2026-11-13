const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    createPreflightStats,
    utc8Date,
    DEFAULT_FILE,
} = require('../dist/services/preflight-stats');
const { toPublicAccountsData, PRIVATE_CREDENTIAL_KEYS } = require('../dist/services/account-visibility');

const NOW = 1_800_000_000_000; // 2027-01-15 08:53:20 UTC → 北京时间 16:53
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** 纯内存读写，测试完全不碰 core/data；返回写入历史便于断言原子写与内容。 */
function memoryStore(seed = null, now = NOW) {
    let file = seed;
    const writes = [];
    const store = createPreflightStats({
        filePath: '/virtual/preflight-stats.json',
        nowFn: () => now,
        readJson: () => file,
        writeJson: (_target, data) => {
            file = JSON.parse(JSON.stringify(data));
            writes.push(file);
        },
    });
    return { store, writes, read: () => file };
}

test('UTC+8 自然日换算与 governor 同口径；账本落在数据卷内', () => {
    // 2027-01-15 16:00 UTC = 北京时间 2027-01-16 00:00，应算次日
    assert.equal(utc8Date(Date.parse('2027-01-15T15:59:00Z')), '2027-01-15');
    assert.equal(utc8Date(Date.parse('2027-01-15T16:00:00Z')), '2027-01-16');
    assert.match(DEFAULT_FILE.replace(/\\/g, '/'), /core\/data\/preflight-stats\.json$/);
});

test('成功 / 失败分别累计：成功不增加失败次数，时间戳各自更新', () => {
    const { store, read } = memoryStore();
    store.recordSuccess('1', NOW);
    store.recordSuccess('1', NOW + HOUR);
    store.recordFailure('1', NOW + 2 * HOUR);
    const stats = store.get('1', NOW + 2 * HOUR);
    assert.deepEqual(stats, {
        date: utc8Date(NOW),
        lastSuccessAt: NOW + HOUR,
        lastFailureAt: NOW + 2 * HOUR,
        successesToday: 2,
        failuresToday: 1,
    });
    assert.equal(read().accounts['1'].successesToday, 2, '每次记录都原子落盘');
});

test('多账号互不串账；没记录过的账号返回全 0 而不是 undefined', () => {
    const { store } = memoryStore();
    store.recordFailure('a', NOW);
    store.recordSuccess('b', NOW + 1000);
    assert.equal(store.get('a', NOW).failuresToday, 1);
    assert.equal(store.get('b', NOW).successesToday, 1);
    assert.deepEqual(store.get('missing', NOW), {
        date: utc8Date(NOW),
        lastSuccessAt: 0,
        lastFailureAt: 0,
        successesToday: 0,
        failuresToday: 0,
    });
    assert.deepEqual(Object.keys(store.snapshot(NOW)).sort(), ['a', 'b']);
});

test('跨 UTC+8 自然日：当日次数归零，但上次成功 / 失败时间保留', () => {
    const { store } = memoryStore();
    store.recordSuccess('1', NOW);
    store.recordFailure('1', NOW + HOUR);
    const nextDay = NOW + DAY;
    const stats = store.get('1', nextDay);
    assert.equal(stats.date, utc8Date(nextDay));
    assert.equal(stats.successesToday, 0);
    assert.equal(stats.failuresToday, 0);
    assert.equal(stats.lastSuccessAt, NOW, '第二天仍能看到「上次自动续期是多久以前」');
    assert.equal(stats.lastFailureAt, NOW + HOUR);
    store.recordSuccess('1', nextDay);
    assert.equal(store.get('1', nextDay).successesToday, 1);
});

test('读取旧文件 / 脏数据：日期不同归零、负数与 NaN 收敛为 0', () => {
    const { store } = memoryStore({
        date: '2020-01-01',
        accounts: {
            '1': { lastSuccessAt: NOW - HOUR, lastFailureAt: -5, successesToday: 99, failuresToday: 'oops' },
            '2': null,
            '3': { lastSuccessAt: Number.NaN, successesToday: -3 },
        },
    });
    assert.equal(store.get('1', NOW).successesToday, 0, '旧日期的当日计数不继承');
    assert.equal(store.get('1', NOW).lastSuccessAt, NOW - HOUR, '历史时间保留');
    assert.equal(store.get('1', NOW).lastFailureAt, 0);
    assert.equal(store.get('2', NOW).failuresToday, 0);
    assert.equal(store.get('3', NOW).successesToday, 0);
});

test('账本读写抛错时不影响续期主流程；恢复后可继续记录', () => {
    let broken = true;
    const store = createPreflightStats({
        filePath: '/virtual/broken.json',
        nowFn: () => NOW,
        readJson: () => { if (broken) throw new Error('EACCES'); return null; },
        writeJson: () => { if (broken) throw new Error('ENOSPC'); },
    });
    assert.doesNotThrow(() => store.recordSuccess('1', NOW));
    assert.equal(store.get('1', NOW).successesToday, 1, '内存态仍然正确');
    broken = false;
    assert.doesNotThrow(() => store.recordFailure('1', NOW + HOUR));
    assert.equal(store.get('1', NOW + HOUR).failuresToday, 1);
});

test('重置后重新从文件加载，模拟容器重启后账本不丢', () => {
    const { store, read } = memoryStore();
    store.recordSuccess('1', NOW);
    const persisted = read();
    const restarted = createPreflightStats({
        filePath: '/virtual/preflight-stats.json',
        nowFn: () => NOW + HOUR,
        readJson: () => persisted,
        writeJson: () => {},
    });
    assert.equal(restarted.get('1', NOW + HOUR).successesToday, 1);
    assert.equal(restarted.get('1', NOW + HOUR).lastSuccessAt, NOW);
});

test('账本只含时间戳与次数，绝不写入任何凭证明文', () => {
    const { store, read } = memoryStore();
    store.recordSuccess('1', NOW);
    store.recordFailure('1', NOW + HOUR);
    const serialized = JSON.stringify(read());
    for (const key of ['refreshtoken', 'accesstoken', 'loginBuffer', 'code', 'wxid', 'token']) {
        assert.equal(new RegExp(`"${key}"`).test(serialized), false, `账本不应出现 ${key}`);
    }
});

test('账号列表投影：微信账号附带账本，QQ 不下发，凭证明文仍被剥离', () => {
    const canPreflight = account => String(account?.platform || '') === 'wx'
        && !!String(account?.wxid || '').trim()
        && !!String(account?.refreshtoken || '').trim();
    const data = {
        accounts: [
            { id: '1', name: '微信一号', platform: 'wx', wxid: 'openid', refreshtoken: 'rt', accesstoken: 'at', loginBuffer: 'lb' },
            { id: '2', name: '微信二号', platform: 'wx', refreshtoken: '' },
            { id: '3', name: 'QQ', platform: 'qq', refreshtoken: 'rt' },
        ],
        nextId: 4,
    };
    const snapshot = { '1': { date: utc8Date(NOW), lastSuccessAt: NOW, lastFailureAt: 0, successesToday: 12, failuresToday: 0 } };
    const result = toPublicAccountsData(data, canPreflight, snapshot);
    assert.equal(result.accounts[0].wxPreflightStats.successesToday, 12);
    assert.equal(result.accounts[0].wxPreflightStats.lastSuccessAt, NOW);
    assert.equal(result.accounts[1].wxPreflightStats.successesToday, 0, '字段存在但全 0 = 新服务暂无记录');
    assert.equal('wxPreflightStats' in result.accounts[2], false, 'QQ 账号不渲染这个标记');
    for (const item of result.accounts) {
        for (const key of PRIVATE_CREDENTIAL_KEYS) assert.equal(key in item, false);
    }
});

test('接线断言：保活只给自动路径记账，runtime-engine 注入账本，路由读取快照', () => {
    const src = path.join(__dirname, '..', 'src');
    const keepAlive = fs.readFileSync(path.join(src, 'services/wx-keepalive.ts'), 'utf8');
    const engine = fs.readFileSync(path.join(src, 'runtime/runtime-engine.ts'), 'utf8');
    const routes = fs.readFileSync(path.join(src, 'controllers/admin/account-routes.ts'), 'utf8');
    assert.match(keepAlive, /recordAutomaticResult\(key, reason, true, now\)/);
    assert.match(keepAlive, /recordAutomaticResult\(key, reason, false, now\)/);
    assert.match(keepAlive, /if \(reason === 'manual'.*return/, '手动续期不计入无人值守账本');
    assert.match(keepAlive, /try \{[\s\S]{0,220}deps\.recordPreflightResult/, '记账异常必须被兜住');
    assert.match(engine, /recordPreflightResult: \(accountId: string, ok: boolean, at: number\)/);
    assert.match(engine, /recordAutoRefreshSuccess\(accountId, at\)/);
    assert.match(engine, /recordAutoRefreshFailure\(accountId, at\)/);
    assert.match(routes, /getPreflightStatsSnapshot\(\)/);
});

test('账本文件损坏时先留档再重建，不能用空表覆盖唯一副本', (t) => {
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-preflight-corrupt-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'preflight-stats.json');
    const original = '{ 这不是合法 JSON';
    fs.writeFileSync(filePath, original, 'utf8');

    const store = createPreflightStats({
        filePath,
        nowFn: () => NOW,
        // 故意不注入 readJson：走默认的 strict 读取，模拟真实读盘路径
        writeJson: () => {},
    });
    store.recordSuccess('acc-1', NOW);

    const backups = fs.readdirSync(dir).filter(name => name.includes('.corrupt-'));
    assert.equal(backups.length, 1, '损坏文件必须留档，否则后续 persist 会把唯一副本覆盖成空表');
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original, '留档内容必须是原文件');
});
