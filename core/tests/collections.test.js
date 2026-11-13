/**
 * 蓝晶藏品（collections）。
 *
 * 这个模块只做两件事：把游戏回包 + 配置拼成面板要的形状，以及把「升星 / 展示 / 领奖」
 * 三个动作包成可核对的本地事务。它之前完全没有测试，而这里的错误后果都比较重：
 *   - `canUpgrade` 算错 → 按钮该亮不亮、或者点下去才失败；
 *   - `nextRewardScore` / `currentBuffs` 算错 → 面板显示已解锁的属性其实是没到手的；
 *   - 参数校验漏了 → 非法藏品编号被当成 0 传进协议。
 *
 * 所以这里不硬编码配置里的具体数值（配置会变），只锁结构性不变量。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const CATEGORY = 1;
const DISPLAY_SLOT = 1;

// ============ 协议层按需注入（模块本身只在函数内部 require 它） ============

let replyPayload = null;
let requestCount = 0;
const sentMethods = [];

require.cache[require.resolve('../dist/utils/network')] = {
    exports: {
        sendMsgAsync: async (_service, method) => {
            requestCount += 1;
            sentMethods.push(method);
            if (method === 'GetCollections') {
                return { body: Buffer.from(JSON.stringify(replyPayload || {})) };
            }
            return { body: Buffer.from(JSON.stringify({ ok: true })) };
        },
    },
};

require.cache[require.resolve('../dist/utils/proto')] = {
    exports: {
        types: new Proxy({}, {
            get: (_target, name) => {
                if (name === 'GetCollectionsRequest') return { encode: () => ({ finish: () => Buffer.alloc(0) }) };
                if (name === 'GetCollectionsReply') return { decode: body => JSON.parse(body.toString()) };
                return { encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }), decode: body => JSON.parse(body.toString()) };
            },
        }),
    },
};

const collections = require('../dist/services/collections');

// ============ 构造回包 ============

function detail(overrides = {}) {
    return {
        category: CATEGORY,
        collections: [],
        current_score: 0,
        claimed_reward_score: 0,
        wished: [],
        pedestals: [],
        ...overrides,
    };
}

function reply(overrides = {}) {
    return { details: [detail(overrides.detail)], display_slots: overrides.display_slots || [] };
}

function allItems(snapshot) {
    return snapshot.series.flatMap(series => series.items);
}

test.beforeEach(() => {
    replyPayload = null;
    requestCount = 0;
    sentMethods.length = 0;
});

// ============ 回包校验 ============

test('回包里没有蓝晶分类时直接抛错，不返回半成品', () => {
    assert.throws(() => collections.normalizeCollections({ details: [] }), /未返回蓝晶藏品信息/);
    assert.throws(() => collections.normalizeCollections({}), /未返回蓝晶藏品信息/);
});

// ============ 未拥有任何藏品 ============

test('一件都没有时：激活数为 0，所有藏品都不可升星', () => {
    const snapshot = collections.normalizeCollections(reply());

    assert.ok(snapshot.series.length > 0, '配置里应当有蓝晶系列');
    assert.equal(snapshot.activatedCount, 0);
    assert.ok(snapshot.totalCount > 0);
    for (const item of allItems(snapshot)) {
        assert.equal(item.starLevel, 0);
        assert.equal(item.activated, false, `${item.name} 未拥有却被标记为已激活`);
        assert.equal(item.canUpgrade, false, `${item.name} 未拥有却允许升星`);
        assert.equal(item.ownCount, '0');
    }
});

test('顶层统计等于各系列之和', () => {
    const snapshot = collections.normalizeCollections(reply());
    const sumActivated = snapshot.series.reduce((total, series) => total + series.activatedCount, 0);
    const sumTotal = snapshot.series.reduce((total, series) => total + series.totalCount, 0);
    assert.equal(snapshot.activatedCount, sumActivated);
    assert.equal(snapshot.totalCount, sumTotal);
});

// ============ 已满星 ============

test('全部满星时：激活数等于总数，且没有一件还能继续升星', () => {
    const probe = collections.normalizeCollections(reply());
    const owned = probe.series.flatMap(series => series.items).map(item => ({
        collection_id: item.id,
        star_level: 5,
        own_count: '999',
    }));

    const snapshot = collections.normalizeCollections(reply({ detail: { collections: owned } }));

    assert.equal(snapshot.activatedCount, snapshot.totalCount);
    for (const item of allItems(snapshot)) {
        assert.equal(item.starLevel, 5);
        assert.equal(item.activated, true);
        assert.equal(item.canUpgrade, false, `${item.name} 已满星却仍标记可升星`);
    }
});

test('星级高于上限的数据不会让 activatedCount 超过总数', () => {
    const probe = collections.normalizeCollections(reply());
    const owned = probe.series.flatMap(series => series.items).map(item => ({
        collection_id: item.id,
        star_level: 9,
        own_count: '1',
    }));

    const snapshot = collections.normalizeCollections(reply({ detail: { collections: owned } }));
    assert.equal(snapshot.activatedCount, snapshot.totalCount);
});

// ============ 里程碑与属性 ============

test('未领取任何里程碑时 nextRewardScore 指向第一个，且当前属性为空', () => {
    const snapshot = collections.normalizeCollections(reply());
    assert.ok(snapshot.milestones.length > 0, '配置里应当有里程碑');

    const first = snapshot.milestones[0];
    assert.equal(snapshot.nextRewardScore, first.score);
    assert.equal(first.claimed, false);
    assert.deepEqual(snapshot.currentBuffs, [], '一个都没领到时不该有任何属性加成');
});

test('已领取的里程碑会贡献属性加成，nextRewardScore 指向下一个未领取的', () => {
    const probe = collections.normalizeCollections(reply());
    const secondScore = probe.milestones[1]?.score;
    if (secondScore === undefined) return; // 配置只有一个里程碑时跳过

    const snapshot = collections.normalizeCollections(reply({
        detail: { current_score: secondScore, claimed_reward_score: secondScore },
    }));

    const claimedMilestones = snapshot.milestones.filter(row => row.claimed);
    assert.ok(claimedMilestones.length >= 2);
    assert.ok(snapshot.currentBuffs.length > 0, '领取过的里程碑应当带来属性加成');
    assert.notEqual(snapshot.nextRewardScore, secondScore, 'nextRewardScore 要指向未领取的那个');
});

test('达到分数但没领取时，reached 为真、claimed 仍为假，且不给属性', () => {
    const probe = collections.normalizeCollections(reply());
    const firstScore = probe.milestones[0].score;

    const snapshot = collections.normalizeCollections(reply({
        detail: { current_score: firstScore, claimed_reward_score: 0 },
    }));

    const first = snapshot.milestones[0];
    assert.equal(first.reached, true);
    assert.equal(first.claimed, false);
    assert.deepEqual(snapshot.currentBuffs, []);
    assert.equal(snapshot.nextRewardScore, firstScore, '可以领但还是第一个未领取的');
});

// ============ 展示位 ============

test('没有展示藏品时 display 为 null', () => {
    assert.equal(collections.normalizeCollections(reply()).display, null);
    assert.equal(collections.normalizeCollections(reply({
        display_slots: [{ slot_type: DISPLAY_SLOT, display: { category: CATEGORY, item_id: 0, pedestal_id: 0 } }],
    })).display, null);
});

test('有展示藏品时解析出藏品与展台编号，并标记对应藏品', () => {
    const probe = collections.normalizeCollections(reply());
    const target = allItems(probe)[0];

    const snapshot = collections.normalizeCollections(reply({
        display_slots: [{ slot_type: DISPLAY_SLOT, display: { category: CATEGORY, item_id: target.id, pedestal_id: 3 } }],
    }));

    assert.deepEqual(snapshot.display, { itemId: String(target.id), pedestalId: '3' });
    const displayed = allItems(snapshot).filter(item => item.displayed);
    assert.equal(displayed.length, 1, '只应有一件被标记为展示中');
    assert.equal(displayed[0].id, target.id);
});

test('别的分类的展示位不会影响蓝晶展示', () => {
    const probe = collections.normalizeCollections(reply());
    const target = allItems(probe)[0];

    const snapshot = collections.normalizeCollections({
        details: [detail()],
        display_slots: [{ slot_type: DISPLAY_SLOT, display: { category: 2, item_id: target.id, pedestal_id: 1 } }],
    });

    assert.equal(snapshot.display, null);
});

// ============ 展台 ============

test('默认展台算已拥有，其余展台按回包判定', () => {
    const probe = collections.normalizeCollections(reply());
    const pedestals = probe.pedestals;
    assert.ok(pedestals.length > 0, '配置里应当有展台');

    const defaultPedestal = pedestals.find(row => row.owned);
    assert.ok(defaultPedestal, '至少要有默认展台');

    for (const pedestal of pedestals) {
        assert.equal(typeof pedestal.owned, 'boolean');
        assert.ok(pedestal.name);
    }
});

// ============ 参数校验（不需要网络） ============

test('未知操作直接抛 INVALID_ARGUMENT', () => {
    // 这是同步抛错（发生在返回 Promise 之前），所以用 throws 而不是 rejects。
    assert.throws(
        () => collections.operateCollections('不存在'),
        (error) => error.code === 'INVALID_ARGUMENT',
    );
});

test('非法藏品编号在发请求之前就被拒绝', async () => {
    for (const bad of ['abc', 0, -1, 1.5, Infinity, Number('1e400'), null]) {
        await assert.rejects(
            () => collections.setCollectionDisplay({ collectionId: bad, displayed: true }),
            (error) => error.code === 'INVALID_ARGUMENT',
            `collectionId=${String(bad)} 不该通过校验`,
        );
    }
    assert.equal(requestCount, 0, '参数非法时不该发任何请求');
});

test('展示开关必须是布尔值', async () => {
    const probe = collections.normalizeCollections(reply());
    const id = allItems(probe)[0].id;

    for (const bad of ['yes', 1, null, undefined]) {
        await assert.rejects(
            () => collections.setCollectionDisplay({ collectionId: id, displayed: bad }),
            (error) => error.code === 'INVALID_ARGUMENT',
        );
    }
    assert.equal(requestCount, 0);
});

test('升星的星级参数必须是 0–4 的整数', async () => {
    const probe = collections.normalizeCollections(reply());
    const id = allItems(probe)[0].id;

    for (const bad of [-1, 5, 1.5, '2', null]) {
        await assert.rejects(
            () => collections.prepareCollectionUpgrade({ collectionId: id, expectedStarLevel: bad }),
            (error) => error.code === 'INVALID_ARGUMENT',
            `expectedStarLevel=${String(bad)} 不该通过校验`,
        );
    }
    assert.equal(requestCount, 0);
});

// ============ 快照请求去重 ============

test('并发取快照只发一次请求，fresh 为真时强制重取', async () => {
    replyPayload = reply();

    await Promise.all([
        collections.getCollectionsSnapshot(),
        collections.getCollectionsSnapshot(),
        collections.getCollectionsSnapshot(),
    ]);
    assert.equal(requestCount, 1, '并发调用必须共享同一个请求');

    await collections.getCollectionsSnapshot({ fresh: true });
    assert.equal(requestCount, 2, 'fresh 要绕过缓存');

    await collections.getCollectionsSnapshot();
    assert.equal(requestCount, 3, '上一次已结束，新调用要重新取');
});

// ============ 变异图鉴 ============

test('变异图鉴分成普通、装扮、藏品三组，且每条都有概率明细', () => {
    const catalog = collections.getMutationCatalog();

    assert.ok(Array.isArray(catalog.normal));
    assert.ok(Array.isArray(catalog.decoration));
    assert.ok(Array.isArray(catalog.collections));

    const all = [...catalog.normal, ...catalog.decoration];
    assert.ok(all.length > 0, '配置里应当有变异效果');
    for (const effect of all) {
        assert.ok(effect.id);
        assert.ok(effect.name);
        assert.ok(Array.isArray(effect.probabilities));
        for (const entry of effect.probabilities) {
            // public_probability 是万分比（320 = 3.2%），这里换算成 0–100 的百分数，
            // 前端 MutationCatalogPanel 直接拼 "%" 渲染，所以不能是 0–1 的小数。
            assert.ok(entry.percent >= 0 && entry.percent <= 100, `概率 ${entry.percent} 超出 0–100`);
        }
    }

    for (const series of catalog.collections) {
        assert.ok(Array.isArray(series.items));
        assert.ok(series.items.length > 0);
        assert.ok(Array.isArray(series.mutationRules));
    }
});
