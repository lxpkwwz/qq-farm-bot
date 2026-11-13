/**
 * 活动时间窗口缓存。
 *
 * 自动出售判断「活动是否结束」全靠这份缓存，而它是**带 TTL 的本地缓存**：
 * 拿不到时不能抛错打断出售流程，但也不能假装「已经加载过」——`activityWindowsLoaded`
 * 为 false 时下游会一律判「不满足条件」，也就是宁可不卖。这条区分错了，
 * 要么卖掉本该留着的果实，要么永远卖不出去，两种情况都不报错。
 *
 * 另外两个容易漏的点：
 *   1. 并发去重：同一时刻多个调用只能发一次请求，否则活动列表会被反复拉取；
 *   2. 刷新失败时若已有旧缓存，要继续用旧的（返回 stale），而不是把缓存清空。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

// ============ 依赖注入 ============

let nextWindows = [];
let requestCount = 0;
let requestError = null;
let inFlightResolvers = [];

class FakeEvents {
    constructor() {
        this.handlers = new Map();
    }

    on(name, handler) {
        const list = this.handlers.get(name) || [];
        list.push(handler);
        this.handlers.set(name, list);
    }

    emit(name) {
        for (const handler of this.handlers.get(name) || []) handler();
    }
}

const networkEvents = new FakeEvents();

require.cache[require.resolve('../dist/utils/network')] = {
    exports: {
        networkEvents,
        sendMsgAsync: async () => {
            requestCount += 1;
            if (requestError) throw requestError;
            // 允许测试挂起请求，用来验证并发去重
            if (inFlightResolvers.length > 0) {
                await new Promise(resolve => inFlightResolvers.push(resolve));
            }
            return { body: Buffer.from(JSON.stringify({ windows: nextWindows })) };
        },
    },
};

const logWarns = [];
const utilsPath = require.resolve('../dist/utils/utils');
const realUtils = require('../dist/utils/utils');
require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        getServerTimeSec: () => 1_700_000_000,
        logWarn: message => logWarns.push(message),
    },
};

require.cache[require.resolve('../dist/utils/proto')] = {
    exports: {
        types: {
            ActivityListRequest: {
                create: value => value,
                encode: () => ({ finish: () => Buffer.alloc(0) }),
            },
            ActivityListReply: {
                decode: body => ({ activity_windows: JSON.parse(body.toString()).windows }),
            },
        },
    },
};

const MODULE_PATH = require.resolve('../dist/services/activity-windows');

/** 每个用例都用全新的模块实例，避免模块级缓存互相污染。 */
function load() {
    delete require.cache[MODULE_PATH];
    return require('../dist/services/activity-windows');
}

function reset() {
    nextWindows = [];
    requestCount = 0;
    requestError = null;
    inFlightResolvers = [];
    logWarns.length = 0;
}

test.beforeEach(reset);

// ============ 解码与缓存 ============

test('刷新后能读到窗口，字段按 id 建索引并保留名称与起止时间', async () => {
    const aw = load();
    nextWindows = [
        { id: 7, name: '秋日', begin_time: 100, end_time: 200 },
        { id: 9, name: '冬雪', begin_time: 300, end_time: 400 },
    ];

    await aw.refreshActivityWindows();

    const windows = await aw.getActivityWindows();
    assert.deepEqual(windows.map(row => row.id).sort(), ['7', '9']);
    const autumn = windows.find(row => row.id === '7');
    assert.equal(autumn.name, '秋日');
    assert.equal(autumn.beginTime, 100);
    assert.equal(autumn.endTime, 200);
});

test('没有 id 的窗口行被跳过', async () => {
    const aw = load();
    nextWindows = [{ id: 0 }, { name: '缺 id' }, { id: 5, name: '正常', begin_time: 1, end_time: 2 }];

    await aw.refreshActivityWindows();

    const windows = await aw.getActivityWindows();
    assert.deepEqual(windows.map(row => row.id), ['5']);
});

test('回包没有任何窗口时抛错，且不把「已加载」标记打开', async () => {
    const aw = load();
    nextWindows = [];

    await assert.rejects(() => aw.refreshActivityWindows(), /活动列表回包未包含时间配置/);
    assert.equal(aw.getActivityWindowCache().loaded, false, '空回包不能算加载成功');
});

test('返回的是副本，改它不会污染缓存', async () => {
    const aw = load();
    nextWindows = [{ id: 1, name: '原值', begin_time: 10, end_time: 20 }];
    await aw.refreshActivityWindows();

    const first = await aw.getActivityWindows();
    first[0].name = '被改过';

    const second = await aw.getActivityWindows();
    assert.equal(second[0].name, '原值');
});

// ============ TTL 与失效 ============

test('缓存新鲜期内不重复请求', async () => {
    const aw = load();
    nextWindows = [{ id: 1, begin_time: 10, end_time: 20 }];

    await aw.getActivityWindows();
    const afterFirst = requestCount;
    await aw.getActivityWindows();

    assert.equal(requestCount, afterFirst, 'TTL 内不该再发请求');
});

test('失效后下一次调用会重新拉取，且 loaded 立刻变回 false', async () => {
    const aw = load();
    nextWindows = [{ id: 1, begin_time: 10, end_time: 20 }];
    await aw.getActivityWindows();
    assert.equal(aw.getActivityWindowCache().loaded, true);

    aw.invalidateActivityWindows();
    assert.equal(aw.getActivityWindowCache().loaded, false, '失效后不能还自称已加载');

    await aw.getActivityWindows();
    assert.equal(requestCount, 2);
});

test('网络事件 activitiesChanged 与 disconnected 都会让缓存失效', async () => {
    for (const eventName of ['activitiesChanged', 'disconnected']) {
        reset();
        const aw = load();
        nextWindows = [{ id: 1, begin_time: 10, end_time: 20 }];
        await aw.getActivityWindows();
        assert.equal(aw.getActivityWindowCache().loaded, true);

        networkEvents.emit(eventName);

        assert.equal(aw.getActivityWindowCache().loaded, false, `${eventName} 之后缓存应失效`);
    }
});

// ============ 失败时的降级 ============

test('刷新失败但已有旧缓存时继续用旧的，不抛错', async () => {
    const aw = load();
    nextWindows = [{ id: 1, name: '旧值', begin_time: 10, end_time: 20 }];
    await aw.getActivityWindows();

    aw.invalidateActivityWindows();
    requestError = new Error('网关超时');

    const windows = await aw.getActivityWindows();
    assert.equal(windows.length, 1, '旧缓存要继续可用');
    assert.equal(windows[0].name, '旧值');
    assert.equal(aw.getActivityWindowCache().loaded, false, '但不能再自称已加载');
});

test('刷新失败且从未加载过时，getActivityWindows 把错误抛出去', async () => {
    const aw = load();
    requestError = new Error('网关超时');

    await assert.rejects(() => aw.getActivityWindows(), /网关超时/);
});

test('出售条件上下文在失败时返回已加载=false，并限速记录 warning', async () => {
    const aw = load();
    requestError = new Error('网关超时');

    const first = await aw.getSellConditionContext();
    assert.equal(first.activityWindowsLoaded, false, '拿不到就必须让下游按「不满足条件」处理');
    assert.equal(first.nowSec, 1_700_000_000);
    assert.equal(logWarns.length, 1);

    // 同一分钟内再失败不应重复打日志
    await aw.getSellConditionContext();
    assert.equal(logWarns.length, 1, '重试日志要限速，避免刷屏');
});

test('出售条件上下文成功时带上窗口表与已加载标记', async () => {
    const aw = load();
    nextWindows = [{ id: 42, begin_time: 10, end_time: 20 }];

    const context = await aw.getSellConditionContext();

    assert.equal(context.activityWindowsLoaded, true);
    assert.ok(context.activityWindows.has('42'));
    assert.equal(context.activityWindows.get('42').endTime, 20);
    assert.equal(context.nowSec, 1_700_000_000);
});

// ============ 并发去重 ============

test('并发刷新只发一次请求，所有调用拿到同一份结果', async () => {
    const aw = load();
    nextWindows = [{ id: 1, begin_time: 10, end_time: 20 }];
    inFlightResolvers = [];

    const first = aw.refreshActivityWindows();
    const second = aw.refreshActivityWindows();
    const third = aw.refreshActivityWindows();

    // 放行挂起的请求
    const releases = inFlightResolvers;
    inFlightResolvers = [];
    for (const release of releases) release();

    const results = await Promise.all([first, second, third]);

    assert.equal(requestCount, 1, '并发调用必须共享同一个请求');
    assert.equal(results[0], results[1]);
    assert.equal(results[1], results[2]);
});
