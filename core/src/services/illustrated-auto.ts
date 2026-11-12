export {};
/**
 * 收藏图鉴每日自动化
 * - 每天检查一次（登录 / 跨天时由 worker 的每日例行触发，同一天不重复）。
 * - 可领取的图鉴奖励自动领取（作物 + 超变两本）。
 * - 未点亮、可下单且背包里没有对应种子的作物自动购买 1 个。
 * 两个行为各有独立开关，默认关闭；deps 可注入，便于回归测试。
 */

const { getAutomation } = require('../models/store');
const { getSystemDateKey, log, logWarn, sleep, toNum } = require('../utils/utils');
const illustrated = require('./illustrated');

const ILLUSTRATED_AUTO_KEYS = [
    'illustrated_auto_claim_rewards',
    'illustrated_auto_buy_missing_seeds',
] as const;

/** 与前端 IllustratedPanel.canPurchaseSeed 同口径：只认当前能下单的商城种子。 */
function isBuyableShopSeed(seed: any): boolean {
    if (!seed || typeof seed !== 'object') return false;
    const goodsId = toNum(seed.goodsId);
    const price = toNum(seed.price);
    return Number.isSafeInteger(goodsId) && goodsId > 0
        && Number.isSafeInteger(price) && price > 0
        && !seed.locked && !seed.soldOut && !seed.unknownMeta && !seed.requiresUnlockCard;
}

/**
 * 挑出需要补种的种子：未点亮 + 可下单 + 背包里没有 + 同一 seedId 去重。
 * bagSeedIds 可直接传背包种子 id 数组或 Set。
 */
function selectMissingBuyableSeeds(items: any[], bagSeedIds: Iterable<number> | number[]): any[] {
    const owned = new Set<number>();
    for (const id of (bagSeedIds || [])) {
        const seedId = toNum(id);
        if (seedId > 0) owned.add(seedId);
    }
    const list: any[] = Array.isArray(items) ? items : [];
    const seen = new Set<number>();
    const targets: any[] = [];
    for (const item of list) {
        if (!item || item.unlocked === true) continue;
        if (!isBuyableShopSeed(item.shopSeed)) continue;
        const seedId = toNum(item.seedId) || toNum(item.shopSeed && item.shopSeed.seedId);
        if (!seedId || owned.has(seedId) || seen.has(seedId)) continue;
        seen.add(seedId);
        targets.push({
            seedId,
            goodsId: toNum(item.shopSeed.goodsId),
            name: String(item.name || `种子${seedId}`),
        });
    }
    return targets;
}

/** 返回有可领取奖励的图鉴 type（1=作物，2=超变）。 */
function getClaimableBookTypes(snapshot: any): number[] {
    const types: number[] = [];
    if (snapshot && snapshot.crop && snapshot.crop.claimable === true) types.push(1);
    if (snapshot && snapshot.mutant && snapshot.mutant.claimable === true) types.push(2);
    return types;
}

let lastRunDate = '';
let running = false;

function defaultDeps(): any {
    const { getBagSeeds } = require('./warehouse');
    const { purchaseSeed } = require('./farm');
    return {
        getAutomation,
        getSnapshot: () => illustrated.getIllustratedSnapshot(),
        claim: (type: number) => illustrated.claimIllustratedRewards(type),
        getBagSeeds,
        purchaseSeed,
        sleep,
        log,
        logWarn,
    };
}

async function runIllustratedDailyAutomation(force: boolean = false, injection: any = {}): Promise<any> {
    if (running) return { skipped: 'running' };
    const today = getSystemDateKey();
    // 开关由关变开时可 force 立刻检查一次；常规每日调用严格遵守「同一天只跑一次」。
    if (!force && lastRunDate === today) return { skipped: 'same_day', date: today };

    const deps = { ...defaultDeps(), ...injection };
    const automation = deps.getAutomation() || {};
    const claimEnabled = automation.illustrated_auto_claim_rewards === true;
    const buyEnabled = automation.illustrated_auto_buy_missing_seeds === true;
    if (!claimEnabled && !buyEnabled) {
        lastRunDate = today;
        return { skipped: 'disabled', date: today };
    }

    running = true;
    const result: any = { date: today, claimed: [], bought: [], failed: [] };
    // 只有真正跑完（含单项失败）才标记「当天已跑」。外层 getSnapshot/getBagSeeds 抛错时
    // 保持未标记，当天后续调用可以重试，避免一次基础设施失败就吃掉一整天。
    let completed = false;
    try {
        const snapshot = await deps.getSnapshot();
        if (claimEnabled) {
            for (const type of getClaimableBookTypes(snapshot)) {
                try {
                    const reply = await deps.claim(type);
                    result.claimed.push({ type, rewards: (reply && reply.rewards) || [] });
                    deps.log('图鉴', `每日自动领取${type === 1 ? '作物' : '超变'}图鉴奖励成功`, {
                        module: 'illustrated', event: '自动领取奖励', result: 'ok', type,
                    });
                }
                catch (e: any) {
                    deps.logWarn('图鉴', `自动领取${type === 1 ? '作物' : '超变'}图鉴奖励失败：${e.message}`, {
                        module: 'illustrated', event: '自动领取奖励', result: 'error', type,
                    });
                }
            }
        }
        if (buyEnabled) {
            const bag = await deps.getBagSeeds();
            const owned = (bag || []).map((seed: any) => toNum(seed && seed.seedId)).filter((id: number) => id > 0);
            const targets = selectMissingBuyableSeeds(snapshot && snapshot.crop && snapshot.crop.items, owned);
            for (const target of targets) {
                try {
                    await deps.purchaseSeed(target.goodsId, 1);
                    result.bought.push(target);
                    deps.log('图鉴', `每日自动补种：购买 ${target.name} ×1`, {
                        module: 'illustrated', event: '自动购买未点亮种子', result: 'ok', seedId: target.seedId,
                    });
                    await deps.sleep(300);
                }
                catch (e: any) {
                    result.failed.push({ ...target, reason: e.message });
                    deps.logWarn('图鉴', `自动补种 ${target.name} 失败：${e.message}`, {
                        module: 'illustrated', event: '自动购买未点亮种子', result: 'error', seedId: target.seedId,
                    });
                }
            }
            deps.log('图鉴', `每日图鉴自动补种完成：成功 ${result.bought.length} 个，失败 ${result.failed.length} 个`, {
                module: 'illustrated', event: '自动补种汇总', result: 'ok',
                count: result.bought.length, failed: result.failed.length,
            });
        }
        completed = true;
    }
    catch (e: any) {
        deps.logWarn('图鉴', `每日图鉴自动化检查失败：${e.message}`, {
            module: 'illustrated', event: '每日检查', result: 'error',
        });
    }
    finally {
        running = false;
        if (completed) lastRunDate = today;
    }
    return result;
}

function resetIllustratedDailyAutomation(): void {
    lastRunDate = '';
    running = false;
}

module.exports = {
    ILLUSTRATED_AUTO_KEYS,
    isBuyableShopSeed,
    selectMissingBuyableSeeds,
    getClaimableBookTypes,
    runIllustratedDailyAutomation,
    resetIllustratedDailyAutomation,
};
