const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseLogLimit, logTimestamp, mergeLogLists, LOG_LIMIT_DEFAULT, LOG_LIMIT_MAX } = require('../dist/services/log-query');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.resolve(ROOT, file), 'utf8');

const log = (ts, msg) => ({ ts, msg, tag: '农场', meta: { module: 'farm' } });

test('limit 收敛到 1~1000，负数 / 超大值不再透传给下游', () => {
    assert.equal(parseLogLimit(undefined), LOG_LIMIT_DEFAULT);
    assert.equal(parseLogLimit(''), LOG_LIMIT_DEFAULT);
    assert.equal(parseLogLimit('abc'), LOG_LIMIT_DEFAULT);
    // -5 在下游 slice(-5) 里会变成「取尾部 5 条」，语义完全跑偏
    assert.equal(parseLogLimit('-5'), 1);
    assert.equal(parseLogLimit('1e9'), 1, 'parseInt("1e9") 是 1，这里只保证不放大');
    assert.equal(parseLogLimit('999999999'), LOG_LIMIT_MAX);
    assert.equal(parseLogLimit('300'), 300);
});

test('时间戳同时认数值 ts 与账号日志的格式化文本', () => {
    assert.equal(logTimestamp({ ts: 1700000000000 }), 1700000000000);
    assert.equal(logTimestamp({ timestamp: 1700000000000 }), 1700000000000);
    const parsed = logTimestamp({ time: '2026-11-13 09:10:26' });
    assert.ok(Number.isFinite(parsed) && parsed > 0, '账号日志只有 time 文本，必须能解析');
    assert.equal(parsed, Date.parse('2026-11-13T09:10:26'));
    assert.equal(logTimestamp({}), 0);
    assert.equal(logTimestamp(null), 0);
});

test('多账号日志按时间合并，截断保留最新而不是第一个账号的旧记录', () => {
    const first = [log(1000, 'a-1'), log(2000, 'a-2'), log(3000, 'a-3')];
    const second = [log(4000, 'b-1'), log(5000, 'b-2')];
    const merged = mergeLogLists([first, second], 3);
    assert.deepEqual(merged.map(item => item.msg), ['a-3', 'b-1', 'b-2'], '必须取全局最新的 3 条，且保持旧→新');
});

test('旧实现的时间比较是空操作，新实现真的排序', () => {
    // 这是被修掉的原始写法：运行日志没有 time 字段，比较结果恒为 0
    const legacySort = (a, b) => (b.time || 0) - (a.time || 0);
    assert.equal(legacySort(log(3000), log(1000)), 0, '旧比较器对运行日志恒为 0，sort 等于没做');
    const merged = mergeLogLists([[log(3000, 'new'), log(1000, 'old')]], 10);
    assert.deepEqual(merged.map(item => item.msg), ['old', 'new']);
});

test('混合来源（运行日志 ts + 账号日志 time）也能排到一起', () => {
    const runtime = [{ ts: Date.parse('2026-11-13T09:00:00'), msg: 'runtime' }];
    const account = [{ time: '2026-11-13 09:05:00', msg: 'account' }];
    assert.deepEqual(mergeLogLists([runtime, account], 10).map(item => item.msg), ['runtime', 'account']);
});

test('空列表与非数组输入安全兜底', () => {
    assert.deepEqual(mergeLogLists([], 100), []);
    assert.deepEqual(mergeLogLists(null, 100), []);
    assert.deepEqual(mergeLogLists([[], undefined, 'oops'], 100), []);
});

test('路由改用统一口径：limit 走 parseLogLimit，合并走 mergeLogLists', () => {
    const source = read('src/controllers/admin/account-routes.ts');
    assert.match(source, /const \{ parseLogLimit, mergeLogLists \} = require\('\.\.\/\.\.\/services\/log-query'\)/);
    assert.doesNotMatch(source, /Number\.parseInt\(req\.query\.limit as string\) \|\| 100/, '旧的无限界解析必须全部替换');
    const logsRoute = source.slice(source.indexOf("app.get('/api/logs'"), source.indexOf("app.delete('/api/logs'"));
    assert.match(logsRoute, /mergeLogLists\(perAccountLogs, options\.limit\)/);
    assert.doesNotMatch(logsRoute, /\.sort\(\(a: any, b: any\) => \(b\.time \|\| 0\)/, '旧比较器对运行日志恒为 0');
    assert.doesNotMatch(logsRoute, /allLogs\.slice\(0, options\.limit\)/, '升序数组取 slice(0) 会留下最旧的日志');
});
