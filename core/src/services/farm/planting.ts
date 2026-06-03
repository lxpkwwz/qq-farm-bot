export {};
/**
 * 种植引擎 - 种植策略、种子选择、自动种植、按配置施肥
 */

const protobuf = require('protobufjs');
const { getPlantNameBySeedId, getPlantName, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantById, getPlantBySeedId, getSeedImageBySeedId } = require('../../config/gameConfig');
const { isAutomationOn, getPreferredSeed, getAutomation, getPlantingStrategy, getBagSeedPriority, getBagSeedFallbackStrategy } = require('../../models/store');
const { getUserState, getWsErrorState, sendMsgAsync } = require('../../utils/network');
const { toNum, toLong, toTimeSec, getServerTimeSec, log, logWarn, sleep } = require('../../utils/utils');
const { types } = require('../../utils/proto');
const { PHASE_NAMES, PlantPhase } = require('../../config/config');
const { getPlantRankings } = require('../analytics');
const { recordOperation } = require('../stats');
const { getBagSeeds } = require('../warehouse');
const { getAllLands, buyGoods, removePlant } = require('./api');
const {
    getCurrentPhase,
    analyzeLands,
    buildLandMap,
    getDisplayLandContext,
    summarizeLandDetails,
    getOrganicFertilizerTargetsFromLands,
    getFastMatureLands,
    normalizeFertilizerLandTypes,
    formatFertilizerLandTypes,
    filterLandIdsByTypes,
    getLandTypeByLevel,
    resolveRemovableHarvestedLands,
} = require('./land-analysis');

// ============ 种植 ============

function getPlantSizeBySeedId(seedId: number | string): number {
    const plantCfg = getPlantBySeedId(toNum(seedId));
    return Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用 50ms
 */
async function plantSeeds(seedId: number | string, landIds: number[], options: { maxPlantCount?: number } = {}): Promise<{
    planted: number;
    plantedLandIds: number[];
    occupiedLandIds: number[];
}> {
    let successCount: number = 0;
    const plantedLandIds: number[] = [];
    const occupiedLandIds = new Set<number>();
    const maxPlantCount: number = Math.max(0, toNum(options.maxPlantCount) || 0) || Number.POSITIVE_INFINITY;
    const pendingLandIds = new Set<number>((Array.isArray(landIds) ? landIds : []).map((id: any) => toNum(id)).filter(Boolean));

    for (const rawLandId of landIds) {
        const landId = toNum(rawLandId);
        if (!landId || !pendingLandIds.has(landId)) continue;
        if (successCount >= maxPlantCount) break;
        try {
            const body = encodePlantRequest(seedId, [landId]);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            const reply = types.PlantReply.decode(replyBody);
            const changedLands = Array.isArray(reply && reply.land) ? reply.land : [];
            const changedMap = buildLandMap(changedLands);
            const selfLand = changedMap.get(landId);
            const displayContext = getDisplayLandContext(selfLand || { id: landId }, changedMap);
            const occupiedIds = displayContext.occupiedLandIds.length > 0
                ? displayContext.occupiedLandIds
                : [landId];
            successCount++;
            plantedLandIds.push(displayContext.masterLandId || landId);
            for (const occupiedId of occupiedIds) {
                occupiedLandIds.add(occupiedId);
                pendingLandIds.delete(occupiedId);
            }
        } catch (e: any) {
            logWarn('种植', `土地#${landId} 失败: ${e.message}`);
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return {
        planted: successCount,
        plantedLandIds,
        occupiedLandIds: [...occupiedLandIds],
    };
}

function encodePlantRequest(seedId: number | string, landIds: number[]): Uint8Array {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

const PLANTING_STRATEGY_LABELS: Record<string, string> = {
    preferred: '优先种植种子',
    level: '最高等级作物',
    max_exp: '最大经验/时',
    max_fert_exp: '最大普通肥经验/时',
    max_profit: '最大净利润/时',
    max_fert_profit: '最大普通肥净利润/时',
    bag_priority: '背包种子优先',
};

function getPlantingStrategyLabel(strategy: string): string {
    return PLANTING_STRATEGY_LABELS[strategy] || strategy;
}

function sortBagSeedsForPlanting(bagSeeds: any[], priorityList: any[] | undefined | null): any[] {
    const indexMap = new Map<number, number>();
    const priority: any[] = Array.isArray(priorityList) ? priorityList : [];
    priority.forEach((seedId: any, index: number) => {
        const id = Number(seedId);
        if (id > 0) indexMap.set(id, index);
    });

    return [...(Array.isArray(bagSeeds) ? bagSeeds : [])].sort((a: any, b: any) => {
        const aIndex = indexMap.has(a.seedId) ? indexMap.get(a.seedId)! : Number.MAX_SAFE_INTEGER;
        const bIndex = indexMap.has(b.seedId) ? indexMap.get(b.seedId)! : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;

        const aLevel = Number(a.requiredLevel || 0);
        const bLevel = Number(b.requiredLevel || 0);
        if (aLevel !== bLevel) return bLevel - aLevel;

        return Number(a.seedId || 0) - Number(b.seedId || 0);
    });
}

async function plantFromBagSeeds(landsToPlant: any[]): Promise<{
    remainingLandIds: number[];
    fallbackAllowed: boolean;
    plantedLandIds: number[];
    totalPlanted: number;
    occupiedCount: number;
}> {
    const targetLandIds: number[] = (Array.isArray(landsToPlant) ? landsToPlant : []).map((id: any) => Number(id)).filter((id: number) => id > 0);
    if (targetLandIds.length === 0) {
        return { remainingLandIds: [], fallbackAllowed: false, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0 };
    }

    const bagSeeds = await getBagSeeds();
    const allBagSeeds: any[] = Array.isArray(bagSeeds) ? bagSeeds : [];
    const usableSeeds = sortBagSeedsForPlanting(
        allBagSeeds.filter((seed: any) => Number(seed && seed.count) > 0 && Number(seed && seed.plantSize) === 1),
        getBagSeedPriority(),
    );

    if (usableSeeds.length === 0) {
        const hasAnyBagSeed = allBagSeeds.some((seed: any) => Number(seed && seed.count) > 0);
        log('种植', hasAnyBagSeed
            ? '背包中没有可用的 1x1 种子，准备按第二优先策略补种'
            : '背包种子已用完，准备按第二优先策略补种', {
            module: 'farm',
            event: '种植种子',
            result: 'fallback_ready',
            strategy: 'bag_priority',
        });
        return { remainingLandIds: targetLandIds, fallbackAllowed: true, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0 };
    }

    let remainingLandIds: number[] = [...targetLandIds];
    let fallbackAllowed: boolean = true;
    let totalPlanted: number = 0;
    let occupiedCount: number = 0;
    const plantedLandIds: number[] = [];
    const usedSeedLogs: string[] = [];

    for (const seed of usableSeeds) {
        if (remainingLandIds.length === 0) break;

        const maxPlantCount = Math.min(Number(seed.count || 0), remainingLandIds.length);
        if (maxPlantCount <= 0) continue;

        const result = await plantSeeds(seed.seedId, remainingLandIds, { maxPlantCount });
        const currentOccupied: number[] = (Array.isArray(result.occupiedLandIds) ? result.occupiedLandIds : []).map(Number).filter((id: number) => id > 0);
        const currentPlantedLandIds: number[] = (Array.isArray(result.plantedLandIds) ? result.plantedLandIds : []).map(Number).filter((id: number) => id > 0);
        if (result.planted > 0) {
            totalPlanted += result.planted;
            occupiedCount += currentOccupied.length > 0 ? currentOccupied.length : result.planted;
            plantedLandIds.push(...currentPlantedLandIds);
            remainingLandIds = remainingLandIds.filter((id: number) => !currentOccupied.includes(id));
            usedSeedLogs.push(`${seed.name}x${result.planted}`);
        }

        if (result.planted < maxPlantCount && remainingLandIds.length > 0) {
            fallbackAllowed = false;
            logWarn('种植', `背包种子 ${seed.name} 实际种植 ${result.planted}/${maxPlantCount}，为避免误购商店种子，本轮不执行第二优先策略`, {
                module: 'farm',
                event: '种植种子',
                result: 'partial_bag_failure',
                seedId: seed.seedId,
                requested: maxPlantCount,
                planted: result.planted,
            });
        }
    }

    if (usedSeedLogs.length > 0) {
        log('种植', `已按背包优先策略种植: ${usedSeedLogs.join('，')}`, {
            module: 'farm',
            event: '种植种子',
            result: 'ok',
            strategy: 'bag_priority',
            count: totalPlanted,
        });
    }

    return {
        remainingLandIds,
        fallbackAllowed,
        plantedLandIds: [...new Set(plantedLandIds)],
        totalPlanted,
        occupiedCount,
    };
}

async function findBestSeed(overrideStrategy?: string): Promise<any | null> {
    const SEED_SHOP_ID: number = 2;
    const { getShopInfo } = require('./api');
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return null;
    }

    const state = getUserState();
    const available: any[] = [];
    for (const goods of shopReply.goods_list) {
        if (!goods.unlocked) continue;

        let meetsConditions: boolean = true;
        let requiredLevel: number = 0;
        const conds: any[] = goods.conds || [];
        for (const cond of conds) {
            if (toNum(cond.type) === 1) {
                requiredLevel = toNum(cond.param);
                if (state.level < requiredLevel) {
                    meetsConditions = false;
                    break;
                }
            }
        }
        if (!meetsConditions) continue;

        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        if (limitCount > 0 && boughtNum >= limitCount) continue;

        const price = toNum(goods.price);
        if (!price || price <= 0) continue;

        available.push({
            goods,
            goodsId: toNum(goods.id),
            seedId: toNum(goods.item_id),
            price: toNum(goods.price),
            requiredLevel,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return null;
    }

    // 按策略排序
    const strategy: string = overrideStrategy || getPlantingStrategy();
    const analyticsSortByMap: Record<string, string> = {
        max_exp: 'exp',
        max_fert_exp: 'fert',
        max_profit: 'profit',
        max_fert_profit: 'fert_profit',
    };
    const analyticsSortBy = analyticsSortByMap[strategy];
    if (analyticsSortBy) {
        try {
            const rankings = getPlantRankings(analyticsSortBy);
            const availableBySeedId = new Map<number, any>(available.map((a: any) => [a.seedId, a]));
            const tried: number[] = [];
            for (const row of rankings) {
                const seedId = Number(row && row.seedId) || 0;
                if (seedId <= 0) continue;
                const lv = Number(row && row.level);
                if (Number.isFinite(lv) && lv > state.level) continue;
                const found = availableBySeedId.get(seedId);
                if (found) {
                    if (tried.length > 0) {
                        log('商店', `策略 ${strategy} 排名第1的作物不可用，已跳过 ${tried.length} 个备选`, {
                            module: 'farm', event: '选择种子', result: 'fallback_rank', strategy, skipped: tried
                        });
                    }
                    return found;
                }
                tried.push(seedId);
            }
            // 回退：按策略排名排序可购买列表，而不是无脑选最高等级
            const rankingBySeedId = new Map<number, number>();
            rankings.forEach((row: any, index: number) => {
                const sid = Number(row && row.seedId) || 0;
                if (sid > 0) rankingBySeedId.set(sid, index);
            });
            available.sort((a: any, b: any) => {
                const aRank = rankingBySeedId.has(a.seedId) ? rankingBySeedId.get(a.seedId)! : Number.MAX_SAFE_INTEGER;
                const bRank = rankingBySeedId.has(b.seedId) ? rankingBySeedId.get(b.seedId)! : Number.MAX_SAFE_INTEGER;
                if (aRank !== bRank) return aRank - bRank;
                return b.requiredLevel - a.requiredLevel;
            });
            log('商店', `策略 ${strategy} 排名内无可购买作物（共尝试 ${tried.length} 个），按策略排名回退`, {
                module: 'farm', event: '选择种子', result: 'fallback_strategy', strategy
            });
            return available[0];
        } catch (e: any) {
            logWarn('商店', `策略 ${strategy} 计算失败: ${e.message}，回退最高等级`);
        }
        available.sort((a: any, b: any) => b.requiredLevel - a.requiredLevel);
        return available[0];
    }

    // 偏好模式
    if (strategy === 'preferred') {
        const preferred = getPreferredSeed();
        if (preferred > 0) {
            const found = available.find((a: any) => a.seedId === preferred);
            if (found) return found;
            logWarn('商店', `优先种子 ${preferred} 当前不可购买，回退自动选择`);
        }
        // 如果偏好未找到或未设置，回退到默认（等级最高）
        available.sort((a: any, b: any) => b.requiredLevel - a.requiredLevel);
    }
    // 最高等级模式
    else if (strategy === 'level') {
        available.sort((a: any, b: any) => b.requiredLevel - a.requiredLevel);
    }
    // 默认
    else {
        available.sort((a: any, b: any) => b.requiredLevel - a.requiredLevel);
    }

    return available[0];
}

async function getAvailableSeeds(): Promise<any[]> {
    const SEED_SHOP_ID: number = 2;
    const { getShopInfo } = require('./api');
    const state = getUserState();
    let list: any[] = [];

    try {
        const shopReply = await getShopInfo(SEED_SHOP_ID);
        if (shopReply.goods_list) {
            for (const goods of shopReply.goods_list) {
                // 不再过滤不可用的种子，而是返回给前端展示状态
                let requiredLevel: number = 0;
                for (const cond of goods.conds || []) {
                    if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
                }

                const limitCount = toNum(goods.limit_count);
                const boughtNum = toNum(goods.bought_num);
                const isSoldOut: boolean = limitCount > 0 && boughtNum >= limitCount;

                list.push({
                    seedId: toNum(goods.item_id),
                    goodsId: toNum(goods.id),
                    name: getPlantNameBySeedId(toNum(goods.item_id)),
                    price: toNum(goods.price),
                    requiredLevel,
                    locked: !goods.unlocked || state.level < requiredLevel,
                    soldOut: isSoldOut,
                });
            }
        }
    } catch (e: any) {
        const wsErr = getWsErrorState();
        if (!wsErr || Number(wsErr.code) !== 400) {
            logWarn('商店', `获取商店失败: ${e.message}，使用本地备选列表`);
        }
    }

    // 如果商店请求失败或为空，使用本地配置
    if (list.length === 0) {
        const allSeeds = getAllSeeds();
        list = allSeeds.map((s: any) => ({
            ...s,
            goodsId: 0,
            price: null, // 未知价格
            requiredLevel: null, // 未知等级
            unknownMeta: true,
            locked: false,
            soldOut: false,
        }));
    }
    return list.sort((a: any, b: any) => {
        const av = (a.requiredLevel === null || a.requiredLevel === undefined) ? 9999 : a.requiredLevel;
        const bv = (b.requiredLevel === null || b.requiredLevel === undefined) ? 9999 : b.requiredLevel;
        return av - bv;
    });
}

async function getLandsDetail(): Promise<{ lands: any[]; summary: any }> {
    try {
        const landsReply = await getAllLands();
        if (!landsReply.lands) return { lands: [], summary: {} };
        const nowSec: number = getServerTimeSec();
        const lands: any[] = [];
        const landsMap = buildLandMap(landsReply.lands);

        for (const land of landsReply.lands) {
            const id = toNum(land.id);
            const level = toNum(land.level);
            const maxLevel = toNum(land.max_level);
            const landsLevel = toNum(land.lands_level);
            const landSize = toNum(land.land_size);
            const couldUnlock = !!land.could_unlock;
            const couldUpgrade = !!land.could_upgrade;
            const {
                sourceLand,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
            } = getDisplayLandContext(land, landsMap);
            if (!land.unlocked) {
                lands.push({
                    id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster: false,
                    masterLandId: 0,
                    occupiedLandIds: [],
                    plantSize: 1,
                });
                continue;
            }
            const plant = sourceLand && sourceLand.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '空地',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const currentPhase = getCurrentPhase(plant.phases, false, '');
            if (!currentPhase) {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const phaseVal = currentPhase.phase;
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            const plantCfg = getPlantById(plantId);
            const seedId = toNum(plantCfg && plantCfg.seed_id);
            const seedImage = seedId > 0 ? getSeedImageBySeedId(seedId) : '';
            const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
            const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
            const currentSeasonRaw = toNum(plant.season);
            const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
            const phaseName = PHASE_NAMES[phaseVal] || '';
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p: any) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;
            const totalGrowTime = getPlantGrowTime(plantId);

            let landStatus = 'growing';
            if (phaseVal === PlantPhase.MATURE) landStatus = 'harvestable';
            else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';
            else if (phaseVal === PlantPhase.UNKNOWN || !plant.phases.length) landStatus = 'empty';

            const needWater = (toNum(plant.dry_num) > 0) || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec);
            const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec);
            const needBug = (plant.insect_owners && plant.insect_owners.length > 0) || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec);

            lands.push({
                id,
                unlocked: true,
                status: landStatus,
                plantName,
                seedId,
                seedImage,
                phaseName,
                currentSeason,
                totalSeason,
                matureInSec,
                totalGrowTime,
                needWater,
                needWeed,
                needBug,
                stealable: !!plant.stealable,
                level,
                maxLevel,
                landsLevel,
                landSize,
                couldUnlock,
                couldUpgrade,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize,
            });
        }

        return {
            lands,

            summary: summarizeLandDetails(lands),
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function autoPlantEmptyLands(deadLandIds: number[], emptyLandIds: number[]): Promise<any> {
    const landsToPlant: number[] = [...emptyLandIds];
    const state = getUserState();

    // 1. 铲除枯死/收获残留植物（一键操作）
    if (deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`, {
                module: 'farm', event: '铲除植物', result: 'ok', count: deadLandIds.length
            });
            landsToPlant.push(...deadLandIds);
        } catch (e: any) {
            logWarn('铲除', `批量铲除失败: ${e.message}`, {
                module: 'farm', event: '铲除植物', result: 'error'
            });
            // 失败时仍然尝试种植
            landsToPlant.push(...deadLandIds);
        }
    }

    if (landsToPlant.length === 0) return;

    const accountStrategy = String(getPlantingStrategy() || '').trim();

    // 背包种子优先策略
    if (accountStrategy === 'bag_priority') {
        let bagResult: any;
        try {
            bagResult = await plantFromBagSeeds(landsToPlant);
        } catch (e: any) {
            logWarn('种植', `读取背包种子失败，本轮跳过第二优先策略以避免误购: ${e.message}`, {
                module: 'farm',
                event: '种植种子',
                result: 'bag_load_error',
            });
            return { plantedLands: [] };
        }

        const plantedLands: number[] = bagResult.plantedLandIds || [];

        // 如果允许回退且有剩余空地，使用第二优先策略补种
        if (bagResult.fallbackAllowed && bagResult.remainingLandIds.length > 0) {
            const fallbackStrategy = getBagSeedFallbackStrategy() || 'level';
            log('种植', `开始按第二优先策略"${getPlantingStrategyLabel(fallbackStrategy)}"补种剩余空地`, {
                module: 'farm',
                event: '种植种子',
                result: 'fallback_start',
                strategy: fallbackStrategy,
                remainingCount: bagResult.remainingLandIds.length,
            });
            const shopResult = await plantFromShop(bagResult.remainingLandIds, state, fallbackStrategy);
            plantedLands.push(...(shopResult.plantedLands || []));
        }

        // 施肥
        if (plantedLands.length > 0) {
            await runFertilizerByConfig(plantedLands);
        }
        return;
    }

    // 其他策略：从商店购买种植
    const shopResult = await plantFromShop(landsToPlant, state);
    if (shopResult.plantedLands && shopResult.plantedLands.length > 0) {
        await runFertilizerByConfig(shopResult.plantedLands);
    }
}

async function plantFromShop(landsToPlant: number[], state: any, overrideStrategy?: string): Promise<any> {
    // 2. 查询种子商店
    let bestSeed: any;
    try {
        bestSeed = await findBestSeed(overrideStrategy);
    } catch (e: any) {
        logWarn('商店', `查询失败: ${e.message}`);
        return { plantedLands: [] };
    }
    if (!bestSeed) return { plantedLands: [] };

    const seedName = getPlantNameBySeedId(bestSeed.seedId);
    const growTime = getPlantGrowTime(1020000 + (bestSeed.seedId - 20000));  // 转换为植物ID
    const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
    const plantSize = getPlantSizeBySeedId(bestSeed.seedId);
    const landFootprint = plantSize * plantSize;
    log('商店', `最佳种子: ${seedName} (${bestSeed.seedId}) 价格=${bestSeed.price}金币${growTimeStr}`, {
        module: 'warehouse', event: '选择种子', seedId: bestSeed.seedId, price: bestSeed.price
    });

    // 3. 购买
    let needCount = landsToPlant.length;
    if (landFootprint > 1) {
        needCount = Math.floor(landsToPlant.length / landFootprint);
        if (needCount <= 0) {
            log('种植', `${seedName} 需要至少 ${landFootprint} 块空地才能合并种植，当前仅 ${landsToPlant.length} 块可用，已跳过`, {
                module: 'farm',
                event: '种植种子',
                result: 'skip',
                seedId: bestSeed.seedId,
                landFootprint,
                emptyCount: landsToPlant.length,
            });
            return;
        }
    }
    const totalCost = bestSeed.price * needCount;
    if (totalCost > state.gold) {
        logWarn('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${state.gold} 金币`, {
            module: 'farm', event: '购买种子跳过', result: 'insufficient_gold', need: totalCost, current: state.gold
        });
        const canBuy = Math.floor(state.gold / bestSeed.price);
        if (canBuy <= 0) return { plantedLands: [] };
        needCount = canBuy;
        log('商店', plantSize > 1 ? `金币有限，只尝试种植 ${canBuy} 组 ${plantSize}x${plantSize} 作物` : `金币有限，只种 ${canBuy} 块地`);
    }

    let actualSeedId = bestSeed.seedId;
    try {
        const buyReply = await buyGoods(bestSeed.goodsId, needCount, bestSeed.price);
        if (buyReply.get_items && buyReply.get_items.length > 0) {
            const gotItem = buyReply.get_items[0];
            const gotId = toNum(gotItem.id);
            if (gotId > 0) actualSeedId = gotId;
        }
        if (buyReply.cost_items) {
            for (const item of buyReply.cost_items) {
                state.gold -= toNum(item.count);
            }
        }
        const boughtName = getPlantNameBySeedId(actualSeedId);
        log('购买', `已购买 ${boughtName}种子 x${needCount}, 花费 ${bestSeed.price * needCount} 金币`, {
            module: 'warehouse',
            event: '购买种子',
            result: 'ok',
            seedId: actualSeedId,
            count: needCount,
            cost: bestSeed.price * needCount,
        });
    } catch (e: any) {
        logWarn('购买', e.message);
        return { plantedLands: [] };
    }

    // 4. 种植（逐块拖动，间隔50ms）
    let plantedLands: number[] = [];
    try {
        const { planted, plantedLandIds, occupiedLandIds } = await plantSeeds(actualSeedId, landsToPlant, { maxPlantCount: needCount });
        const occupiedCount = occupiedLandIds.length > 0 ? occupiedLandIds.length : planted;
        log('种植', plantSize > 1
            ? `已种植 ${planted} 组 ${plantSize}x${plantSize} 作物，占用 ${occupiedCount} 块地 (${occupiedLandIds.join(',')})`
            : `已在 ${planted} 块地种植 (${landsToPlant.slice(0, planted).join(',')})`, {
            module: 'farm',
            event: '种植种子',
            result: 'ok',
            seedId: actualSeedId,
            count: planted,
            occupiedCount,
        });
        if (planted > 0) {
            plantedLands = plantedLandIds;
        }
    } catch (e: any) {
        logWarn('种植', e.message);
    }

    return { plantedLands };
}

async function runFertilizerByConfig(plantedLands: any[] = [], options: { skipNormal?: boolean; reason?: string } = {}): Promise<{ normal: number; organic: number }> {
    const { fertilize, fertilizeOrganicLoop } = require('./api');
    const automation = getAutomation() || {};
    const fertilizerConfig = automation.fertilizer || 'none';
    const reason = String(options.reason || '').trim().toLowerCase() === 'multi_season' ? 'multi_season' : 'normal';
    const reasonLabel = reason === 'multi_season' ? '多季补肥' : '常规施肥';
    const eventName = reason === 'multi_season' ? '多季节施肥' : '常规施肥';
    const selectedLandTypes = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
    const selectedLandTypeNames = formatFertilizerLandTypes(selectedLandTypes);
    const planted: number[] = [...new Set((Array.isArray(plantedLands) ? plantedLands : []).map((v: any) => toNum(v)).filter(Boolean))];

    if (selectedLandTypes.length === 0) {
        log('施肥', `${reasonLabel}：未勾选施肥范围，跳过本轮施肥`, {
            module: 'farm',
            event: eventName,
            result: 'skip',
            reason,
            scope: 'none',
        });
        return { normal: 0, organic: 0 };
    }

    const { skipNormal = false } = options;

    if (planted.length === 0 && fertilizerConfig !== 'organic' && fertilizerConfig !== 'both' && fertilizerConfig !== 'smart') {
        return { normal: 0, organic: 0 };
    }
    let latestLands: any[] = [];
    const landTypeById = new Map<number, string>();
    try {
        const latest = await getAllLands();
        latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
        for (const land of latestLands) {
            if (!land) continue;
            const landId = toNum(land.id);
            if (!landId) continue;
            landTypeById.set(landId, getLandTypeByLevel(land.level));
        }
    } catch (e: any) {
        logWarn('施肥', `${reasonLabel}：获取土地信息失败，按已知地块继续: ${e.message}`, {
            module: 'farm',
            event: eventName,
            result: 'error',
            reason,
        });
    }

    const isAllLandTypesSelected: boolean = selectedLandTypes.length === ALL_FERTILIZER_LAND_TYPES.length;
    if (landTypeById.size === 0 && !isAllLandTypesSelected) {
        logWarn('施肥', `${reasonLabel}：无法确认土地类型，已跳过本轮施肥`, {
            module: 'farm',
            event: eventName,
            result: 'skip',
            reason,
            landTypes: selectedLandTypes,
        });
        return { normal: 0, organic: 0 };
    }

    let normalTargets: number[] = planted;
    if (landTypeById.size > 0) {
        normalTargets = filterLandIdsByTypes(planted, landTypeById, selectedLandTypes);
    }

    let fertilizedNormal: number = 0;
    let fertilizedOrganic: number = 0;

    if (!skipNormal && (fertilizerConfig === 'normal' || fertilizerConfig === 'both' || fertilizerConfig === 'smart') && normalTargets.length > 0) {
        fertilizedNormal = await fertilize(normalTargets, NORMAL_FERTILIZER_ID);
        if (fertilizedNormal > 0) {
            log('施肥', `${reasonLabel}：已为 ${fertilizedNormal}/${normalTargets.length} 块地施普通化肥（范围: ${selectedLandTypeNames.join('、')}）`, {
            module: 'farm',
            event: eventName,
            result: 'ok',
            reason,
            type: 'normal',
            count: fertilizedNormal,
            landTypes: selectedLandTypes,
        });
            recordOperation('fertilize', fertilizedNormal);
        }
    }

    if (fertilizerConfig === 'organic' || fertilizerConfig === 'both') {
        let organicTargets: number[] = planted;

        if (latestLands.length > 0) {
            organicTargets = getOrganicFertilizerTargetsFromLands(latestLands);
        }
        if (landTypeById.size > 0) {
            organicTargets = filterLandIdsByTypes(organicTargets, landTypeById, selectedLandTypes);
            }

        fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
        if (fertilizedOrganic > 0) {
            log('施肥', `${reasonLabel}：有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次（范围: ${selectedLandTypeNames.join('、')}）`, {
                module: 'farm',
                event: eventName,
                result: 'ok',
                reason,
                type: 'organic',
                count: fertilizedOrganic,
                landTypes: selectedLandTypes,
            });
            recordOperation('fertilize', fertilizedOrganic);
        }
    }
    else if (fertilizerConfig === 'smart') {
        let organicTargets: number[] = [];
        const smartSeconds = toNum(automation.fertilizer_smart_seconds) || 300;
        try {
            const latest = await getAllLands();
            organicTargets = getFastMatureLands(latest && latest.lands, smartSeconds);
        } catch (e: any) {
            logWarn('施肥', `获取全农场地块失败: ${e.message}`);
        }

        if (organicTargets.length > 0) {
            fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
            if (fertilizedOrganic > 0) {
                log('施肥', `有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次`, {
                    module: 'farm',
                    event: '施肥',
                    result: 'ok',
                    type: 'organic',
                    count: fertilizedOrganic,
                });
                recordOperation('fertilize', fertilizedOrganic);
            }
        }
    }

    return { normal: fertilizedNormal, organic: fertilizedOrganic };
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID: number = 1011;
// 有机肥料 ID
const ORGANIC_FERTILIZER_ID: number = 1012;
// 金/黑/红/普通土地类型
const ALL_FERTILIZER_LAND_TYPES: string[] = ['gold', 'black', 'red', 'normal'];

module.exports = {
    getPlantSizeBySeedId,
    plantSeeds,
    getPlantingStrategyLabel,
    sortBagSeedsForPlanting,
    plantFromBagSeeds,
    findBestSeed,
    getAvailableSeeds,
    getLandsDetail,
    autoPlantEmptyLands,
    plantFromShop,
    runFertilizerByConfig,
};
