/**
 * 已知好友 GID 管理。
 *
 * 这块逻辑负责「哪些 gid 是我们认识的好友」，结论会直接进 GetGameFriends 请求体。
 * 之前没有任何测试，而它的归一化函数 `normalizeFriendGids` 用的是 `toNum` + `<= 0`：
 * `toNum(Infinity)` 仍是 Infinity，`Infinity <= 0` 是 false，于是 Infinity 会被当成
 * 合法 gid 一路送到 `toLong()` —— 而 `Long.fromNumber(Infinity)` 等于 int64 最大值，
 * 请求会安安静静地发到一个不存在的 gid 上，没有任何报错。
 *
 * 这一组锁四件事：
 *   1. 归一化只接受安全整数，Infinity / NaN / 负数 / 0 / 非数字文本全部丢弃；
 *   2. 失效 gid 有 24 小时冷却，过期自动清理，且不接受非法值；
 *   3. 黑名单与失效集合都会从「有效好友列表」里过滤掉；
 *   4. 分批请求按 35 个一组，单批失败不中断其余批次。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const Long = require('long');

// ============ 依赖注入 ============

let knownGids = [];
let blacklist = [];
const snapshots = [];

require.cache[require.resolve('../dist/models/store')] = {
    exports: {
        getKnownFriendGids: () => knownGids.slice(),
        getKnownFriendGidSyncCooldownSec: () => 600,
        getFriendBlacklist: () => blacklist.slice(),
        applyConfigSnapshot: (patch, options) => {
            snapshots.push({ patch, options });
            if (Array.isArray(patch?.knownFriendGids)) knownGids = patch.knownFriendGids.slice();
            return { ok: true };
        },
    },
};

let records = [];
let recordsCalls = 0;
require.cache[require.resolve('../dist/services/interact')] = {
    exports: {
        getInteractRecords: async () => {
            recordsCalls += 1;
            return records;
        },
    },
};

const utilsPath = require.resolve('../dist/utils/utils');
const realUtils = require('../dist/utils/utils');
require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        log: () => {},
        logWarn: () => {},
        randomDelay: async () => {},
    },
};

class GatewayError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GatewayError';
    }
}

const sentBatches = [];
let failBatchIndex = -1;
require.cache[require.resolve('../dist/utils/network')] = {
    exports: {
        GatewayError,
        sendMsgAsync: async (_service, _method, body) => {
            const index = sentBatches.length;
            sentBatches.push(body);
            if (index === failBatchIndex) throw new Error('mock 批次失败');
            return { body: Buffer.from(JSON.stringify({ batchIndex: index })) };
        },
    },
};

let replyByBatch = () => [];
require.cache[require.resolve('../dist/utils/proto')] = {
    exports: {
        types: {
            GetGameFriendsRequest: {
                create: value => value,
                encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }),
            },
            GetAllFriendsReply: {
                decode: body => ({ game_friends: replyByBatch(JSON.parse(body.toString()).batchIndex) }),
            },
        },
    },
};

const gidManager = require('../dist/services/friend/gid-manager');

function reset() {
    knownGids = [];
    blacklist = [];
    snapshots.length = 0;
    records = [];
    recordsCalls = 0;
    sentBatches.length = 0;
    failBatchIndex = -1;
    replyByBatch = () => [];
    gidManager.clearAllInvalidKnownFriendGidCooldowns();
    gidManager.clearInvalidKnownFriendGidMarks([]);
}

// ============ 归一化 ============

test('normalizeFriendGids 丢弃 Infinity / NaN / 负数 / 0 / 非数字文本', () => {
    const result = gidManager.normalizeFriendGids([
        Infinity,
        Number.POSITIVE_INFINITY,
        Number('1e400'),
        Number.NaN,
        -1,
        0,
        'abc',
        '',
        null,
        undefined,
        {},
        [],
        42,
        '77',
    ]);
    assert.deepEqual(result, [42, 77], '只保留安全正整数，Infinity 绝不能进列表');
});

test('normalizeFriendGids 接受 Long、去重、保持出现顺序', () => {
    const result = gidManager.normalizeFriendGids([
        Long.fromNumber(1001),
        1001,
        '1001',
        1002,
        1002,
    ]);
    assert.deepEqual(result, [1001, 1002]);
});

test('dedupeFriendsByGid 按 gid 去重、丢弃非法 gid、保留第一个对象', () => {
    const friends = [
        { gid: 11, name: 'A' },
        { gid: 11, name: '重复' },
        { gid: Infinity, name: '坏数据' },
        { gid: 0, name: '零' },
        { gid: 12, name: 'B' },
        null,
    ];
    const result = gidManager.dedupeFriendsByGid(friends);
    assert.deepEqual(result.map(friend => friend.name), ['A', 'B']);
});

test('extractReplyFriends 兼容两种字段名，缺失时返回空数组', () => {
    assert.deepEqual(gidManager.extractReplyFriends({ game_friends: [{ gid: 1 }] }), [{ gid: 1 }]);
    assert.deepEqual(gidManager.extractReplyFriends({ gameFriends: [{ gid: 2 }] }), [{ gid: 2 }]);
    assert.deepEqual(gidManager.extractReplyFriends({}), []);
    assert.deepEqual(gidManager.extractReplyFriends(null), []);
});

test('buildFriendReply 同时下发新旧两种字段名', () => {
    const reply = gidManager.buildFriendReply([{ gid: 5 }, { gid: 5 }]);
    assert.equal(reply.game_friends.length, 1);
    assert.equal(reply.gameFriends.length, 1);
    assert.equal(reply.game_friends, reply.gameFriends);
});

// ============ 失效 gid 冷却 ============

test('失效 gid 冷却 24 小时，过期自动清理', () => {
    reset();
    const now = 1_700_000_000_000;
    gidManager.markKnownFriendGidInvalid(1234, now);
    assert.deepEqual([...gidManager.getInvalidKnownFriendGidSet(now)], [1234]);

    // 23 小时后仍在冷却中
    assert.deepEqual([...gidManager.getInvalidKnownFriendGidSet(now + 23 * 3600 * 1000)], [1234]);
    // 24 小时后自动过期
    assert.deepEqual([...gidManager.getInvalidKnownFriendGidSet(now + 24 * 3600 * 1000 + 1)], []);
});

test('失效标记不接受 Infinity / 0 / 非数字，避免留下永不过期的垃圾条目', () => {
    reset();
    const now = 1_700_000_000_000;
    for (const bad of [Infinity, Number('1e400'), Number.NaN, 0, -3, 'abc', null, undefined]) {
        gidManager.markKnownFriendGidInvalid(bad, now);
    }
    assert.deepEqual([...gidManager.getInvalidKnownFriendGidSet(now)], [], '非法 gid 不该被记录');
});

test('clearInvalidKnownFriendGidMarks 只解除指定 gid 的冷却', () => {
    reset();
    const now = 1_700_000_000_000;
    gidManager.markKnownFriendGidInvalid(1, now);
    gidManager.markKnownFriendGidInvalid(2, now);

    gidManager.clearInvalidKnownFriendGidMarks([1]);

    assert.deepEqual([...gidManager.getInvalidKnownFriendGidSet(now)].sort(), [2]);
});

// ============ 有效好友列表 ============

test('有效好友列表会过滤黑名单', () => {
    reset();
    knownGids = [101, 102, 103];
    blacklist = [103];

    assert.deepEqual(gidManager.getEffectiveKnownQqFriendGids(), [101, 102]);
});

test('被判失效的好友不会被「最近访客」重新加回来', () => {
    reset();
    knownGids = [1, 9];
    // 9 被判定失效并从列表移除；随后又出现在最近访客里，必须继续被挡住。
    gidManager.markKnownFriendGidInvalid(9);
    knownGids = [1];
    records = [{ visitorGid: 9 }, { visitorGid: 10 }];

    return gidManager.syncKnownFriendGidsFromRecentVisitors(true).then((result) => {
        assert.deepEqual(knownGids, [1, 10], '失效的 9 不能被访客接口重新写回配置');
        assert.deepEqual(result, [1, 10], '返回值同样不该包含已失效的 9');
    });
});

// ============ 同步好友列表 ============

test('同步好友列表：合并新 gid 并写回配置', () => {
    reset();
    knownGids = [1, 2];

    const merged = gidManager.syncKnownFriendGidsFromFriends([{ gid: 2 }, { gid: 3 }]);

    assert.deepEqual(merged, [1, 2, 3]);
    assert.deepEqual(knownGids, [1, 2, 3]);
    assert.ok(snapshots.some(item => item.options?.persist === true), '没有 IPC 通道时要落盘');
});

test('同步好友列表：没有新 gid 时不做任何写入', () => {
    reset();
    knownGids = [1, 2];

    const merged = gidManager.syncKnownFriendGidsFromFriends([{ gid: 1 }, { gid: 2 }]);

    assert.deepEqual(merged, [1, 2]);
    assert.deepEqual(snapshots, [], '没有变化就不该产生配置快照');
});

test('同步好友列表：全部是非法 gid 时直接返回空，不覆盖已有记录', () => {
    reset();
    knownGids = [1, 2];

    const merged = gidManager.syncKnownFriendGidsFromFriends([{ gid: Infinity }, { gid: 0 }]);

    assert.deepEqual(merged, []);
    assert.deepEqual(knownGids, [1, 2], '坏数据不能把已有好友列表清空');
});

// ============ 从最近访客补充 ============

test('从最近访客补充 gid，并按冷却间隔节流', async () => {
    reset();
    knownGids = [1];
    records = [{ visitorGid: 9 }, { visitorGid: 9 }, { visitorGid: 0 }, { visitorGid: Infinity }];

    const first = await gidManager.syncKnownFriendGidsFromRecentVisitors(true);
    assert.deepEqual(first, [1, 9], '重复与非法访客要过滤掉');
    assert.equal(recordsCalls, 1);

    // 未强制时，冷却期内不再请求访客记录
    await gidManager.syncKnownFriendGidsFromRecentVisitors();
    assert.equal(recordsCalls, 1, '冷却期内不应重复请求');
});

test('最近访客接口失败时回落到本地已知列表，不抛错', async () => {
    reset();
    knownGids = [5];
    require.cache[require.resolve('../dist/services/interact')].exports.getInteractRecords = async () => {
        throw new Error('网关超时');
    };

    const result = await gidManager.syncKnownFriendGidsFromRecentVisitors(true);

    assert.deepEqual(result, [5]);
});

// ============ 分批拉取好友 ============

test('分批拉取按 35 个一组，并跨批去重', async () => {
    reset();
    knownGids = Array.from({ length: 40 }, (_, index) => index + 1);
    // 每批都返回同一个 gid，验证跨批去重
    replyByBatch = () => [{ gid: 999, name: '跨批重复' }];

    const friends = await gidManager.fetchQqFriendsByKnownGids();

    assert.equal(sentBatches.length, 2, '40 个 gid 应该分成 35 + 5 两批');
    assert.deepEqual(friends.map(friend => friend.gid), [999], '两批返回同一 gid 时只保留一条');
});

test('单批失败不中断其余批次', async () => {
    reset();
    knownGids = Array.from({ length: 40 }, (_, index) => index + 1);
    failBatchIndex = 0;
    replyByBatch = batchIndex => (batchIndex === 1 ? [{ gid: 777, name: '第二批' }] : []);

    const friends = await gidManager.fetchQqFriendsByKnownGids();

    assert.deepEqual(friends.map(friend => friend.gid), [777], '第一批失败也要拿到第二批结果');
    assert.equal(sentBatches.length, 2);
});

test('没有任何已知 gid 时不发请求', async () => {
    reset();
    const friends = await gidManager.fetchQqFriendsByKnownGids();
    assert.deepEqual(friends, []);
    assert.equal(sentBatches.length, 0);
});

// ============ 移除失效好友 ============

test('移除失效 gid：从列表删除、打上冷却标记、非法值直接忽略', () => {
    reset();
    knownGids = [11, 22, 33];

    assert.equal(gidManager.removeKnownFriendGid(22, '好友B', '好友不存在'), true);
    assert.deepEqual(knownGids, [11, 33]);
    assert.deepEqual([...gidManager.getInvalidKnownFriendGidSet()], [22]);

    assert.equal(gidManager.removeKnownFriendGid(Infinity), false);
    assert.equal(gidManager.removeKnownFriendGid(0), false);
    assert.deepEqual(knownGids, [11, 33]);
});
