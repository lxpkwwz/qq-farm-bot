/**
 * 配置参数边界闸门。
 *
 * 为什么单独一组：前几轮复查反复捞同一批缺陷，根因是「只修实例、不建闸门」。
 * 这一组不再盯某个具体 BUG，而是把两类结构性约束钉死：
 *
 *   1. 任何数值配置经过归一化之后，必须是**有限**的，并且落在声明的区间里；
 *   2. 任何进入 setTimeout / setInterval 的延时，必须落在 32 位有符号整数内。
 *
 * 第 2 条不是洁癖：Node 对超过 2147483647 的延时会打 TimeoutOverflowWarning 并把
 * 延时**改成 1ms**，原本「等一天」的任务立刻变成 1ms 空转热循环，CPU 打满且不报错。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sharedState = require('../dist/models/store/shared-state');
const { MAX_TIMER_DELAY_MS, createScheduler } = require('../dist/services/scheduler');
const { DEFAULT_ADMIN_PORT, resolveAdminPort } = require('../dist/config/config');

/**
 * 极端输入集合：NaN / 正负 Infinity / 超大整数 / 数字字符串 / 空串 / 非数字 / 对象 / 数组 / 小数。
 * `Infinity` 在 JSON 里写 `1e400` 就能得到，属于外部真的能送进来的值，不能只在代码里防。
 */
const EXTREME_VALUES = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    0,
    -0.5,
    1.5,
    1e15,
    '1e15',
    '  ',
    'abc',
    null,
    undefined,
    {},
    [],
    Number.MAX_SAFE_INTEGER,
];

const INTERVAL_KEYS = ['farm', 'farmMin', 'farmMax', 'friendMin', 'friendMax', 'helpMin', 'helpMax', 'stealMin', 'stealMax'];

function assertBoundedIntervals(intervals, label) {
    for (const key of INTERVAL_KEYS) {
        const sec = intervals[key];
        assert.ok(Number.isFinite(sec), `${label}.${key} 必须是有限数，实际 ${sec}`);
        assert.equal(sec, Math.trunc(sec), `${label}.${key} 必须是整数秒，实际 ${sec}`);
        assert.ok(sec >= 1, `${label}.${key} 不得小于 1 秒，实际 ${sec}`);
        assert.ok(
            sec <= sharedState.INTERVAL_MAX_SEC,
            `${label}.${key} 不得大于 ${sharedState.INTERVAL_MAX_SEC} 秒，实际 ${sec}`,
        );
    }
}

test('巡查 / 好友间隔在所有归一化入口都被夹到 1~INTERVAL_MAX_SEC', () => {
    for (const value of EXTREME_VALUES) {
        const raw = Object.fromEntries(INTERVAL_KEYS.map(key => [key, value]));
        assertBoundedIntervals(sharedState.normalizeIntervals(raw), `normalizeIntervals(${String(value)})`);
        assertBoundedIntervals(
            sharedState.normalizeAccountConfig({ intervals: raw }).intervals,
            `normalizeAccountConfig(${String(value)})`,
        );
    }
});

test('回归：1e15 秒不再原样透传（曾一路 *1000 变成 1e18 毫秒交给 setTimeout）', () => {
    const intervals = sharedState.normalizeIntervals({ farm: 1e15, farmMin: 1e15, farmMax: 1e15 });
    assert.equal(intervals.farm, sharedState.INTERVAL_MAX_SEC);
    assert.equal(intervals.farmMin, sharedState.INTERVAL_MAX_SEC);
    assert.equal(intervals.farmMax, sharedState.INTERVAL_MAX_SEC);

    const account = sharedState.normalizeAccountConfig({ intervals: { farm: 1e15 } });
    assert.equal(account.intervals.farm, sharedState.INTERVAL_MAX_SEC);
});

test('间隔上限乘以 1000 必须仍在 32 位定时器范围内', () => {
    // 这条不变量把「秒级配置上限」和「毫秒级定时器上限」绑在一起：
    // 任何一边被调大而另一边没跟上，这里立刻红。
    assert.ok(
        sharedState.INTERVAL_MAX_SEC * 1000 <= MAX_TIMER_DELAY_MS,
        `${sharedState.INTERVAL_MAX_SEC}s 换成毫秒会超出定时器上限 ${MAX_TIMER_DELAY_MS}`,
    );
});

test('定时器延时超过 32 位上限时被截断，不会折成 1ms 热循环', () => {
    assert.equal(MAX_TIMER_DELAY_MS, 2_147_483_647);
    const scheduler = createScheduler('param-bounds');
    try {
        scheduler.setTimeoutTask('huge_timeout', 1e18, () => {});
        const timeoutTask = scheduler.getSnapshot().tasks.find(task => task.name === 'huge_timeout');
        assert.ok(timeoutTask, '任务应已注册');
        assert.ok(
            timeoutTask.delayMs <= MAX_TIMER_DELAY_MS,
            `timeout 延时必须被截断，实际 ${timeoutTask.delayMs}`,
        );

        scheduler.setIntervalTask('huge_interval', 1e18, () => {});
        const intervalTask = scheduler.getSnapshot().tasks.find(task => task.name === 'huge_interval');
        assert.ok(intervalTask, 'interval 任务应已注册');
        assert.ok(
            intervalTask.delayMs <= MAX_TIMER_DELAY_MS,
            `interval 延时必须被截断，实际 ${intervalTask.delayMs}`,
        );
    }
    finally {
        scheduler.clearAll();
    }
});

test('宠物资本模式参数拦得住 Infinity（否则「从不派狗」且界面无异常）', () => {
    for (const value of EXTREME_VALUES) {
        const config = sharedState.normalizeCapitalMode({ dogId: value, leadSeconds: value, enabled: true });
        assert.ok(Number.isFinite(config.dogId), `dogId 必须是有限数，实际 ${config.dogId}（输入 ${String(value)}）`);
        assert.ok(config.dogId >= 0, `dogId 不得为负，实际 ${config.dogId}`);
        assert.equal(config.dogId, Math.trunc(config.dogId), `dogId 必须是整数，实际 ${config.dogId}`);
        assert.ok(Number.isFinite(config.leadSeconds), `leadSeconds 必须是有限数，实际 ${config.leadSeconds}`);
        assert.ok(config.leadSeconds >= 5 && config.leadSeconds <= 300, `leadSeconds 越界：${config.leadSeconds}`);
    }
});

test('管理端口非法时回落默认值，不会让 listen 抛 ERR_SOCKET_BAD_PORT', () => {
    for (const raw of [undefined, null, '', 'abc', '0', '-1', '65536', '70000', '1e9', '3007abc', Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(resolveAdminPort(raw), DEFAULT_ADMIN_PORT, `ADMIN_PORT=${String(raw)} 应回落到 ${DEFAULT_ADMIN_PORT}`);
    }
    for (const [raw, expected] of [[3007, 3007], ['8080', 8080], ['3007.9', 3007], [1, 1], [65535, 65535]]) {
        assert.equal(resolveAdminPort(raw), expected, `ADMIN_PORT=${String(raw)} 应解析为 ${expected}`);
    }
});

test('worker 的秒级上限与 store 常量保持一致（防两边漂移）', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/core/worker.ts'), 'utf8');
    const declared = source.match(/const MAX_INTERVAL_SEC = (\d+);/);
    assert.ok(declared, 'worker.ts 必须保留 MAX_INTERVAL_SEC 定义');
    assert.equal(
        Number(declared[1]),
        sharedState.INTERVAL_MAX_SEC,
        'worker 的 MAX_INTERVAL_SEC 必须与 shared-state 的 INTERVAL_MAX_SEC 相同',
    );
    assert.match(source, /Math\.min\(MAX_INTERVAL_SEC/, 'normalizeIntervalRangeSec 必须实际使用上限');
});

test('「Infinity 当合法数字放行」的写法不得回潮', () => {
    const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

    // 这几个写法都把 Infinity 当合法值：Math.max 不改变它，`|| 0` 也不会命中。
    const forbidden = [
        { file: 'src/models/store/shared-state.ts', pattern: /dogId:\s*Math\.max\(0,\s*Number\(/ },
        { file: 'src/controllers/admin/farm-routes.ts', pattern: /Math\.max\(0,\s*Number\(req\.body\?\.(?:uid|dogId)\)\s*\|\|\s*0\)/ },
        { file: 'src/controllers/admin/farm-routes.ts', pattern: /Math\.max\(1,\s*Math\.trunc\(Number\(req\.body\?\.count\)\s*\|\|\s*1\)\)/ },
    ];
    for (const { file, pattern } of forbidden) {
        assert.doesNotMatch(read(file), pattern, `${file} 里出现了会放行 Infinity 的写法：${pattern}`);
    }
});
