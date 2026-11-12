const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
    ILLUSTRATED_AUTO_KEYS,
    isBuyableShopSeed,
    selectMissingBuyableSeeds,
    getClaimableBookTypes,
    runIllustratedDailyAutomation,
    resetIllustratedDailyAutomation,
} = require('../dist/services/illustrated-auto');

const root = path.join(__dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const buyable = (goodsId, seedId, extra = {}) => ({
    goodsId, seedId, price: 100, locked: false, soldOut: false,
    requiresUnlockCard: false, unknownMeta: false, ...extra,
});

function item(seedId, goodsId, extra = {}) {
    return { seedId, name: `种子${seedId}`, unlocked: false, shopSeed: buyable(goodsId, seedId), ...extra };
}

function makeDeps(overrides = {}) {
    return {
        getAutomation: () => ({
            illustrated_auto_claim_rewards: true,
            illustrated_auto_buy_missing_seeds: true,
        }),
        getSnapshot: async () => ({ crop: { claimable: false, items: [] }, mutant: { claimable: false } }),
        claim: async () => ({ rewards: [] }),
        getBagSeeds: async () => [],
        purchaseSeed: async () => ({}),
        sleep: async () => {},
        log: () => {},
        logWarn: () => {},
        ...overrides,
    };
}

test('可下单种子判定：等级锁、限购、解锁卡、无元数据、价格非法都要排除', () => {
    assert.equal(isBuyableShopSeed(buyable(11, 101)), true);
    assert.equal(isBuyableShopSeed(null), false);
    assert.equal(isBuyableShopSeed(buyable(0, 101)), false);
    assert.equal(isBuyableShopSeed(buyable(11, 101, { price: 0 })), false);
    assert.equal(isBuyableShopSeed(buyable(11, 101, { locked: true })), false);
    assert.equal(isBuyableShopSeed(buyable(11, 101, { soldOut: true })), false);
    assert.equal(isBuyableShopSeed(buyable(11, 101, { requiresUnlockCard: true })), false);
    assert.equal(isBuyableShopSeed(buyable(11, 101, { unknownMeta: true })), false);
});

test('补种选种：未点亮 + 可下单 + 背包里没有 + 同一 seedId 去重', () => {
    const items = [
        item(101, 11),
        item(102, 12, { unlocked: true }),
        item(103, 13, { shopSeed: buyable(13, 103, { locked: true }) }),
        item(104, 14, { seedId: 101 }), // 同一 seedId 重复
    ];
    const picked = selectMissingBuyableSeeds(items, [102]);
    assert.deepEqual(picked.map(x => x.seedId), [101]);
    assert.equal(picked[0].goodsId, 11);
    assert.deepEqual(selectMissingBuyableSeeds(items, new Set([101, 103])), []);
    assert.deepEqual(selectMissingBuyableSeeds(null, []), []);
});

test('可领取图鉴类型：作物 1 / 超变 2，未达成不领', () => {
    assert.deepEqual(getClaimableBookTypes({ crop: { claimable: true }, mutant: { claimable: true } }), [1, 2]);
    assert.deepEqual(getClaimableBookTypes({ crop: { claimable: false }, mutant: { claimable: true } }), [2]);
    assert.deepEqual(getClaimableBookTypes({}), []);
});

test('两个开关都关闭时不读图鉴、不发任何请求', async () => {
    resetIllustratedDailyAutomation();
    let reads = 0;
    const result = await runIllustratedDailyAutomation(false, makeDeps({
        getAutomation: () => ({ illustrated_auto_claim_rewards: false, illustrated_auto_buy_missing_seeds: false }),
        getSnapshot: async () => { reads += 1; return {}; },
    }));
    assert.equal(result.skipped, 'disabled');
    assert.equal(reads, 0);
});

test('只开自动领取：两本图鉴都领，不购买种子', async () => {
    resetIllustratedDailyAutomation();
    const claimed = [];
    let bought = 0;
    const result = await runIllustratedDailyAutomation(false, makeDeps({
        getAutomation: () => ({ illustrated_auto_claim_rewards: true, illustrated_auto_buy_missing_seeds: false }),
        getSnapshot: async () => ({ crop: { claimable: true, items: [] }, mutant: { claimable: true } }),
        claim: async (type) => { claimed.push(type); return { rewards: [] }; },
        purchaseSeed: async () => { bought += 1; },
    }));
    assert.deepEqual(claimed, [1, 2]);
    assert.equal(bought, 0);
    assert.equal(result.claimed.length, 2);
});

test('只开自动补种：跳过背包已有种子，单个失败不中断后续', async () => {
    resetIllustratedDailyAutomation();
    const bought = [];
    const result = await runIllustratedDailyAutomation(false, makeDeps({
        getAutomation: () => ({ illustrated_auto_claim_rewards: false, illustrated_auto_buy_missing_seeds: true }),
        getSnapshot: async () => ({
            crop: { claimable: true, items: [item(101, 11), item(102, 12), item(103, 13)] },
            mutant: { claimable: false },
        }),
        getBagSeeds: async () => [{ seedId: 102 }],
        purchaseSeed: async (goodsId) => {
            if (goodsId === 13) throw new Error('金币不足');
            bought.push(goodsId);
        },
    }));
    assert.deepEqual(bought, [11], '背包已有 102 被跳过，13 失败');
    assert.equal(result.bought.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.claimed.length, 0, '自动领取开关关闭时不领奖');
});

test('每天只检查一次；开关由关变开的 force 检查仍可立即执行', async () => {
    resetIllustratedDailyAutomation();
    let reads = 0;
    const deps = makeDeps({
        getAutomation: () => ({ illustrated_auto_claim_rewards: true, illustrated_auto_buy_missing_seeds: false }),
        getSnapshot: async () => { reads += 1; return { crop: { claimable: false, items: [] } }; },
    });
    await runIllustratedDailyAutomation(false, deps);
    const second = await runIllustratedDailyAutomation(false, deps);
    assert.equal(second.skipped, 'same_day');
    assert.equal(reads, 1);
    const forced = await runIllustratedDailyAutomation(true, deps);
    assert.equal(forced.skipped, undefined);
    assert.equal(reads, 2);
});

test('每日自动化挂载在 worker 每日例行，开关由关变开保存后立即检查', () => {
    const worker = read('src/core/worker.ts');
    assert.match(worker, /await runIllustratedDailyAutomation\(\)/, '挂在 runDailyRoutines');
    assert.match(worker, /illustrated_auto_after_save/, '开关打开后 2 秒立即检查');
    assert.match(worker, /ILLUSTRATED_AUTO_KEYS/, '使用服务侧键表，避免漏配');
    assert.deepEqual([...ILLUSTRATED_AUTO_KEYS], [
        'illustrated_auto_claim_rewards',
        'illustrated_auto_buy_missing_seeds',
    ]);
    const service = read('src/services/illustrated-auto.ts');
    assert.match(service, /lastRunDate === today/, '同一天去重');
    assert.match(service, /selectMissingBuyableSeeds\(/, '购买前过滤背包已有种子');
    const defaults = read('src/models/store/shared-state.ts');
    assert.match(defaults, /illustrated_auto_claim_rewards: false/);
    assert.match(defaults, /illustrated_auto_buy_missing_seeds: false/);
    assert.match(defaults, /illustrated_buy_skip_bag: true/);
});

test('每日图鉴：getSnapshot 抛错时不标记当天已跑，后续调用可重试', async () => {
    resetIllustratedDailyAutomation();
    const failing = makeDeps({
        getSnapshot: async () => { throw new Error('网关繁忙'); },
    });
    const first = await runIllustratedDailyAutomation(false, failing);
    assert.notEqual(first.skipped, 'same_day', '失败不应被当成当天已完成');

    // 基础设施恢复后，同一天应能继续执行，而不是被 same_day 挡住一整天。
    const second = await runIllustratedDailyAutomation(false, makeDeps());
    assert.notEqual(second.skipped, 'same_day', '一次基础设施失败不应吃掉一整天');
    resetIllustratedDailyAutomation();
});
