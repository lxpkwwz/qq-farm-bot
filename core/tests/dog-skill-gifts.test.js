/**
 * 宠物技能礼包领取（同气连枝）。
 *
 * 这段逻辑的价值在于「不该发请求的时候不发」：
 *   - 没有待领礼包时去调 ClaimSkillGifts，等于每个巡检周期都白打一次网关请求；
 *   - 并发调用没去重，同一批礼包会被重复领取，服务端要么报错要么少给。
 *
 * 同时锁住数量字段的边界：待领数量会下发给面板，`Math.max(0, Infinity)` 仍是 Infinity，
 * JSON 里会变成 null，界面上显示成空白——所以非法值必须收敛成 0。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

// ============ 依赖注入 ============

const DOG_SKILL_GIFT_ITEM_ID = 101351;

let dogInfoReply = {};
let claimReply = {};
let dogInfoError = null;
let claimError = null;
const calls = [];

require.cache[require.resolve('../dist/config/gameConfig')] = {
    exports: {
        getItemById: id => (id === DOG_SKILL_GIFT_ITEM_ID ? { id, name: '同气连枝礼包' } : null),
    },
};

require.cache[require.resolve('../dist/utils/network')] = {
    exports: {
        sendMsgAsync: async (_service, method) => {
            calls.push(method);
            if (method === 'GetDogInfo') {
                if (dogInfoError) throw dogInfoError;
                return { body: Buffer.from(JSON.stringify(dogInfoReply)) };
            }
            if (claimError) throw claimError;
            return { body: Buffer.from(JSON.stringify(claimReply)) };
        },
    },
};

require.cache[require.resolve('../dist/utils/proto')] = {
    exports: {
        types: {
            GetDogInfoRequest: { create: v => v, encode: () => ({ finish: () => Buffer.alloc(0) }) },
            GetDogInfoReply: { decode: body => JSON.parse(body.toString()) },
            ClaimSkillGiftsRequest: { create: v => v, encode: () => ({ finish: () => Buffer.alloc(0) }) },
            ClaimSkillGiftsReply: { decode: body => JSON.parse(body.toString()) },
        },
    },
};

const warns = [];
const utilsPath = require.resolve('../dist/utils/utils');
const realUtils = require('../dist/utils/utils');
require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        log: () => {},
        logWarn: message => warns.push(message),
    },
};

const dog = require('../dist/services/dog-skill-gifts');

function reset() {
    dogInfoReply = {};
    claimReply = {};
    dogInfoError = null;
    claimError = null;
    calls.length = 0;
    warns.length = 0;
}

test.beforeEach(reset);

// ============ 数量解析 ============

test('待领数量兼容两种字段名，缺失或负数一律归零', () => {
    assert.equal(dog.getPendingGiftCount({ pending_gift_count: 3 }), 3);
    assert.equal(dog.getPendingGiftCount({ pendingGiftCount: 4 }), 4);
    assert.equal(dog.getPendingGiftCount({}), 0);
    assert.equal(dog.getPendingGiftCount(null), 0);
    assert.equal(dog.getPendingGiftCount({ pending_gift_count: -2 }), 0);
});

test('待领数量不接受 Infinity（否则面板会显示成空白）', () => {
    assert.equal(dog.getPendingGiftCount({ pending_gift_count: Number('1e400') }), 0);
    assert.equal(dog.getPendingGiftCount({ pending_gift_count: Infinity }), 0);
    assert.equal(dog.getPendingGiftCount({ pending_gift_count: 'abc' }), 0);
});

test('只累加同气连枝礼包的奖励，其他物品忽略', () => {
    const reply = {
        results: [
            { reward: { id: DOG_SKILL_GIFT_ITEM_ID, count: 2 } },
            { reward: { id: 999, count: 100 } },
            { reward: { id: DOG_SKILL_GIFT_ITEM_ID, count: 3 } },
            { reward: null },
            null,
        ],
    };
    assert.equal(dog.getFarmingSkillGiftCount(reply), 5);
    assert.equal(dog.getFarmingSkillGiftCount({}), 0);
    assert.equal(dog.getFarmingSkillGiftCount({ results: 'not-array' }), 0);
    assert.equal(dog.getFarmingSkillGiftCount({ results: [{ reward: { id: DOG_SKILL_GIFT_ITEM_ID, count: Infinity } }] }), 0);
});

// ============ 领取流程 ============

test('没有待领礼包时不发领取请求', async () => {
    dogInfoReply = { pending_gift_count: 0 };

    const result = await dog.checkAndClaimDogSkillGifts();

    assert.deepEqual(result, { claimed: 0, pending: 0, item: null });
    assert.deepEqual(calls, ['GetDogInfo'], '只查了一次状态，不该调领取');
});

test('有待领礼包时先查状态再领取，并按领取数量扣减待领数', async () => {
    dogInfoReply = { pending_gift_count: 3 };
    claimReply = { claimed_count: 2, item: { id: DOG_SKILL_GIFT_ITEM_ID, count: 2 } };

    const result = await dog.checkAndClaimDogSkillGifts();

    assert.deepEqual(calls, ['GetDogInfo', 'ClaimSkillGifts']);
    assert.equal(result.claimed, 2);
    assert.equal(result.pending, 1, '3 个待领、领了 2 个，还剩 1 个');
    assert.equal(result.item.id, DOG_SKILL_GIFT_ITEM_ID);
});

test('给了待领数量提示时跳过状态查询，直接领取', async () => {
    claimReply = { claimed_count: 1, item: { id: DOG_SKILL_GIFT_ITEM_ID, count: 1 } };

    const result = await dog.checkAndClaimDogSkillGifts(2);

    assert.deepEqual(calls, ['ClaimSkillGifts'], '提示值可用就不该再查一次状态');
    assert.equal(result.claimed, 1);
    assert.equal(result.pending, 1);
});

test('服务端没给 claimed_count 时用物品数量兜底', async () => {
    claimReply = { item: { id: DOG_SKILL_GIFT_ITEM_ID, count: 4 } };

    const result = await dog.checkAndClaimDogSkillGifts(5);

    assert.equal(result.claimed, 4);
    assert.equal(result.pending, 1);
});

test('领取失败且不要求透传时返回错误对象，待领数量用提示值兜底', async () => {
    claimError = new Error('网关超时');

    const result = await dog.checkAndClaimDogSkillGifts(6);

    assert.equal(result.claimed, 0);
    assert.equal(result.pending, 6);
    assert.equal(result.item, null);
    assert.match(result.error, /网关超时/);
    assert.equal(warns.length, 1);
});

test('要求透传错误时直接抛出', async () => {
    claimError = new Error('网关超时');

    await assert.rejects(() => dog.checkAndClaimDogSkillGifts(6, true), /网关超时/);
});

test('查询状态失败也算失败路径，不会继续去领取', async () => {
    dogInfoError = new Error('网关断开');

    const result = await dog.checkAndClaimDogSkillGifts();

    assert.equal(result.claimed, 0);
    assert.deepEqual(calls, ['GetDogInfo'], '状态都查不到就不该发起领取');
});

test('并发调用共享同一次领取，不会重复领取', async () => {
    claimReply = { claimed_count: 1, item: { id: DOG_SKILL_GIFT_ITEM_ID, count: 1 } };

    const [first, second, third] = await Promise.all([
        dog.checkAndClaimDogSkillGifts(3),
        dog.checkAndClaimDogSkillGifts(3),
        dog.checkAndClaimDogSkillGifts(3),
    ]);

    assert.equal(calls.filter(method => method === 'ClaimSkillGifts').length, 1, '同一批礼包只能领一次');
    assert.equal(first, second, '并发调用应拿到同一个结果对象');
    assert.equal(second, third);
});

test('上一次领取结束后可以再次发起', async () => {
    claimReply = { claimed_count: 1, item: { id: DOG_SKILL_GIFT_ITEM_ID, count: 1 } };

    await dog.checkAndClaimDogSkillGifts(3);
    await dog.checkAndClaimDogSkillGifts(3);

    assert.equal(calls.filter(method => method === 'ClaimSkillGifts').length, 2, '不能永久锁死领取入口');
});
