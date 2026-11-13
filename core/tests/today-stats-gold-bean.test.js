const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const statsFile = path.resolve(__dirname, '../dist/services/stats.js');
const statsSource = path.resolve(__dirname, '../src/services/stats.ts');
const runtimeSource = path.resolve(__dirname, '../src/runtime/runtime-state.ts');

// 每个用例一份独立的 stats 模块实例 + 独立数据目录，避免模块级状态互相污染。
function loadStats(dataDir) {
    const actualRequire = require('node:module').createRequire(statsFile);
    const box = { exports: {} };
    vm.runInNewContext(fs.readFileSync(statsFile, 'utf8'), {
        module: box,
        exports: box.exports,
        require: actualRequire,
        Date,
        setTimeout,
        clearTimeout,
        process: { env: { FARM_DATA_DIR: dataDir }, pid: 12345, uptime: () => 90000 },
        console: { warn: () => {}, log: () => {} },
    });
    return box.exports;
}

function makeDataDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-stats-gold-bean-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function state(gold, exp, coupon, goldBean) {
    return { gold, exp, coupon, goldBean };
}

function savedFile(dataDir, accountId) {
    return path.join(dataDir, 'stats', `${accountId}.json`);
}

function writeSaved(dataDir, accountId, payload) {
    fs.mkdirSync(path.dirname(savedFile(dataDir, accountId)), { recursive: true });
    fs.writeFileSync(savedFile(dataDir, accountId), JSON.stringify(payload), 'utf8');
}

test('金豆当日净值与金币/点券同口径：首次为 0，增加为正，消费为负', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30);
    api.resetSessionGains();

    const first = api.getStats({}, state(1000, 5000, 30, 800), true, {});
    assert.equal(first.status.goldBean, 800);
    assert.equal(first.sessionGoldBeanGained, 0, '当日首次看到余额，净增为 0');
    assert.equal(first.sessionGoldGained, 0);

    const gained = api.getStats({}, state(1120, 5100, 40, 920), true, {});
    assert.equal(gained.sessionGoldBeanGained, 120);
    assert.equal(gained.sessionGoldGained, 120);
    assert.equal(gained.sessionCouponGained, 10);
    assert.equal(gained.sessionExpGained, 100);

    const spent = api.getStats({}, state(900, 5100, 20, 700), true, {});
    assert.equal(spent.sessionGoldBeanGained, -100, '花掉金豆后必须显示负数，不能 clamp 到 0');
    assert.equal(spent.sessionGoldGained, -100);
    assert.equal(spent.sessionCouponGained, -10);

    const offline = api.getStats({}, state(1, 1, 1, 1), false, {});
    assert.equal(offline.sessionGoldBeanGained, -100, '掉线时不拿脏数据重算净值');
});

test('同日重启：金豆当日基线从存档恢复，跨浏览器/刷新数值一致', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30);
    api.getStats({}, state(1000, 5000, 30, 800), true, {});
    api.getStats({}, state(1000, 5000, 30, 950), true, {});
    api.saveStats();

    const saved = JSON.parse(fs.readFileSync(savedFile(dataDir, 'acc-1'), 'utf8'));
    assert.equal(saved.date, api.getTodayKey());
    assert.equal(saved.initialState.goldBean, 800, '存档里要带金豆当日基线');

    // 模拟重启：新模块实例，登录时余额已涨到 950。
    const restarted = loadStats(dataDir);
    restarted.initStatsWithPersistence('acc-1', 1000, 5000, 30);
    restarted.resetSessionGains();
    const after = restarted.getStats({}, state(1000, 5000, 30, 950), true, {});
    assert.equal(after.sessionGoldBeanGained, 150, '同日重启不从头算');
    const spent = restarted.getStats({}, state(1000, 5000, 30, 700), true, {});
    assert.equal(spent.sessionGoldBeanGained, -100, '恢复基线后仍可为负');
});

test('跨天：旧日期存档不沿用金豆基线，从当天首次观测重新起算', (t) => {
    const dataDir = makeDataDir(t);
    const today = loadStats(dataDir).getTodayKey();
    assert.notEqual(today, '2000-01-01');
    writeSaved(dataDir, 'acc-1', {
        date: '2000-01-01',
        operations: {},
        initialState: { gold: 100, exp: 100, coupon: 10, goldBean: 100 },
        savedAt: 1,
    });

    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30);
    const first = api.getStats({}, state(1000, 5000, 30, 600), true, {});
    assert.equal(first.sessionGoldBeanGained, 0, '不能把昨天的 100 当今天的基线');
    const next = api.getStats({}, state(1000, 5000, 30, 650), true, {});
    assert.equal(next.sessionGoldBeanGained, 50);
});

test('旧存档没有金豆基线段：保持首次观测，不能把 null 当 0 恢复', (t) => {
    const dataDir = makeDataDir(t);
    const seed = loadStats(dataDir);
    writeSaved(dataDir, 'acc-1', {
        date: seed.getTodayKey(),
        operations: {},
        initialState: { gold: 1000, exp: 5000, coupon: 30 },
        savedAt: 1,
    });

    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30);
    const first = api.getStats({}, state(1000, 5000, 30, 600), true, {});
    assert.equal(first.sessionGoldBeanGained, 0, 'Number(null) === 0，若误恢复会把 600 全算成今日净增');
    const next = api.getStats({}, state(1000, 5000, 30, 650), true, {});
    assert.equal(next.sessionGoldBeanGained, 50);
});

test('余额是非法值时金豆净值仍为有限数，不会渲染 NaN', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30);
    const bad = api.getStats({}, { gold: 1000, exp: 5000, coupon: 30, goldBean: 'abc' }, true, {});
    assert.equal(bad.sessionGoldBeanGained, 0);
    const missing = api.getStats({}, { gold: 1000, exp: 5000, coupon: 30 }, true, {});
    assert.equal(Number.isFinite(missing.sessionGoldBeanGained), true);
});

test('资产卡「本次运行」三项增量不受金豆接入影响', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30);
    const s = api.getStats({}, state(1200, 5300, 50, 900), true, {});
    assert.equal(s.sessionGoldBeanGained, 0);
    assert.equal(s.runGoldGained, 200);
    assert.equal(s.runExpGained, 300);
    assert.equal(s.runCouponGained, 20);
    assert.equal(s.runGoldBeanGained, undefined, '不新增资产卡金豆「本次运行」增量');
});

test('跨天与登录重置、未登录默认 status 都覆盖金豆字段', () => {
    const src = fs.readFileSync(statsSource, 'utf8');
    const dayReset = src.slice(src.indexOf('function checkAndResetDailyStats'), src.indexOf('function scheduleSave'));
    assert.match(dayReset, /initialState\.goldBean = null/);
    assert.match(dayReset, /session\.goldBeanGained = 0/);
    const loginReset = src.slice(src.indexOf('function resetSessionGains'), src.indexOf('function recomputeSessionTotals'));
    assert.match(loginReset, /session\.goldBeanGained = 0/);
    const runtime = fs.readFileSync(runtimeSource, 'utf8');
    assert.match(runtime, /sessionGoldBeanGained: 0/, '未登录默认 status 也要带该字段');
});

test('背包同步失败：首帧占位 0 不能钉死当日基线，余额刷成真实值后不虚高', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    // 第 5 个参数传 null = 登录时背包拉取失败，userState.goldBean 仍是初始占位 0。
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30, null);
    api.resetSessionGains();

    const placeholder = api.getStats({}, state(1000, 5000, 30, 0), true, {});
    assert.equal(placeholder.sessionGoldBeanGained, 0, '基线未就绪时净增显示 0，不能拿脏数据算');

    // ItemNotify 把余额刷成真实值：这一帧才确立基线，净增仍应是 0，而不是 +600。
    const synced = api.getStats({}, state(1000, 5000, 30, 600), true, {});
    assert.equal(synced.sessionGoldBeanGained, 0, '不能把全部余额算成今日净增');
    assert.equal(synced.status.goldBean, 600);

    const gained = api.getStats({}, state(1000, 5000, 30, 650), true, {});
    assert.equal(gained.sessionGoldBeanGained, 50, '确立基线后正常累计净值');
    const spent = api.getStats({}, state(1000, 5000, 30, 580), true, {});
    assert.equal(spent.sessionGoldBeanGained, -20, '确立基线后仍可为负');
});

test('基线未就绪时存档写 null 而不是 0，同日重启不会被脏基线污染', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30, null);
    api.getStats({}, state(1000, 5000, 30, 0), true, {});
    api.saveStats();

    const saved = JSON.parse(fs.readFileSync(savedFile(dataDir, 'acc-1'), 'utf8'));
    assert.equal(saved.initialState.goldBean, null, '未就绪的基线必须写成 null');

    const restarted = loadStats(dataDir);
    restarted.initStatsWithPersistence('acc-1', 1000, 5000, 30, null);
    const firstReal = restarted.getStats({}, state(1000, 5000, 30, 600), true, {});
    assert.equal(firstReal.sessionGoldBeanGained, 0, '重启后依然不能把 600 算成今日净增');
});

test('背包同步成功但余额真的是 0：0 是合法基线，当天获得金豆照常计正', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30, 0);
    api.resetSessionGains();

    const empty = api.getStats({}, state(1000, 5000, 30, 0), true, {});
    assert.equal(empty.sessionGoldBeanGained, 0);
    const gained = api.getStats({}, state(1000, 5000, 30, 600), true, {});
    assert.equal(gained.sessionGoldBeanGained, 600, '同步确认过的 0 是有效基线，之后的获得要计入');
});

test('背包同步成功直接传入余额作基线，无需等首次观测', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30, 800);
    api.resetSessionGains();
    const spent = api.getStats({}, state(1000, 5000, 30, 730), true, {});
    assert.equal(spent.sessionGoldBeanGained, -70, '登录基线生效后消费即为负');
    api.saveStats();
    const saved = JSON.parse(fs.readFileSync(savedFile(dataDir, 'acc-1'), 'utf8'));
    assert.equal(saved.initialState.goldBean, 800);
});

test('同日重启：金币/经验/点券基线为 null（跨天已清空）时也不恢复成 0', (t) => {
    const dataDir = makeDataDir(t);
    const seed = loadStats(dataDir);
    writeSaved(dataDir, 'acc-1', {
        date: seed.getTodayKey(),
        operations: {},
        initialState: { gold: null, exp: null, coupon: null, goldBean: null },
        savedAt: 1,
    });

    const api = loadStats(dataDir);
    api.initStatsWithPersistence('acc-1', 1000, 5000, 30);
    const first = api.getStats({}, state(1000, 5000, 30, 800), true, {});
    // Number(null) === 0 会通过 `>= 0` 检查，若误恢复会把整个账户余额算成今日净增。
    assert.equal(first.sessionGoldGained, 0, 'null 基线不能被当成 0');
    assert.equal(first.sessionExpGained, 0);
    assert.equal(first.sessionCouponGained, 0);

    const next = api.getStats({}, state(1120, 5100, 40, 850), true, {});
    assert.equal(next.sessionGoldGained, 120);
    assert.equal(next.sessionExpGained, 100);
    assert.equal(next.sessionCouponGained, 10);
});

test('部分基线缺失时逐字段补齐，不覆盖已有的当日基线', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    // 登录回包只拿到金币，经验缺失（null = 未知）
    api.initStatsWithPersistence('acc-1', 1000, null, 0);
    api.resetSessionGains();

    const stats = api.getStats({}, state(1200, 5000, 0, 0), true, {});
    assert.equal(stats.sessionGoldGained, 200, '已知的金币基线必须保留，不能被当前余额覆盖成 0 收益');
    assert.equal(stats.sessionExpGained, 0, '缺失的经验基线用首次观测补齐，当日净值从 0 起算');
});

test('登录时余额未知（缺字段）不把整个账户余额算成今日净增', (t) => {
    const dataDir = makeDataDir(t);
    const api = loadStats(dataDir);
    // 登录回包缺 gold/exp/coupon：传 null 表示「未知」，不能当 0
    api.initStatsWithPersistence('acc-1', null, null, null);
    api.resetSessionGains();

    const first = api.getStats({}, state(99999, 12345, 7, 0), true, {});
    assert.equal(first.sessionGoldGained, 0, '首次观测只起算，不算收益');
    assert.equal(first.sessionExpGained, 0);
    assert.equal(first.runGoldGained, 0, '本次运行增量同样从首次观测起算，不能凭空等于全部余额');

    const later = api.getStats({}, state(100099, 12345, 7, 0), true, {});
    assert.equal(later.sessionGoldGained, 100);
    assert.equal(later.runGoldGained, 100);
});

test('跨日落盘用计数的归属日，而不是落盘那一刻的日期', () => {
    // 23:59:5x 记下最后一次操作、00:00:0x 才落盘时，旧写法会把昨天全天计数写成「今天」的数，
    // 同日重启就按 saved.date === todayKey 把昨天累计当今天恢复。这条断言锁住归属日来源。
    const src = fs.readFileSync(statsSource, 'utf8');
    const doSave = src.slice(src.indexOf('function doSave('), src.indexOf('function initStats('));
    assert.match(doSave, /checkAndResetDailyStats\(\)/, '落盘前必须先做跨日检查');
    assert.match(doSave, /const dateKey: string = currentDateKey \|\| getTodayKey\(\)/, '日期键必须取归属日');
    assert.doesNotMatch(doSave, /date: getTodayKey\(\)/, '不能在落盘时重新取当时日期');
});

test('服务器时间回退不重置当日统计', () => {
    const src = fs.readFileSync(statsSource, 'utf8');
    const reset = src.slice(src.indexOf('function checkAndResetDailyStats('), src.indexOf('function scheduleSave('));
    assert.match(reset, /if \(todayKey < currentDateKey\) \{/, '日期键回退必须单独处理');
    assert.match(reset, /忽略本次重置/, '回退时只告警，清数据会把当天累计清零');
});
