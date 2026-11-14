/**
 * 自动出售链路：protobuf int64 的 Long 对象必须能走完整条出售流程。
 *
 * 背景（真实日志）：`sellAllFruits()` 把背包回包的 item 直接交给 `sellItems()`，
 * 而 `sellItems()` 里的 `readIdOr/readCountOr` 只认 number 与纯整数文本。
 * protobuf int64 解码出来是 Long 对象 → 守卫返回 fallback 0 → 抛「出售物品参数无效」
 * → 批量失败 → 逐个也全失败 → 全部「跳过不可售物品」→ 汇总仍打印待售清单，
 * 看起来像卖成功了，实际一件都没卖出去。
 *
 * 这里用真实 Long 对象驱动整条链路（不是只测一个转换函数），并锁住两层：
 *   1. 行为：Long / number / 纯数字文本都能发出 Sell 请求且 payload 正确；
 *      Infinity / 负数 / 小数 / 对象仍被拦。
 *   2. 源码：`sellItems` 必须先 normalizeSellItemInput 再交给 read*，
 *      汇总日志不得打印「待售全名单」（那是全失败时也显示成功的元凶）。
 *
 * 依赖注入：network / proto / activity-windows / store / status / utils.sleep，
 * gameConfig 用真实配置（40004 玉米 sells 1001:21），保证筛选与可出售判定是真逻辑。
 */

require('./helpers/isolate-data');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Long = require('long');

// ---------- 依赖注入（必须在 require warehouse 之前） ----------
const sent = [];
const logs = [];
let bagReply = { item_bag: { items: [] } };
let sellReply = { get_items: [] };
let sellError = null;

const realNetwork = require('../dist/utils/network');
require.cache[require.resolve('../dist/utils/network')] = {
    exports: {
        ...realNetwork,
        sendMsgAsync: async (service, method, body) => {
            sent.push({ service, method, body });
            if (method === 'Sell' && sellError) throw sellError;
            return { body: Buffer.alloc(0) };
        },
        getUserState: () => ({ gold: 0 }),
        networkEvents: { emit: () => {} },
    },
};

const realProto = require('../dist/utils/proto');
require.cache[require.resolve('../dist/utils/proto')] = {
    exports: {
        ...realProto,
        types: {
            BagRequest: { create: () => ({}), encode: () => ({ finish: () => Buffer.alloc(0) }) },
            BagReply: { decode: () => bagReply },
            SellRequest: {
                create: value => value,
                encode: (value) => {
                    sent.push({ kind: 'payload', items: value && value.items });
                    return { finish: () => Buffer.alloc(0) };
                },
            },
            SellReply: { decode: () => sellReply },
        },
    },
};

require.cache[require.resolve('../dist/services/activity-windows')] = {
    exports: { getSellConditionContext: async () => ({}) },
};
require.cache[require.resolve('../dist/models/store')] = {
    exports: { isAutomationOn: () => true },
};
require.cache[require.resolve('../dist/services/status')] = {
    exports: { updateStatusGold: () => {} },
};

const realUtils = require('../dist/utils/utils');
require.cache[require.resolve('../dist/utils/utils')] = {
    exports: {
        ...realUtils,
        sleep: async () => {},
        log: (tag, msg, meta) => { logs.push({ tag, msg, meta, warn: false }); },
        logWarn: (tag, msg, meta) => { logs.push({ tag, msg, meta, warn: true }); },
    },
};

const warehouse = require('../dist/services/warehouse');

// ---------- 夹具 ----------
const CORN_ID = 40004; // 真实配置：玉米，sells = 1001:21

function longItem(id = CORN_ID, count = 17) {
    return {
        id: Long.fromNumber(id),
        count: Long.fromNumber(count),
        uid: Long.fromNumber(0),
    };
}

function reset() {
    sent.length = 0;
    logs.length = 0;
    sellError = null;
    bagReply = { item_bag: { items: [longItem()] } };
    sellReply = { get_items: [{ id: Long.fromNumber(1001), count: Long.fromNumber(357) }] };
}
reset();

function sellCalls() {
    return sent.filter(entry => entry.method === 'Sell');
}
function payloads() {
    return sent.filter(entry => entry.kind === 'payload');
}

// ---------- 1. 归一化函数本身 ----------
test('normalizeSellItemInput 把 protobuf Long 转成 number，非法形态仍留给守卫拦', () => {
    const normalized = warehouse.normalizeSellItemInput(longItem());
    assert.equal(normalized.id, CORN_ID);
    assert.equal(typeof normalized.id, 'number');
    assert.equal(normalized.count, 17);
    assert.equal(typeof normalized.count, 'number');

    const guards = require('../dist/utils/input-guards');
    assert.equal(guards.readIdOr(normalized.id, 'id', 0), CORN_ID);

    const rejects = [
        ['Infinity', Number('1e400')],
        ['负数', -5],
        ['小数', 1.5],
        ['null', null],
        ['普通对象', { low: 4, high: 0 }],
    ];
    for (const [label, value] of rejects) {
        const out = warehouse.normalizeSellItemInput({ id: value, count: value });
        assert.equal(guards.readIdOr(out.id, 'id', 0), 0, `${label} 必须被守卫挡下`);
    }
});

// ---------- 2. 端到端：真实 Long 对象能发出 Sell ----------
test('sellItems 收到背包回包的 Long 对象时能正常发出出售请求（回归核心）', async () => {
    reset();
    await warehouse.sellItems([longItem(CORN_ID, 17)]);

    assert.equal(sellCalls().length, 1, '必须发出一次 Sell');
    const payload = payloads();
    assert.equal(payload.length, 1);
    assert.equal(realUtils.toNum(payload[0].items[0].id), CORN_ID);
    assert.equal(realUtils.toNum(payload[0].items[0].count), 17);
});

test('sellItems 对 number 与纯整数文本同样放行，对 Infinity 仍然拒绝', async () => {
    reset();
    await warehouse.sellItems([{ id: CORN_ID, count: 3 }]);
    await warehouse.sellItems([{ id: String(CORN_ID), count: 2 }]);
    assert.equal(sellCalls().length, 2);

    reset();
    await assert.rejects(
        () => warehouse.sellItems([{ id: Number('1e400'), count: 1 }]),
        /出售物品参数无效/,
    );
    assert.equal(sellCalls().length, 0, '非法参数绝不能进到网络层');
});

// ---------- 3. 汇总日志不撒谎 ----------
test('sellAllFruits 用真实 Long 背包能卖成功，且汇总只列实际卖出条目', async () => {
    reset();
    await warehouse.sellAllFruits();

    assert.ok(sellCalls().length >= 1, '必须真的发出出售请求');
    const summary = logs.find(entry => !entry.warn && /出售/.test(entry.msg));
    assert.ok(summary, '应有出售汇总日志');
    assert.match(summary.msg, /玉米x17/, '汇总应列出实际卖出的玉米');
    assert.equal(summary.meta.soldCount, 17);
    assert.equal(summary.meta.skippedCount, 0);
    assert.equal(summary.meta.result, 'ok');
});

test('全部出售失败时汇总结论是「出售未完成」，不伪装成已出售', async () => {
    reset();
    sellError = new Error('模拟服务端拒绝');
    await warehouse.sellAllFruits();

    const summary = logs.find(entry => !entry.warn && /出售/.test(entry.msg));
    assert.ok(summary);
    assert.match(summary.msg, /出售未完成/);
    assert.doesNotMatch(summary.msg, /玉米x17/, '绝不能把待售清单当成已售出打印');
    assert.equal(summary.meta.result, 'all_skipped');
    assert.equal(summary.meta.soldCount, 0);
    assert.ok(summary.meta.skippedCount > 0);
});

// ---------- 4. 源码闸门：防止改回归 ----------
test('源码闸门：sellItems 必须先归一化再进 read* 守卫', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../src/services/warehouse.ts'),
        'utf8',
    );
    assert.match(
        source,
        /function normalizeSellItemInput\(item: any\): any/,
        '归一化函数不得被删',
    );
    assert.match(
        source,
        /function normalizeItemNumber\(value: unknown\): number/,
        '字符串 id 也必须数值化，否则 findBagItem 严格比较会失配',
    );
    assert.match(
        source,
        /if \(typeof value === 'string'\) return Number\(value\);/,
        '纯整数文本走 Number 转换',
    );
    // 切出函数体再逐字段断言：避免跨行正则里两个可交换 \s* 触发超线性回溯 lint。
    const normalizeBody = source.slice(
        source.indexOf('function normalizeSellItemInput'),
        source.indexOf('async function sellItems'),
    );
    assert.match(normalizeBody, /id: normalizeItemNumber\(item && item\.id\)/);
    assert.match(normalizeBody, /count: normalizeItemNumber\(item && item\.count\)/);
    assert.match(normalizeBody, /uid: normalizeItemNumber\(item && item\.uid\)/);
    assert.match(
        source,
        /\(Array\.isArray\(items\) \? items : \[\]\)\.map\(normalizeSellItemInput\)/,
        '整批条目在进守卫之前必须一次性归一化',
    );
    assert.match(
        source,
        /readIdOr\(item\.id, 'id', 0\)/,
        '校验循环必须消费归一化后的字段',
    );
    assert.doesNotMatch(
        source,
        /readIdOr\(item && item\.id/,
        '不得把背包回包字段直接喂给 read*（会让 Long 被判成 0）',
    );
});

test('源码闸门：汇总日志只列实际卖出条目，且全部失败时给出明确结论', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../src/services/warehouse.ts'),
        'utf8',
    );
    assert.match(source, /const soldNames: string\[\] = \[\]/);
    assert.match(source, /soldNames\.push\(sellItemLabel\(it\)\)/);
    assert.match(source, /const soldNothing: boolean = soldTotalCount <= 0/);
    assert.match(source, /出售未完成/);
    assert.match(source, /result: soldNothing \? 'all_skipped' : \(totalGoldEarned > 0 \? 'ok' : 'unknown_gain'\)/);
    assert.doesNotMatch(
        source,
        /出售 \$\{names\.join\('/,
        '不得再打印筛选阶段的全量待售清单',
    );
});
