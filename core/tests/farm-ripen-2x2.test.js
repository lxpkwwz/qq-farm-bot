// 数据目录指向临时区：否则测试会通过真实 logger 往 core/data/logs 里追加日志。
require('./helpers/isolate-data');

const test = require('node:test');
const assert = require('node:assert/strict');

// ── 纯函数：2×2 主地块识别（老版 farm-fertilizer 口径）──
const { pickRipen2x2Lands } = require('../dist/services/farm/land-analysis');

test('pickRipen2x2Lands：识别 2×2 主地块并排除从属地块', () => {
    const lands = [
        // 2×2 主地块：自身带作物，占 4 块地（自身 + 3 从属）
        { id: 1, unlocked: true, plant: { id: 999999, phases: [{ phase: 3, begin_time: 1000 }] }, slave_land_ids: [2, 3, 4] },
        { id: 2, unlocked: true, master_land_id: 1 },
        { id: 3, unlocked: true, master_land_id: 1 },
        { id: 4, unlocked: true, master_land_id: 1 },
        // 单格作物：既不是 2×2 目标，也不该被排除出常规施肥
        { id: 5, unlocked: true, plant: { id: 999999, phases: [{ phase: 3, begin_time: 1000 }] } },
        // 悬空从属：master 不在列表里，仍按从属排除
        { id: 6, master_land_id: 99 },
        // 锁定的 4 格布局：不参与催熟也不排除常规施肥目标
        { id: 7, unlocked: false, slave_land_ids: [8, 9, 10] },
    ];
    const { size2LandIds, excludedIds } = pickRipen2x2Lands(lands);
    assert.deepEqual(size2LandIds, [1]);
    for (const id of [1, 2, 3, 4, 6]) {
        assert.ok(excludedIds.has(id), `地块 ${id} 应被排除出常规施肥`);
    }
    assert.ok(!excludedIds.has(5), '单格作物不应被排除');
    assert.ok(!excludedIds.has(7), '锁定地块不参与催熟也不应被排除');
});

test('pickRipen2x2Lands：空数据与无作物列表', () => {
    assert.deepEqual(pickRipen2x2Lands([]), { size2LandIds: [], excludedIds: new Set() });
    assert.deepEqual(pickRipen2x2Lands(undefined), { size2LandIds: [], excludedIds: new Set() });
});

// ── 有机肥催熟循环（ripenSize2 模式，老版逐次校验生长推进）──
// network / proto / utils 走 require.cache 注入，土地分析（getCurrentPhase / PlantPhase）
// 用真实实现；decode 直接返回构造好的回复对象，不依赖 protobuf。
const mocks = { replies: [], sent: 0, decoded: null, failNext: false };
const networkPath = require.resolve('../dist/utils/network');
const protoPath = require.resolve('../dist/utils/proto');
const utilsPath = require.resolve('../dist/utils/utils');

const realUtils = require('../dist/utils/utils');
require.cache[utilsPath] = {
    exports: { ...realUtils, randomDelay: async () => {} },
};
require.cache[networkPath] = {
    exports: {
        sendMsgAsync: async () => {
            if (mocks.failNext) {
                mocks.failNext = false;
                mocks.sent += 1;
                throw new Error('有机肥耗尽');
            }
            const reply = mocks.replies[Math.min(mocks.sent, mocks.replies.length - 1)];
            mocks.sent += 1;
            mocks.decoded = reply;
            return { body: Buffer.alloc(0) };
        },
        getUserState: () => ({}),
    },
};
require.cache[protoPath] = {
    exports: {
        types: {
            FertilizeRequest: {
                create: value => value,
                encode: () => ({ finish: () => Buffer.alloc(0) }),
            },
            FertilizeReply: {
                decode: () => mocks.decoded,
            },
        },
    },
};

const { fertilizeOrganicLoop, ORGANIC_FERTILIZER_ID } = require('../dist/services/farm/api');

function fertilizeReply(landId, phases, fertilizerCount) {
    const reply = {
        land: [{ id: landId, plant: { id: 1, phases } }],
    };
    if (fertilizerCount !== undefined) {
        reply.fertilizer = { id: ORGANIC_FERTILIZER_ID, count: fertilizerCount };
    }
    return reply;
}

function growingPhases(matureAtSec) {
    // phases[0].phase=3（生长中），成熟时间放在最后一个阶段
    return [
        { phase: 3, begin_time: Math.max(0, matureAtSec - 3600) },
        { phase: 6, begin_time: matureAtSec },
    ];
}

function maturePhases() {
    return [{ phase: 6, begin_time: 1000 }];
}

function withMock(replies, fn) {
    mocks.sent = 0;
    mocks.decoded = null;
    mocks.replies = replies;
    return fn();
}

test('催熟循环：作物已成熟时只施一次即停止', async () => {
    const count = await withMock([fertilizeReply(11, maturePhases())], () =>
        fertilizeOrganicLoop([11], { ripenSize2: true }));
    assert.equal(count, 1);
    assert.equal(mocks.sent, 1);
});

test('催熟循环：生长推进一次后不再推进则停止', async () => {
    const t = Math.floor(Date.now() / 1000) + 7200;
    const count = await withMock([
        fertilizeReply(12, growingPhases(t - 60)),
        fertilizeReply(12, growingPhases(t)), // 成熟时间与上一轮相同 → 无推进
        fertilizeReply(12, growingPhases(t - 120)),
    ], () => fertilizeOrganicLoop([12], { ripenSize2: true }));
    assert.equal(count, 2);
    assert.equal(mocks.sent, 2);
});

test('催熟循环：肥料耗尽立即停止', async () => {
    const t = Math.floor(Date.now() / 1000) + 7200;
    const count = await withMock([
        fertilizeReply(13, growingPhases(t - 60), 60),
        fertilizeReply(13, growingPhases(t - 120), 0),
        fertilizeReply(13, growingPhases(t - 180), 0),
    ], () => fertilizeOrganicLoop([13], { ripenSize2: true }));
    assert.equal(count, 2);
    assert.equal(mocks.sent, 2);
});

test('催熟循环：施肥请求失败即停止且不抛出', async () => {
    mocks.sent = 0;
    mocks.decoded = null;
    mocks.replies = [];
    mocks.failNext = true;
    const count = await fertilizeOrganicLoop([14], { ripenSize2: true });
    assert.equal(count, 0);
    assert.equal(mocks.sent, 1);
});

test('催熟循环：非催熟模式保持原有循环语义', async () => {
    // 老模式（不带 ripenSize2）不受施肥结果校验影响，一直循环到操作上限。
    const t = Math.floor(Date.now() / 1000) + 7200;
    const count = await withMock([fertilizeReply(15, growingPhases(t))], () =>
        fertilizeOrganicLoop([15]));
    assert.equal(count, 20); // MAX_ORGANIC_FERTILIZE_ROUNDS
    assert.equal(mocks.sent, 20);
});
