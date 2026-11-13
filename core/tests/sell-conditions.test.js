/**
 * 出售条件判定。
 *
 * 背包自动出售靠这几十行决定「现在到底能不能卖」：条件不满足时不卖（保守），
 * 但判错的另一面是——条件永远不会满足，于是果实一直堆着卖不出去，而且不报错。
 *
 * 条件语法是 `类型:参数;类型:参数`，全部条件同时满足才算通过。
 * 目前支持四种：`道具过期后` / `活动结束后` / `活动结束前` / `活动区间外`。
 * 活动类条件依赖活动窗口表；窗口表还没加载完成时必须一律判 false（宁可晚卖，不能早卖）。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSellConditions, isSellConditionSatisfied } = require('../dist/config/sell-conditions');

const NOW = 1_700_000_000;

function windows(entries) {
    return new Map(entries.map(entry => [entry.id, entry]));
}

function context(extra = {}) {
    return {
        nowSec: NOW,
        activityWindowsLoaded: true,
        activityWindows: windows([
            { id: 'active', beginTime: NOW - 100, endTime: NOW + 100 },
            { id: 'ended', beginTime: NOW - 200, endTime: NOW - 50 },
            { id: 'future', beginTime: NOW + 100, endTime: NOW + 200 },
        ]),
        ...extra,
    };
}

// ============ 解析 ============

test('条件串按分号拆分并去掉空白，空串得到空数组', () => {
    assert.deepEqual(parseSellConditions(''), []);
    assert.deepEqual(parseSellConditions(null), []);
    assert.deepEqual(parseSellConditions(';;;'), []);
    assert.deepEqual(parseSellConditions(' 道具过期后 '), [{ type: '道具过期后', value: '' }]);
});

test('带参数的条件按第一个冒号切开，值里还能有冒号', () => {
    assert.deepEqual(parseSellConditions('活动结束后:abc'), [{ type: '活动结束后', value: 'abc' }]);
    assert.deepEqual(parseSellConditions('活动结束后:a:b'), [{ type: '活动结束后', value: 'a:b' }]);
});

test('多个条件保持顺序', () => {
    const parsed = parseSellConditions('活动结束后:a;道具过期后;活动区间外:b');
    assert.deepEqual(parsed.map(entry => entry.type), ['活动结束后', '道具过期后', '活动区间外']);
});

// ============ 道具过期后 ============

test('道具过期后：需要有效期且已到期', () => {
    assert.equal(isSellConditionSatisfied('道具过期后', context({ expireTime: 0 })), false, '没有有效期不能算过期');
    assert.equal(isSellConditionSatisfied('道具过期后', context({ expireTime: NOW - 1 })), true);
    assert.equal(isSellConditionSatisfied('道具过期后', context({ expireTime: NOW })), true, '刚好到点算过期');
    assert.equal(isSellConditionSatisfied('道具过期后', context({ expireTime: NOW + 1 })), false);
});

// ============ 活动结束后 ============

test('活动结束后：窗口不存在时视为已结束，窗口未结束时不卖', () => {
    assert.equal(isSellConditionSatisfied('活动结束后:ended', context()), true);
    assert.equal(isSellConditionSatisfied('活动结束后:active', context()), false);
    assert.equal(isSellConditionSatisfied('活动结束后:future', context()), false);
    assert.equal(isSellConditionSatisfied('活动结束后:missing', context()), true, '查不到窗口按已结束处理');
});

test('活动结束后：结束时间等于当前时间算已结束', () => {
    const ctx = context({ activityWindows: windows([{ id: 'edge', beginTime: NOW - 10, endTime: NOW }]) });
    assert.equal(isSellConditionSatisfied('活动结束后:edge', ctx), true);
});

// ============ 活动结束前 ============

test('活动结束前：窗口仍在进行时才卖，查不到窗口不卖', () => {
    assert.equal(isSellConditionSatisfied('活动结束前:active', context()), true);
    assert.equal(isSellConditionSatisfied('活动结束前:ended', context()), false);
    assert.equal(isSellConditionSatisfied('活动结束前:missing', context()), false);
});

// ============ 活动区间外 ============

test('活动区间外：未开始、已结束、查不到窗口都算区间外', () => {
    assert.equal(isSellConditionSatisfied('活动区间外:active', context()), false);
    assert.equal(isSellConditionSatisfied('活动区间外:future', context()), true);
    assert.equal(isSellConditionSatisfied('活动区间外:ended', context()), true);
    assert.equal(isSellConditionSatisfied('活动区间外:missing', context()), true);
});

test('活动区间外：区间两端都是闭区间', () => {
    const atBegin = context({
        nowSec: NOW - 100,
        activityWindows: windows([{ id: 'w', beginTime: NOW - 100, endTime: NOW + 100 }]),
    });
    assert.equal(isSellConditionSatisfied('活动区间外:w', atBegin), false, '刚开始不算区间外');

    const atEnd = context({
        nowSec: NOW + 100,
        activityWindows: windows([{ id: 'w', beginTime: NOW - 100, endTime: NOW + 100 }]),
    });
    assert.equal(isSellConditionSatisfied('活动区间外:w', atEnd), false, '刚结束那一秒仍算区间内');
});

// ============ 保守策略与组合语义 ============

test('活动窗口表还没加载时，所有活动类条件一律判 false', () => {
    const notLoaded = context({ activityWindowsLoaded: false });
    for (const condition of ['活动结束后:ended', '活动结束前:active', '活动区间外:future']) {
        assert.equal(isSellConditionSatisfied(condition, notLoaded), false, `${condition} 在窗口表未加载时不该通过`);
    }
    // 不依赖活动表的条件不受影响
    assert.equal(isSellConditionSatisfied('道具过期后', { ...notLoaded, expireTime: NOW - 1 }), true);
});

test('多个条件是「与」关系：任一不满足就整体不卖', () => {
    const ctx = context({ expireTime: NOW - 1 });
    assert.equal(isSellConditionSatisfied('道具过期后;活动结束后:ended', ctx), true);
    assert.equal(isSellConditionSatisfied('道具过期后;活动结束后:active', ctx), false);
    assert.equal(isSellConditionSatisfied('道具过期后;活动区间外:active', ctx), false);
});

test('空条件与未知条件都不卖', () => {
    assert.equal(isSellConditionSatisfied('', context()), false);
    assert.equal(isSellConditionSatisfied(null, context()), false);
    assert.equal(isSellConditionSatisfied('不存在的条件', context()), false);
});

test('活动类条件缺少参数（没有活动 id）时不卖', () => {
    assert.equal(isSellConditionSatisfied('活动结束后', context()), false);
    assert.equal(isSellConditionSatisfied('活动区间外:', context()), false);
});

test('缺少上下文也不崩，一律判 false', () => {
    assert.equal(isSellConditionSatisfied('活动结束后:ended', {}), false);
    assert.equal(isSellConditionSatisfied('道具过期后', {}), false);
});
