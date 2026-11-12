export {};
/**
 * 种植引擎 - 种植策略、种子选择、自动种植、按配置施肥
 */

const protobuf = require('protobufjs');
const { performance } = require('node:perf_hooks');
const { getPlantNameBySeedId, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantBySeedId } = require('../../config/gameConfig');
const { getPreferredSeed, getAutomation, getPlantingStrategy, getBagSeedPriority, getBagSeedMultiLandReservationEnabled, getBagSeedLandTypes, getBagSeedFallbackStrategy, getPrioritize2x2Crops, getPlantDelaySeconds } = require('../../models/store');
const { PlantPhase } = require('../../config/config');
const { getUserState, getWsErrorState, sendMsgAsync } = require('../../utils/network');
const { toNum, getServerTimeSec, log, logWarn, sleep } = require('../../utils/utils');
const { types } = require('../../utils/proto');
const { getPlantRankings } = require('../analytics');
const { recordOperation } = require('../stats');
const { getBagSeeds } = require('../warehouse');
const { getCareerInfoOrNull } = require('../career');
const { getAllLands, buyGoods, removePlant, fertilizeOne } = require('./api');
const {
    selectFutureLayoutReservation,
    getRegisteredLayout,
    registerLayout,
    clearRegisteredLayout,
    resetRegisteredLayouts,
    layoutKey,
} = require('./layout-reservation');
const {
    occupantsOf,
    createReservationWindow,
    createFailureCooldown,
    buildPlantingRoundSignature,
    createPlantingRoundGate,
} = require('./reservation-window');
const {
    ALL_FERTILIZER_LAND_TYPES,
    buildLandDetail,
    buildFarmSocialEventDetails,
    analyzeLands,
    buildLandMap,
    summarizeLandDetails,
    getOrganicFertilizerTargetsFromLands,
    filterLandIdsForNormalFertilizer,
    getFastMatureLands,
    getCurrentPhase,
    pickRipen2x2Lands,
    normalizeFertilizerLandTypes,
    formatFertilizerLandTypes,
    filterLandIdsByTypes,
    getLandTypeByLevel,
    buildPlantingLayouts,
    selectNonOverlappingLayouts,
    resolveOccupiedLandIds,
} = require('./land-analysis');

interface PlantingLayout {
    anchorLandId: number;
    landIds: number[];
}

/** 同一轮种植跨种子、背包和商店共用，避免切换种子跳过间隔。 */
interface PlantingPacing {
    lastPlantAt: number | null;
    delaySeconds?: number;
    defer?: boolean;
    deferred?: boolean;
    shopSeed?: { seedId: number; strategy: string; remaining: number };
}

function getRemainingPlantDelayMs(pacing: PlantingPacing): number {
    if (pacing.lastPlantAt === null) return 0;
    return Math.max(0, Math.max(50, (pacing.delaySeconds ?? getPlantDelaySeconds()) * 1000)
        - (performance.now() - pacing.lastPlantAt));
}

function isSlicedPlanting(pacing: PlantingPacing): boolean {
    return !!pacing.defer && (pacing.delaySeconds ?? getPlantDelaySeconds()) > 0;
}

/**
 * 铲除后合并可用空地：开场已确认的空地是已知事实，服务端确认结果只能补充新释放的
 * 地块，不能反向删减（快照滞后时曾把开场空地整体抹掉，导致整轮一块都不种）。
 * 按地块 id 去重并过滤非法值；防重复下单由 plantSeeds 的服务端占地确认负责。
 */
function mergeConfirmedEmptyLands(knownEmpty: number[], confirmedEmpty: unknown): number[] {
    // toNum 只把 Long 转成 number，字符串编号会原样留下；再过一道 Number 归一化，
    // 否则 '2' 和 2 会被 Set 当成两块地，可能造成重复下单。
    return [...new Set<number>([
        ...(Array.isArray(knownEmpty) ? knownEmpty : []),
        ...(Array.isArray(confirmedEmpty) ? confirmedEmpty : []),
    ].map((id: any) => Number(toNum(id))).filter((id: number) => Number.isFinite(id) && id > 0))];
}

interface PlantSeedsResult {
    planted: number;
    plantedLandIds: number[];
    occupiedLandIds: number[];
    reservedLandIds: number[];
    uncertain: boolean;
}

const { createPlantingLogThrottle, suppressedSuffix } = require('./planting-log-throttle');

const NORMAL_FERTILIZER_ID: number = 1011;
const ORGANIC_FERTILIZER_ID: number = 1012;

interface PlantingDiagnostic {
    key: string;
    signature: string;
    message: string;
    meta: any;
}

/**
 * 一轮「背包优先种植」的诊断日志先全部缓存，收尾时合并成一条再决定要不要写面板。
 * 旧实现是三类日志各自节流、各自在 5 分钟窗口到期时重新播报，于是每个窗口开头
 * 又会同时冒出三条「同样状态重复 N 次，已合并」，看起来就像合并根本没生效。
 */
const plantingRoundThrottle = createPlantingLogThrottle();
let plantingRound: PlantingDiagnostic[] | null = null;

/**
 * 2×2 预留状态：每个账号在独立 worker 进程里跑，模块级实例天然按账号隔离。
 * - 60 秒资格窗口 + 首次预留 60 秒硬期限（服务器时钟，轮询不续期）
 * - 资格变化/到期释放并记住占用者身份，防同一停滞组合反复圈地
 * - 整轮土地状态签名不变时跳过整个种植分支（不读背包、不发商店/种植请求）
 */
const reservationWindow = createReservationWindow();
const reservationCooldown = createFailureCooldown();
const plantingRoundGate = createPlantingRoundGate();

/** 供回归测试/账号停机时复位全部跨轮状态（含已注册的 2×2 布局）。 */
function resetPlantingRoundState(): void {
    reservationWindow.clear();
    reservationCooldown.clear();
    plantingRoundGate.clear();
    plantingRoundThrottle.reset();
    // registeredLayouts 同为模块级跨轮状态，漏掉它会让新会话沿用上一个账号的布局选择。
    resetRegisteredLayouts();
}

function logPlantingThrottled(key: string, signature: string, message: string, meta: any): void {
    // 在一轮巡查内：只入队，不单独输出。
    if (plantingRound) {
        plantingRound.push({ key, signature, message, meta });
        return;
    }
    // 兜底：脱离巡查上下文调用时仍按单条节流处理。
    const decision = plantingRoundThrottle.check(key, signature);
    if (!decision.emit) return;
    log('种植', `${message}${suppressedSuffix(decision.suppressed)}`, meta);
}

/** 整轮状态签名：任何一条诊断变了都算这一轮有变化。 */
function flushPlantingRound(): void {
    const round = plantingRound;
    plantingRound = null;
    if (!round || round.length === 0) return;
    const signature = round.map(item => `${item.key}=${item.signature}`).join('\u0001');
    const decision = plantingRoundThrottle.checkStateChange('bag_planting_round', signature);
    // 状态没变化：整轮都不写前端日志面板，也不按时间窗口周期性重复播报。
    if (!decision.emit) return;
    // 一轮里可能因多个种子凑不齐布局而产生很多条，正文只带前几条，完整明细放 meta。
    const shown = round.slice(0, 5).map(item => item.message);
    const rest = round.length - shown.length;
    const message = `${shown.join('；')}${rest > 0 ? `；…等共 ${round.length} 条诊断` : ''}`;
    log('种植', `${message}${suppressedSuffix(decision.suppressed)}`, {
        module: 'farm',
        event: '种植种子',
        result: 'bag_planting_round',
        strategy: 'bag_priority',
        diagnostics: round.map(item => ({ ...item.meta, key: item.key })),
    });
}

function confirmsPlantedFootprint(
    expectedLandIds: Set<number>,
    masterLandId: number,
    occupiedLandIds: number[],
    lands: any[],
): boolean {
    if (![...expectedLandIds].every(id => occupiedLandIds.includes(id))) return false;
    const landsMap = buildLandMap(lands);
    const master = landsMap.get(masterLandId);
    return !!(master && master.plant);
}

// ============ 种植 ============

function getPlantSizeBySeedId(seedId: number | string): number {
    const plantCfg = getPlantBySeedId(toNum(seedId));
    return Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用50ms。
 * 多格作物必须传入预先选好的布局；回复占地不完整时会补拉全量土地确认。
 */
async function plantSeeds(seedId: number | string, landIds: number[], options: {
    maxPlantCount?: number;
    layouts?: PlantingLayout[];
    propagateErrors?: boolean;
    pacing?: PlantingPacing;
} = {}): Promise<PlantSeedsResult> {
    const pacing = options.pacing || { lastPlantAt: null };
    const normalizedLandIds = (Array.isArray(landIds) ? landIds : []).map((id: any) => toNum(id)).filter(Boolean);
    const maxPlantCount: number = Math.max(0, toNum(options.maxPlantCount) || 0) || Number.POSITIVE_INFINITY;
    const suppliedLayouts: PlantingLayout[] = Array.isArray(options.layouts) ? options.layouts : [];
    const layouts: PlantingLayout[] = suppliedLayouts.length > 0
        ? suppliedLayouts
            .map((layout: any) => ({
                anchorLandId: toNum(layout && layout.anchorLandId),
                landIds: [...new Set<number>((Array.isArray(layout && layout.landIds) ? layout.landIds : [])
                    .map((id: any) => toNum(id)).filter((id: number) => id > 0))],
            }))
            .filter((layout: PlantingLayout) => layout.anchorLandId > 0 && layout.landIds.length > 0)
        : normalizedLandIds.map((id: number) => ({ anchorLandId: id, landIds: [id] }));
    const requestedLayouts = layouts.slice(0, maxPlantCount);
    // 分次种植时每轮只发一个请求，剩下的交给下一轮，避免长间隔把整轮卡死。
    const selectedLayouts = isSlicedPlanting(pacing) ? requestedLayouts.slice(0, 1) : requestedLayouts;
    const plantedLandIds: number[] = [];
    const occupiedLandIds = new Set<number>();
    const reservedLandIds = new Set<number>();
    let uncertain = false;

    for (let index = 0; index < selectedLayouts.length; index++) {
        const layout = selectedLayouts[index];
        const landId = layout.anchorLandId;
        // 到配置间隔才发下一个请求；分次模式下没到点就整轮让出，留给接下来的定时续跑。
        if (pacing.lastPlantAt !== null) {
            const remainingMs = getRemainingPlantDelayMs(pacing);
            if (remainingMs > 0 && isSlicedPlanting(pacing)) {
                pacing.deferred = true;
                break;
            }
            if (remainingMs > 0) await sleep(remainingMs);
        }
        let rpcSucceeded = false;
        let resolvedMasterId = 0;
        let resolvedOccupiedIds: number[] = [];
        try {
            const body = encodePlantRequest(seedId, layout.landIds);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            pacing.lastPlantAt = performance.now();
            rpcSucceeded = true;
            const reply = types.PlantReply.decode(replyBody);
            const changedLands = Array.isArray(reply && reply.land) ? reply.land : [];
            let resolved = resolveOccupiedLandIds(landId, changedLands);
            resolvedMasterId = toNum(resolved.masterLandId) || landId;
            resolvedOccupiedIds = (Array.isArray(resolved.occupiedLandIds) ? resolved.occupiedLandIds : [])
                .map((id: any) => toNum(id)).filter(Boolean);

            const expectedIds = new Set(layout.landIds);
            let confirmed = confirmsPlantedFootprint(expectedIds, resolvedMasterId, resolvedOccupiedIds, changedLands);
            if (!confirmed) {
                try {
                    const latest = await getAllLands();
                    const latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
                    resolved = resolveOccupiedLandIds(landId, latestLands);
                    resolvedMasterId = toNum(resolved.masterLandId) || landId;
                    resolvedOccupiedIds = (Array.isArray(resolved.occupiedLandIds) ? resolved.occupiedLandIds : [])
                        .map((id: any) => toNum(id)).filter(Boolean);
                    confirmed = confirmsPlantedFootprint(expectedIds, resolvedMasterId, resolvedOccupiedIds, latestLands);
                } catch (e: any) {
                    uncertain = true;
                    logWarn('种植', `土地#${landId} 种植成功但补拉占地失败 ${e.message}`, {
                        module: 'farm', event: '种植种子', result: 'footprint_uncertain', seedId: toNum(seedId), landId
                    });
                    if (options.propagateErrors) throw e;
                }
            }

            if (!confirmed) {
                uncertain = true;
                // RPC 已成功但服务端状态无法确认：保留预期占地，避免继续请求重叠土地，
                // 但不能将其计为成功种植或交给施肥。
                for (const expectedId of layout.landIds) reservedLandIds.add(expectedId);
                logWarn('种植', `土地#${landId} 无法确认完整占地 (${resolvedOccupiedIds.join(',') || '无'})`, {
                    module: 'farm', event: '种植种子', result: 'footprint_uncertain', seedId: toNum(seedId), landId,
                    expectedLandIds: layout.landIds,
                });
                break;
            }

            plantedLandIds.push(resolvedMasterId);
            for (const occupiedId of resolvedOccupiedIds) occupiedLandIds.add(occupiedId);
            for (const expectedId of layout.landIds) reservedLandIds.add(expectedId);
        } catch (e: any) {
            uncertain = true;
            logWarn('种植', `土地#${landId} 失败: ${e.message}`, {
                module: 'farm', event: '种植种子', result: 'rpc_uncertain', seedId: toNum(seedId), landId
            });
            if (options.propagateErrors) throw e;
            break;
        }
        if (!rpcSucceeded) break;
    }
    // 还有布局没种完，说明是被间隔让出的，交给下一轮继续。
    if (!uncertain && plantedLandIds.length > 0 && selectedLayouts.length < requestedLayouts.length) {
        pacing.deferred = true;
    }
    return {
        planted: plantedLandIds.length,
        plantedLandIds: [...new Set(plantedLandIds)],
        occupiedLandIds: [...occupiedLandIds],
        reservedLandIds: [...reservedLandIds],
        uncertain,
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
    max_exp: '最大经验时',
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

/**
 * 「优先种植 2×2 作物」：开启后多格作物拥有最高种植优先级。
 * 多格作物整体排在最前，显式指定优先级的种子（优先种子 / 背包优先顺序）次之，单格作物最后。
 */
function preferMultiSizeSeeds<T extends { seedId?: any }>(seeds: T[], pinnedSeedIds: Array<number | string> = []): T[] {
    const list = Array.isArray(seeds) ? seeds : [];
    if (list.length < 2) return [...list];
    const pinned = new Set<number>(pinnedSeedIds.map(id => toNum(id)).filter(id => id > 0));
    const head: T[] = [];
    const multi: T[] = [];
    const single: T[] = [];
    for (const seed of list) {
        const seedId = toNum(seed && seed.seedId);
        if (pinned.has(seedId)) head.push(seed);
        else if (getPlantSizeBySeedId(seedId) > 1) multi.push(seed);
        else single.push(seed);
    }
    if (multi.length === 0) return [...head, ...single];
    return [...multi, ...head, ...single];
}

/**
 * 该种子允许种植的土地类型；null 表示不限制。
 * 缺配置、空数组、勾满全部类型三者等价于不限制。
 */
function resolveSeedLandTypes(bagSeedLandTypes: any, seedId: any): string[] | null {
    const raw = bagSeedLandTypes && bagSeedLandTypes[String(toNum(seedId))];
    if (!Array.isArray(raw)) return null;
    const types: string[] = normalizeFertilizerLandTypes(raw);
    if (types.length === 0 || types.length === ALL_FERTILIZER_LAND_TYPES.length) return null;
    return types;
}

/**
 * 一轮巡查的入口：开启诊断日志合并缓冲，finally 保证提前返回或抛错都能收尾。
 * 嵌套调用时沿用外层缓冲，避免把一轮拆成多条。
 */
async function plantFromBagSeeds(landsToPlant: any[], landTypeById?: Map<number, string>, options: {
    propagateErrors?: boolean;
    allUnlockedLandIds?: number[];
    lands?: any[];
    /** 手动触发的一键种植不走整轮闸门，用户重复点击必须真的重试。 */
    force?: boolean;
    pacing?: PlantingPacing;
} = {}): Promise<{
    remainingLandIds: number[];
    fallbackAllowed: boolean;
    plantedLandIds: number[];
    totalPlanted: number;
    occupiedCount: number;
    deferredLandIds: number[];
}> {
    // 整轮状态闸门：土地状态完全没变时（典型场景：2×2 只空出一部分、剩余植株还在长），
    // 直接复用上一轮的「无动作」结论，连背包/商店/种植请求都不发。
    const gateEnabled = !options.force && Array.isArray(options.lands) && options.lands.length > 0;
    const roundSignature = gateEnabled
        ? buildPlantingRoundSignature(landsToPlant, options.allUnlockedLandIds, options.lands)
        : '';
    const cached = gateEnabled ? plantingRoundGate.cached(roundSignature) : null;
    // 有等待组已经越过硬期限时必须放行，让本轮 evaluate 立刻释放空地，不能拖到 30 秒重查。
    if (cached && !reservationWindow.hasExpiredWindow(getServerTimeSec())) return { ...cached };

    const nested = plantingRound !== null;
    if (!nested) plantingRound = [];
    try {
        const result = await runPlantFromBagSeeds(landsToPlant, landTypeById, options);
        // 只缓存「本轮没有任何实际种植」的结论；有种植则立即失效，下一轮照常重算。
        // 必须透传真实结果：闸门内部按 plantedLandIds 判断是否作废缓存，
        // 手写空数组会让这条保护永远进不去，把「刚种过」也缓存满 30 秒。
        if (gateEnabled) plantingRoundGate.commit(roundSignature, result);
        return result;
    } finally {
        if (!nested) flushPlantingRound();
    }
}

async function runPlantFromBagSeeds(landsToPlant: any[], landTypeById?: Map<number, string>, options: {
    propagateErrors?: boolean;
    allUnlockedLandIds?: number[];
    lands?: any[];
    force?: boolean;
    pacing?: PlantingPacing;
} = {}): Promise<{
    remainingLandIds: number[];
    fallbackAllowed: boolean;
    plantedLandIds: number[];
    totalPlanted: number;
    occupiedCount: number;
    deferredLandIds: number[];
}> {
    const pacing = options.pacing || { lastPlantAt: null };
    const targetLandIds: number[] = [...new Set((Array.isArray(landsToPlant) ? landsToPlant : [])
        .map((id: any) => toNum(id)).filter(Boolean))];
    if (targetLandIds.length === 0) {
        return { remainingLandIds: [], fallbackAllowed: false, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0, deferredLandIds: [] };
    }

    const bagSeeds = await getBagSeeds();
    const state = getUserState();
    const priorityList = getBagSeedPriority();
    const multiLandReservationEnabled = getBagSeedMultiLandReservationEnabled();
    const explicitPrioritySeedIds = new Set<number>((Array.isArray(priorityList) ? priorityList : [])
        .map((seedId: any) => toNum(seedId))
        .filter((seedId: number) => seedId > 0));
    const allUnlockedLandIds = [...new Set<number>((Array.isArray(options.allUnlockedLandIds) ? options.allUnlockedLandIds : [])
        .map((id: any) => toNum(id))
        .filter((id: number) => id > 0))];
    const bagSeedLandTypes = getBagSeedLandTypes() || {};
    const landTypeAvailable = !!(landTypeById && landTypeById.size > 0);
    const allBagSeeds = (Array.isArray(bagSeeds) ? bagSeeds : []);
    
    const stateLevel = toNum(state && state.level);
    const filteredForLevelAndCount = allBagSeeds.map((seed: any) => ({
        seedId: seed.seedId,
        name: seed.name,
        count: toNum(seed && seed.count),
        requiredLevel: toNum(seed && seed.requiredLevel),
        plantSize: Math.max(1, toNum(seed && seed.plantSize) || getPlantSizeBySeedId(seed && seed.seedId)),
        // 拿不到土地类型时按不限制处理，避免整轮种不下去。
        landTypes: landTypeAvailable ? resolveSeedLandTypes(bagSeedLandTypes, seed && seed.seedId) : null,
        stateLevel,
    }));
    // log('种植', `背包种子原始: ${filteredForLevelAndCount.map((s: any) => `${s.name}(${s.seedId})x${s.count},lv${s.requiredLevel},size${s.plantSize}`).join('; ')}`, {
    //     module: 'farm', event: '种植种子', result: 'bag_raw', priority: priorityList, stateLevel,
    // });

    // 背包里已有的种子不再用玩家等级过滤：等级限制主要限制购买，拥有后应允许尝试种植。
    // 不可种的种子服务端会拒绝，这里记录后继续下一优先种子。
    const skippedSeeds: any[] = [];
    const levelLockedSeeds: any[] = [];
    const prioritize2x2Crops = getPrioritize2x2Crops();
    const sortedBagSeeds = sortBagSeedsForPlanting(
        filteredForLevelAndCount.filter((seed: any) => {
            if (seed.count <= 0) {
                skippedSeeds.push({ seedId: seed.seedId, name: seed.name, reason: 'count_zero', count: seed.count });
                return false;
            }
            if (seed.plantSize < 1) {
                skippedSeeds.push({ seedId: seed.seedId, name: seed.name, reason: 'invalid_size', plantSize: seed.plantSize });
                return false;
            }
            if (seed.requiredLevel > seed.stateLevel) {
                levelLockedSeeds.push({ seedId: seed.seedId, name: seed.name, requiredLevel: seed.requiredLevel, stateLevel: seed.stateLevel });
            }
            return true;
        }),
        priorityList,
    );
    const usableSeeds = prioritize2x2Crops ? preferMultiSizeSeeds(sortedBagSeeds, priorityList) : sortedBagSeeds;

    const levelLockedSeedIds = new Set<number>(levelLockedSeeds.map((s: any) => toNum(s && s.seedId)));
    if (levelLockedSeeds.length > 0) {
        // log('种植', `背包种子等级锁定但仍尝试: ${levelLockedSeeds.map((s: any) => `${s.name}(${s.seedId}) 需等级${s.requiredLevel}>当前${s.stateLevel}`).join('; ')}`, {
        //     module: 'farm', event: '种植种子', result: 'bag_seed_level_lock_try', strategy: 'bag_priority', levelLocked: levelLockedSeeds,
        // });
    }
    if (skippedSeeds.length > 0) {
        log('种植', `背包种子不可种植: ${skippedSeeds.map((s: any) => `${s.name}(${s.seedId}) ${s.reason}`).join('; ')}`, {
            module: 'farm', event: '种植种子', result: 'bag_seed_skip', strategy: 'bag_priority', skipped: skippedSeeds,
        });
    }
    // 严格按优先级列表顺序种植；限制种子无可用地块时跳过，等待下一轮。
    const plantingOrder: any[] = usableSeeds;

    if (plantingOrder.length > 0) {
        const orderedSeeds = plantingOrder.map((seed: any, index: number) => {
            const scope = seed.landTypes ? `[仅${formatFertilizerLandTypes(seed.landTypes).join('/')}]` : '';
            return `${index + 1}.${seed.name}(${seed.seedId})x${toNum(seed && seed.count)}${scope}`;
        }).join(' -> ');
        logPlantingThrottled('bag_priority_order', orderedSeeds, `背包种子执行顺序: ${orderedSeeds}`, {
            module: 'farm', event: '种植种子', result: 'bag_priority_order', strategy: 'bag_priority',
            priority: priorityList, seedIds: plantingOrder.map((seed: any) => seed.seedId),
        });
    }

    if (usableSeeds.length === 0) {
        log('种植', '背包种子已用完，准备按第二优先策略补种', {
            module: 'farm', event: '种植种子', result: 'fallback_ready', strategy: 'bag_priority'
        });
        return { remainingLandIds: targetLandIds, fallbackAllowed: true, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0, deferredLandIds: [] };
    }

    let remainingLandIds: number[] = [...targetLandIds];
    let fallbackAllowed = true;
    let totalPlanted = 0;
    const occupiedIds = new Set<number>();
    const plantedLandIds: number[] = [];
    const usedSeedLogs: string[] = [];
    const deferredLandIds = new Set<number>();
    // 每个种子每轮最多预留一组布局；各种子预留的整组目标布局互不重叠。
    const reservedSeedIds = new Set<number>();
    const claimedLayoutLandIds = new Set<number>();
    // 老版本规则：等待清空的 2×2 预留区最多一组（已完全空闲的组不占预算），
    // 避免「优先种植 2×2」把所有空地都囤起来、单格作物完全没地种。
    let waiting2x2ReservationUsed = false;

    for (const seed of plantingOrder) {
        if (remainingLandIds.length === 0 || !fallbackAllowed || pacing.deferred) break;

        const plantSize = Math.max(1, toNum(seed && seed.plantSize) || getPlantSizeBySeedId(seed.seedId));
        // 受限种子只在命中类型的空地上装箱；未命中的空地留给后续种子或第二优先策略。
        const allowedLandIds: number[] = seed.landTypes
            ? filterLandIdsByTypes(remainingLandIds, landTypeById, seed.landTypes)
            : remainingLandIds;
        const allLayouts: PlantingLayout[] = buildPlantingLayouts(allowedLandIds, plantSize);
        const layouts: PlantingLayout[] = selectNonOverlappingLayouts(allLayouts, toNum(seed.count));
        const scopeLog = seed.landTypes ? ` 限${formatFertilizerLandTypes(seed.landTypes).join('/')}=${allowedLandIds.length}` : '';
        const layoutMessage = `背包种子 ${seed.name}(${seed.seedId}) size=${plantSize} count=${seed.count} 剩余=${remainingLandIds.length}${scopeLog} allLayouts=${allLayouts.length} selected=${layouts.length}`;
        const layoutSignature = [plantSize, seed.count, remainingLandIds.length, allowedLandIds.length, allLayouts.length, layouts.length].join('|');
        logPlantingThrottled(`layout_check:${seed.seedId}`, layoutSignature, layoutMessage, {
            module: 'farm', event: '种植种子', result: 'layout_check', strategy: 'bag_priority',
            seedId: seed.seedId, plantSize, count: seed.count, emptyCount: remainingLandIds.length,
            landTypes: seed.landTypes || null, allowedCount: allowedLandIds.length,
            allLayouts: allLayouts.length, selectedLayouts: layouts.length, remainingLandIds,
        });
        if (layouts.length === 0) {
            const reason = seed.landTypes && allowedLandIds.length === 0
                ? `无${formatFertilizerLandTypes(seed.landTypes).join('/')}空地`
                : `无合法${plantSize}x${plantSize} 布局`;
            const allEligibleLandIds = seed.landTypes
                ? filterLandIdsByTypes(allUnlockedLandIds, landTypeById, seed.landTypes)
                : allUnlockedLandIds;
            // 「优先种植 2×2」开启时，多格作物凑不齐布局也要预留目标布局中已空出的地，
            // 等占着位置的单格作物成熟收获后整组清空再种 2×2（老版本 2×2 预留逻辑移植）。
            const allow2x2WaitReservation = prioritize2x2Crops
                && plantSize > 1
                && !explicitPrioritySeedIds.has(toNum(seed.seedId))
                && !waiting2x2ReservationUsed;
            const canReserve = (multiLandReservationEnabled || allow2x2WaitReservation)
                && !reservedSeedIds.has(toNum(seed.seedId))
                && plantSize > 1
                && (explicitPrioritySeedIds.has(toNum(seed.seedId)) || allow2x2WaitReservation);

            // 老版本时间闸门：只用服务端最新土地快照判定「多久能清空」。
            const nowSec = getServerTimeSec();
            const snapshotLands: any[] = Array.isArray(options.lands) ? options.lands : [];
            const landMap = buildLandMap(snapshotLands);
            const qualifyEmptyIds = new Set<number>(remainingLandIds.map((id: any) => toNum(id)));
            reservationCooldown.prune();

            const reservation = canReserve
                ? selectFutureLayoutReservation(allowedLandIds, allEligibleLandIds, plantSize, {
                    registered: getRegisteredLayout(seed.seedId),
                    excludeLandIds: claimedLayoutLandIds,
                    timeWindow: {
                        lands: snapshotLands,
                        emptyLandIds: [...qualifyEmptyIds],
                        nowSec,
                        cooldownKeys: reservationCooldown.blockedKeys(),
                    },
                })
                : null;

            // 60 秒硬期限 + 释放标记：不合格/到期/已释放的组合一律不再圈住空地，
            // 空地留在 remainingLandIds，交给后续种子或第二优先策略立即种植。
            const occupants = reservation
                ? occupantsOf(reservation.layout.landIds, landMap, qualifyEmptyIds)
                : new Map<number, string>();
            const decision = reservation
                ? reservationWindow.evaluate(String(reservation.key), occupants, nowSec)
                : null;
            if (!decision || !decision.allowed) {
                if (reservation) {
                    reservationWindow.release(String(reservation.key), occupants);
                } else if (canReserve) {
                    // 之前在等的组已经不合格：逐组释放并记住各自占用者，防资格恢复后立刻重圈。
                    for (const key of reservationWindow.activeKeys()) {
                        const ids = key.split(',').map(Number);
                        reservationWindow.release(key, occupantsOf(ids, landMap, qualifyEmptyIds));
                    }
                }
                clearRegisteredLayout(seed.seedId);
                const skipReason = !reservation
                    ? `${reason}（等待组不在 60 秒窗口内或已被 2×2 占用）`
                    : decision!.reason === 'expired'
                        ? `${reason}（60 秒等待期限已到，释放空地）`
                        : `${reason}（该组合已释放，暂不重复圈地）`;
                logPlantingThrottled(`skip_no_layout:${seed.seedId}`, [
                    reason, remainingLandIds.length, allowedLandIds.length,
                    reservation ? reservation.key : '', decision ? decision.reason : 'unqualified',
                ].join('|'), `背包种子 ${seed.name} ${skipReason}，已跳过`, {
                    module: 'farm', event: '种植种子', result: 'skip_no_layout', strategy: 'bag_priority',
                    seedId: seed.seedId, plantSize, emptyCount: remainingLandIds.length,
                    landTypes: seed.landTypes || null, allowedCount: allowedLandIds.length,
                    windowReason: decision ? decision.reason : 'unqualified',
                });
                continue;
            }

            registerLayout(seed.seedId, reservation!.layout);
            reservation!.layout.landIds.forEach((id: number) => claimedLayoutLandIds.add(toNum(id)));
            reservedSeedIds.add(toNum(seed.seedId));
            if (allow2x2WaitReservation) waiting2x2ReservationUsed = true;
            reservation!.reservedLandIds.forEach((id: number) => deferredLandIds.add(id));
            const reserved = new Set(reservation!.reservedLandIds);
            remainingLandIds = remainingLandIds.filter(id => !reserved.has(id));
            const waitSeconds = Math.max(0, Math.round(decision.deadlineSec - nowSec));
            const reserveMessage = `背包种子 ${seed.name} ${reason}，已预留空地 ${reservation!.reservedLandIds.join(',')}，等待布局 ${reservation!.layout.landIds.join(',')}（剩余期限 ${waitSeconds} 秒）`;
            const reserveSignature = [reason, reservation!.reservedLandIds.join(','), reservation!.layout.landIds.join(','), remainingLandIds.length].join('|');
            logPlantingThrottled(`reserve_future_layout:${seed.seedId}`, reserveSignature, reserveMessage, {
                module: 'farm', event: '种植种子', result: 'reserve_future_layout', strategy: 'bag_priority',
                seedId: seed.seedId, plantSize, emptyCount: remainingLandIds.length + reservation!.reservedLandIds.length,
                landTypes: seed.landTypes || null, allowedCount: allowedLandIds.length,
                reservedLandIds: reservation!.reservedLandIds,
                targetLandIds: reservation!.layout.landIds,
                clearAt: reservation!.clearAt, deadlineSec: decision.deadlineSec,
            });
            continue;
        }

        clearRegisteredLayout(seed.seedId);
        const result = await plantSeeds(seed.seedId, layouts.map(layout => layout.anchorLandId), {
            maxPlantCount: layouts.length,
            layouts,
            propagateErrors: options.propagateErrors,
            pacing,
        });
        const consumed = new Set<number>([
            ...(Array.isArray(result.reservedLandIds) ? result.reservedLandIds : []),
            ...(Array.isArray(result.occupiedLandIds) ? result.occupiedLandIds : []),
        ].map((id: any) => toNum(id)).filter(Boolean));
        consumed.forEach(id => occupiedIds.add(id));
        remainingLandIds = remainingLandIds.filter(id => !consumed.has(id));

        // 老版本失败冷却：同一布局连续种植失败时，30 秒内不再把它选为等待预留目标。
        if (result.planted <= 0) {
            layouts.forEach((layout: PlantingLayout) => reservationCooldown.mark(layoutKey(layout)));
        }

        if (result.planted > 0) {
            totalPlanted += result.planted;
            plantedLandIds.push(...result.plantedLandIds);
            usedSeedLogs.push(`${seed.name}x${result.planted}`);
            // 分次模式下种到一个就让出，剩下的等下一轮，保证间隔真的生效。
            if (!result.uncertain && remainingLandIds.length > 0 && isSlicedPlanting(pacing)) pacing.deferred = true;
        }
        
        if (result.uncertain) {
            // 等级锁定的种子尝试失败后，不应阻止第二优先策略补种其他空地。
            if (levelLockedSeedIds.has(seed.seedId)) {
                log('种植', `背包种子 ${seed.name} 为等级锁定种子，尝试失败但不阻止第二优先策略`, {
                    module: 'farm', event: '种植种子', result: 'bag_level_lock_fail_continue', seedId: seed.seedId,
                    requested: layouts.length, planted: result.planted,
                });
            } else {
                fallbackAllowed = false;
                logWarn('种植', `背包种子 ${seed.name} 的种植或占地状态不确定，为避免误购商店种子，本轮不执行第二优先策略`, {
                    module: 'farm', event: '种植种子', result: 'bag_plant_uncertain', seedId: seed.seedId,
                    requested: layouts.length, planted: result.planted
                });
            }
        }
    }

    if (usedSeedLogs.length > 0) {
        log('种植', `已按背包优先策略种植: ${usedSeedLogs.join('，')}`, {
            module: 'farm', event: '种植种子', result: 'ok', strategy: 'bag_priority', count: totalPlanted
        });
    }

    return {
        remainingLandIds,
        fallbackAllowed,
        plantedLandIds: [...new Set(plantedLandIds)],
        totalPlanted,
        occupiedCount: occupiedIds.size,
        deferredLandIds: [...deferredLandIds],
    };
}

async function findBestSeed(overrideStrategy?: string): Promise<any[]> {
    const SEED_SHOP_ID: number = 2;
    const { getShopInfo } = require('./api');
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return [];
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
            unitItemCount: Math.max(1, toNum(goods.item_count) || 1),
            maxPurchaseCount: limitCount > 0 ? Math.max(0, limitCount - boughtNum) : Number.POSITIVE_INFINITY,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return [];
    }

    // 返回完整候选序列，让调用方能按剩余土地布局逐个尝试。
    const strategy: string = overrideStrategy || getPlantingStrategy();
    const byLevelAndId = (a: any, b: any): number =>
        (b.requiredLevel - a.requiredLevel) || (a.seedId - b.seedId);
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
            const rankingBySeedId = new Map<number, number>();
            rankings.forEach((row: any, index: number) => {
                const seedId = toNum(row && row.seedId);
                const level = Number(row && row.level);
                if (seedId > 0 && (!Number.isFinite(level) || level <= state.level) && !rankingBySeedId.has(seedId)) {
                    rankingBySeedId.set(seedId, index);
                }
            });
            const ranked = available.sort((a: any, b: any) => {
                const aRank = rankingBySeedId.get(a.seedId) ?? Number.MAX_SAFE_INTEGER;
                const bRank = rankingBySeedId.get(b.seedId) ?? Number.MAX_SAFE_INTEGER;
                return (aRank - bRank) || byLevelAndId(a, b);
            });
            return getPrioritize2x2Crops() ? preferMultiSizeSeeds(ranked) : ranked;
        } catch (e: any) {
            logWarn('商店', `策略 ${strategy} 计算失败: ${e.message}，回退最高等级`);
        }
    }

    available.sort(byLevelAndId);
    const pinnedSeedIds: number[] = [];
    if (strategy === 'preferred') {
        const preferred = getPreferredSeed();
        if (preferred > 0) {
            const index = available.findIndex((candidate: any) => candidate.seedId === preferred);
            if (index >= 0) {
                available.unshift(...available.splice(index, 1));
                pinnedSeedIds.push(preferred);
            }
            else logWarn('商店', `优先种子 ${preferred} 当前不可购买，回退自动选择`);
        }
    }
    if (!getPrioritize2x2Crops()) return available;
    return preferMultiSizeSeeds(available, pinnedSeedIds);
}

async function purchaseSeed(goodsIdInput: unknown, countInput: unknown): Promise<any> {
    const goodsId = Math.floor(Number(goodsIdInput));
    const count = Math.floor(Number(countInput));
    if (!Number.isSafeInteger(goodsId) || goodsId <= 0) throw new Error('种子商品无效，请刷新后重试');
    if (!Number.isSafeInteger(count) || count <= 0 || count > 9999) throw new Error('购买数量必须是 1 到 9999 的整数');

    const { getShopInfo, buyGoods } = require('./api');
    const shopReply = await getShopInfo(2);
    const goods = (Array.isArray(shopReply.goods_list) ? shopReply.goods_list : []).find((entry: any) => toNum(entry.id) === goodsId);
    if (!goods) throw new Error('种子商品已下架，请刷新后重试');
    const state = getUserState();
    let requiredLevel = 0;
    for (const condition of goods.conds || []) {
        if (toNum(condition.type) === 1) requiredLevel = toNum(condition.param);
        if (toNum(condition.type) === 2) throw new Error('该种子需要解锁卡，暂不支持直接购买');
    }
    if (!goods.unlocked || state.level < requiredLevel) throw new Error(requiredLevel ? '未达到种子解锁等级' : '种子尚未解锁');
    const limit = toNum(goods.limit_count);
    const remaining = limit > 0 ? limit - toNum(goods.bought_num) : Number.POSITIVE_INFINITY;
    if (remaining <= 0) throw new Error('该种子已达到限购数量');
    if (count > remaining) throw new Error('购买数量超过剩余限购数量');
    const price = toNum(goods.price);
    if (price <= 0 || toNum(state.gold) < price * count) throw new Error('金币不足或商品价格无效');
    const reply = await buyGoods(goodsId, count, price);
    for (const item of reply.cost_items || []) {
        if (toNum(item.id) === 1001) state.gold = Math.max(0, toNum(state.gold) - toNum(item.count));
    }
    return reply;
}

async function getAvailableSeeds(propagateErrors: boolean = false): Promise<any[]> {
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
                let requiresUnlockCard = false;
                for (const cond of goods.conds || []) {
                    if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
                    if (toNum(cond.type) === 2) requiresUnlockCard = true;
                }

                const limitCount = toNum(goods.limit_count);
                const boughtNum = toNum(goods.bought_num);
                const isSoldOut: boolean = limitCount > 0 && boughtNum >= limitCount;

                list.push({
                    seedId: toNum(goods.item_id),
                    goodsId: toNum(goods.id),
                    name: getPlantNameBySeedId(toNum(goods.item_id)),
                    price: toNum(goods.price),
                    itemCount: Math.max(1, toNum(goods.item_count) || 1),
                    remainingPurchaseCount: limitCount > 0 ? Math.max(0, limitCount - boughtNum) : null,
                    requiredLevel,
                    requiresUnlockCard,
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
        if (propagateErrors) throw e;
    }

    // 如果商店请求失败或为空，使用本地配置
    if (list.length === 0) {
        const allSeeds = getAllSeeds();
        list = allSeeds.map((s: any) => ({
            ...s,
            goodsId: 0,
            price: null, // 未知价格
            requiredLevel: s.requiredLevel, // 使用本地配置等级
            requiresUnlockCard: false,
            unknownMeta: true,
            locked: false,
            soldOut: false,
        }));
    }
    return list.sort((a: any, b: any) => {
        const av = a.requiredLevel ?? 9999;
        const bv = b.requiredLevel ?? 9999;
        return av - bv;
    });
}

async function getLandsDetail(propagateErrors: boolean = false): Promise<{ lands: any[]; summary: any; socialEvents: any[]; career: any }> {
    let lands: any[] = [];
    let summary: any = {};
    let socialEvents: any[] = [];
    try {
        const landsReply = await getAllLands();
        socialEvents = buildFarmSocialEventDetails(landsReply);
        if (landsReply.lands) {
            const nowSec: number = getServerTimeSec();
            const landsMap = buildLandMap(landsReply.lands);
            lands = landsReply.lands.map((land: any) => buildLandDetail(land, {
                friendMode: false,
                landsMap,
                nowSec,
            }));
            summary = summarizeLandDetails(lands);
        }
    } catch (e) {
        if (propagateErrors) throw e;
        lands = [];
        summary = {};
        socialEvents = [];
    }

    return {
        lands,
        summary,
        socialEvents,
        career: await getCareerInfoOrNull(getUserState().gid, propagateErrors),
    };
}

/**
 * 解析 landId -> 土地类型。仅在配置了土地限制时才解析，未配置的账号不额外请求土地。
 * 解析不出来时返回 undefined，调用方按不限制处理。
 */
async function resolveLandTypeMapForBagSeeds(knownLands: any[]): Promise<Map<number, string> | undefined> {
    if (Object.keys(getBagSeedLandTypes() || {}).length === 0) return undefined;

    let lands: any[] = Array.isArray(knownLands) ? knownLands : [];
    if (lands.length === 0) {
        try {
            const latest = await getAllLands();
            lands = Array.isArray(latest && latest.lands) ? latest.lands : [];
        } catch (e: any) {
            logWarn('种植', `获取土地类型失败，本轮忽略背包种子的土地限制: ${e.message}`, {
                module: 'farm', event: '种植种子', result: 'land_type_error', strategy: 'bag_priority',
            });
            return undefined;
        }
    }

    const landTypeById = new Map<number, string>();
    for (const land of lands) {
        const landId = toNum(land && land.id);
        if (!landId) continue;
        landTypeById.set(landId, getLandTypeByLevel(land.level));
    }
    if (landTypeById.size === 0) {
        logWarn('种植', '无法确认土地类型，本轮忽略背包种子的土地限制', {
            module: 'farm', event: '种植种子', result: 'land_type_empty', strategy: 'bag_priority',
        });
    }
    return landTypeById;
}

async function autoPlantEmptyLands(deadLandIds: number[], emptyLandIds: number[], options: {
    propagateErrors?: boolean;
    knownLands?: any[];
    /** 手动操作跳过整轮状态闸门。 */
    force?: boolean;
    pacing?: PlantingPacing;
} = {}): Promise<any> {
    const pacing: PlantingPacing = options.pacing || { lastPlantAt: null };
    pacing.deferred = false;
    // 上一块刚种下、间隔还没到就直接让出，避免白读背包和商店。
    if ((deadLandIds.length > 0 || emptyLandIds.length > 0) && isSlicedPlanting(pacing) && getRemainingPlantDelayMs(pacing) > 0) {
        pacing.deferred = true;
        return { plantedLands: [] };
    }
    let landsToPlant: number[] = [...new Set<number>((Array.isArray(emptyLandIds) ? emptyLandIds : [])
        .map((id: any) => toNum(id)).filter((id: number) => id > 0))];
    let latestLands: any[] = Array.isArray(options.knownLands) ? options.knownLands : [];
    const state = getUserState();

    // 1. 铲除枯死/收获残留植物（一键操作），随后以服务端最新状态确认可用土地。
    if (Array.isArray(deadLandIds) && deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除${deadLandIds.length} 块(${deadLandIds.join(',')})`, {
                module: 'farm', event: '铲除植物', result: 'ok', count: deadLandIds.length
            });
            try {
                const latest = await getAllLands();
                const confirmedLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
                if (confirmedLands.length === 0) {
                    // 「成功但空快照」和抛异常一样不可信：此时若把 landsToPlant 覆盖成空，
                    // 开场已确认的真实空地会被静默抹掉，整轮一块都不种。
                    logWarn('铲除', '铲除后土地快照为空，保留开场已确认的空地', {
                        module: 'farm', event: '铲除植物', result: 'empty_snapshot'
                    });
                } else {
                    latestLands = confirmedLands;
                    // 只能补充新释放的空地，不能反向删减已知空地：铲除只会让地变空，
                    // 不会让空地变满；服务端快照滞后时并集才是安全口径。按地块 id 去重，
                    // 下游 plantSeeds 另有服务端占地确认，不会重复下单。
                    landsToPlant = mergeConfirmedEmptyLands(landsToPlant, analyzeLands(confirmedLands).empty);
                }
            } catch (e: any) {
                logWarn('铲除', `铲除后确认土地失败，保留原有空地且不使用枯死地块: ${e.message}`, {
                    module: 'farm', event: '铲除植物', result: 'confirm_error'
                });
                if (options.propagateErrors) throw e;
            }
        } catch (e: any) {
            logWarn('铲除', `批量铲除失败: ${e.message}`, {
                module: 'farm', event: '铲除植物', result: 'error'
            });
            if (options.propagateErrors) throw e;
        }
    }

    if (landsToPlant.length === 0) return { plantedLands: [] };

    const accountStrategy = String(getPlantingStrategy() || '').trim();

    // 背包种子优先策略
    if (accountStrategy === 'bag_priority') {
        let bagResult: any;
        try {
            const landTypeById = await resolveLandTypeMapForBagSeeds(latestLands);
            const allUnlockedLandIds = latestLands
                .filter((land: any) => !!(land && land.unlocked))
                .map((land: any) => toNum(land.id))
                .filter((id: number) => id > 0);
            bagResult = await plantFromBagSeeds(landsToPlant, landTypeById, {
                propagateErrors: options.propagateErrors,
                allUnlockedLandIds,
                lands: latestLands,
                force: options.force,
                pacing,
            });
        } catch (e: any) {
            logWarn('种植', `读取背包种子失败，本轮跳过第二优先策略以避免误购: ${e.message}`, {
                module: 'farm',
                event: '种植种子',
                result: 'bag_load_error',
            });
            if (options.propagateErrors) throw e;
            return { plantedLands: [] };
        }

        const plantedLands: number[] = bagResult.plantedLandIds || [];

        // 如果允许回退且有剩余空地，使用第二优先策略补种
        if (bagResult.fallbackAllowed && bagResult.remainingLandIds.length > 0 && !pacing.deferred) {
            const fallbackStrategy = getBagSeedFallbackStrategy() || 'level';
            log('种植', `开始按第二优先策略"${getPlantingStrategyLabel(fallbackStrategy)}"补种剩余空地`, {
                module: 'farm',
                event: '种植种子',
                result: 'fallback_start',
                strategy: fallbackStrategy,
                remainingCount: bagResult.remainingLandIds.length,
            });
            const shopResult = await plantFromShop(bagResult.remainingLandIds, state, fallbackStrategy, { ...options, pacing });
            plantedLands.push(...(shopResult.plantedLands || []));
        }

        // 施肥
        if (plantedLands.length > 0) {
            await runFertilizerByConfig(plantedLands, options);
        }
        return {
            plantedLands: [...new Set(plantedLands)],
            deferredLandIds: bagResult.deferredLandIds || [],
        };
    }

    // 其他策略：从商店购买种植
    const shopResult = await plantFromShop(landsToPlant, state, undefined, { ...options, pacing });
    if (shopResult.plantedLands && shopResult.plantedLands.length > 0) {
        await runFertilizerByConfig(shopResult.plantedLands, options);
    }
    return shopResult;
}

async function plantFromShop(landsToPlant: number[], state: any, overrideStrategy?: string, options: { propagateErrors?: boolean; pacing?: PlantingPacing } = {}): Promise<any> {
    const pacing = options.pacing || { lastPlantAt: null };
    if (pacing.deferred || (isSlicedPlanting(pacing) && getRemainingPlantDelayMs(pacing) > 0)) {
        pacing.deferred = true;
        return { plantedLands: [], remainingLandIds: [...landsToPlant], uncertain: false };
    }
    let remainingLandIds: number[] = [...new Set<number>((Array.isArray(landsToPlant) ? landsToPlant : [])
        .map((id: any) => toNum(id)).filter((id: number) => id > 0))];
    const plantedLands: number[] = [];
    let uncertain = false;
    const strategyKey = `${getPlantingStrategy()}:${overrideStrategy || ''}:${getPreferredSeed()}`;
    if (pacing.shopSeed?.strategy !== strategyKey) delete pacing.shopSeed;
    // 分次种植可能留下已购的一包种子。即使商品已售罄，也先核对背包后使用余量。
    if (pacing.shopSeed) {
        const seedId = pacing.shopSeed.seedId;
        const bag = await getBagSeeds();
        const count = Math.min(pacing.shopSeed.remaining, toNum(bag.find((seed: any) => toNum(seed.seedId) === seedId)?.count));
        const layouts = selectNonOverlappingLayouts(buildPlantingLayouts(remainingLandIds, getPlantSizeBySeedId(seedId)), count);
        if (layouts.length > 0) {
            const result = await plantSeeds(seedId, layouts.map((layout: PlantingLayout) => layout.anchorLandId), {
                layouts, pacing, propagateErrors: options.propagateErrors,
            });
            plantedLands.push(...result.plantedLandIds);
            const consumed = new Set([...result.reservedLandIds, ...result.occupiedLandIds]);
            remainingLandIds = remainingLandIds.filter(id => !consumed.has(id));
            pacing.shopSeed.remaining = count - result.planted;
            if (result.uncertain || pacing.shopSeed.remaining <= 0) delete pacing.shopSeed;
            if (result.uncertain || remainingLandIds.length === 0) return { plantedLands, remainingLandIds, uncertain: result.uncertain };
            if (isSlicedPlanting(pacing) || pacing.deferred) {
                pacing.deferred = true;
                return { plantedLands, remainingLandIds, uncertain: false };
            }
        }
        delete pacing.shopSeed;
    }
    let candidates: any[] = [];
    try {
        candidates = await findBestSeed(overrideStrategy);
    } catch (e: any) {
        logWarn('商店', `查询失败: ${e.message}`);
        if (options.propagateErrors) throw e;
        return { plantedLands, remainingLandIds, uncertain: true };
    }
    if (candidates.length === 0) return { plantedLands, remainingLandIds, uncertain: false };

    for (const candidate of candidates) {
        if (remainingLandIds.length === 0 || uncertain || pacing.deferred) break;
        const seedName = getPlantNameBySeedId(candidate.seedId);
        const plantCfg = getPlantBySeedId(candidate.seedId);
        const plantSize = getPlantSizeBySeedId(candidate.seedId);
        const growTime = plantCfg ? getPlantGrowTime(plantCfg.id) : 0;
        const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
        const allLayouts: PlantingLayout[] = buildPlantingLayouts(remainingLandIds, plantSize);
        let layouts: PlantingLayout[] = selectNonOverlappingLayouts(allLayouts, allLayouts.length);
        if (layouts.length === 0) {
            log('种植', `${seedName} 无合法${plantSize}x${plantSize} 布局，继续下一候选`, {
                module: 'farm', event: '种植种子', result: 'skip_no_layout', seedId: candidate.seedId,
                plantSize, emptyCount: remainingLandIds.length
            });
            continue;
        }

        // 分次模式下先只种一个，剩下的连同刚买的余量留给下一轮。
        if (isSlicedPlanting(pacing)) layouts = layouts.slice(0, 1);

        const unitItemCount = Math.max(1, toNum(candidate.unitItemCount) || 1);
        const requiredSeedCount = layouts.length;
        const requiredPurchaseUnits = Math.ceil(requiredSeedCount / unitItemCount);
        const maxPurchaseUnits = Number(candidate.maxPurchaseCount);
        const affordablePurchaseUnits = Math.floor(Math.max(0, toNum(state && state.gold)) / candidate.price);
        const purchaseUnits = Math.min(
            requiredPurchaseUnits,
            Number.isFinite(maxPurchaseUnits) ? maxPurchaseUnits : requiredPurchaseUnits,
            affordablePurchaseUnits,
        );
        if (purchaseUnits <= 0) {
            logWarn('商店', `金币或限购额度不足，无法购买 ${seedName} 种子，继续下一候选`, {
                module: 'farm', event: '购买种子跳过', result: 'insufficient_gold_or_limit',
                seedId: candidate.seedId, price: candidate.price, current: toNum(state && state.gold)
            });
            continue;
        }
        let needCount = Math.min(requiredSeedCount, purchaseUnits * unitItemCount);
        layouts = layouts.slice(0, needCount);
        if (needCount < requiredSeedCount) {
            log('商店', plantSize > 1
                ? `金币或限购额度有限，只尝试种植${needCount} 组${plantSize}x${plantSize} 作物`
                : `金币或限购额度有限，只种 ${needCount} 块地`);
        }

        log('商店', `选择种子: ${seedName} (${candidate.seedId}) 价格=${candidate.price}金币${growTimeStr}`, {
            module: 'warehouse', event: '选择种子', seedId: candidate.seedId, price: candidate.price,
            count: needCount, purchaseUnits, unitItemCount
        });

        let actualSeedId = candidate.seedId;
        let receivedSeedCount = purchaseUnits * unitItemCount;
        try {
            const buyReply = await buyGoods(candidate.goodsId, purchaseUnits, candidate.price);
            if (buyReply.get_items && buyReply.get_items.length > 0) {
                const gotItem = buyReply.get_items[0];
                const gotId = toNum(gotItem && gotItem.id);
                const gotCount = toNum(gotItem && gotItem.count);
                if (gotId > 0) actualSeedId = gotId;
                if (gotCount > 0) receivedSeedCount = gotCount;
                if (gotCount > 0 && gotCount < needCount) {
                    needCount = gotCount;
                    layouts = layouts.slice(0, needCount);
                }
            }
            if (buyReply.cost_items) {
                for (const item of buyReply.cost_items) state.gold -= toNum(item.count);
            }
            log('购买', `已购买${getPlantNameBySeedId(actualSeedId)}种子 x${purchaseUnits * unitItemCount}, 花费 ${candidate.price * purchaseUnits} 金币`, {
                module: 'warehouse', event: '购买种子', result: 'ok', seedId: actualSeedId,
                count: purchaseUnits * unitItemCount, purchaseUnits, cost: candidate.price * purchaseUnits
            });
        } catch (e: any) {
            logWarn('购买', `${seedName} 购买结果不确定，停止后续购买: ${e.message}`, {
                module: 'warehouse', event: '购买种子', result: 'purchase_uncertain', seedId: candidate.seedId
            });
            if (options.propagateErrors) throw e;
            uncertain = true;
            break;
        }

        const result = await plantSeeds(actualSeedId, layouts.map(layout => layout.anchorLandId), {
            maxPlantCount: needCount,
            layouts,
            propagateErrors: options.propagateErrors,
            pacing,
        });
        plantedLands.push(...result.plantedLandIds);
        const consumed = new Set<number>([
            ...result.reservedLandIds,
            ...result.occupiedLandIds,
        ].map((id: any) => toNum(id)).filter((id: number) => id > 0));
        remainingLandIds = remainingLandIds.filter(id => !consumed.has(id));
        log('种植', plantSize > 1
            ? `已种植${result.planted} 组${plantSize}x${plantSize} 作物，占用${result.occupiedLandIds.length} 块地 (${result.occupiedLandIds.join(',')})`
            : `已在 ${result.planted} 块地种植 (${result.plantedLandIds.join(',')})`, {
            module: 'farm', event: '种植种子', result: result.uncertain ? 'uncertain' : 'ok',
            seedId: actualSeedId, count: result.planted, occupiedCount: result.occupiedLandIds.length
        });
        if (result.uncertain) {
            uncertain = true;
            logWarn('种植', `${seedName} 种植或占地状态不确定，停止后续购买`, {
                module: 'farm', event: '种植种子', result: 'plant_uncertain', seedId: actualSeedId
            });
        } else if (pacing.defer) {
            // 买到的种子没用完，记下余量，下一轮先花背包里的，避免重复购买。
            if (receivedSeedCount > result.planted) pacing.shopSeed = { seedId: actualSeedId, strategy: strategyKey, remaining: receivedSeedCount - result.planted };
            if (isSlicedPlanting(pacing) && result.planted > 0 && remainingLandIds.length > 0) pacing.deferred = true;
        }
    }

    return { plantedLands: [...new Set(plantedLands)], remainingLandIds, uncertain };
}

async function runFertilizerByConfig(plantedLands: any[] = [], options: { skipNormal?: boolean; reason?: string; propagateErrors?: boolean } = {}): Promise<{ normal: number; organic: number }> {
    const { fertilize, fertilizeOrganicLoop } = require('./api');
    const automation = getAutomation() || {};
    const fertilizerConfig = automation.fertilizer || 'none';
    // 老版 2x2 催熟：开启后与施肥策略独立 —— 即使策略为「不施肥」，也会对生长中的
    // 2×2 作物先施一次普通肥、再连续施有机肥直至成熟。
    const ripenSize2 = automation.fertilizer_2x2_ripen === true;
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

    if (fertilizerConfig === 'none' && !ripenSize2) {
        log('施肥', `${reasonLabel}：当前施肥策略为不施肥，跳过`, {
            module: 'farm',
            event: eventName,
            result: 'skip',
            reason,
            type: 'none',
        });
        return { normal: 0, organic: 0 };
    }

    if (!ripenSize2 && planted.length === 0 && fertilizerConfig !== 'organic' && fertilizerConfig !== 'both' && fertilizerConfig !== 'smart') {
        log('施肥', `${reasonLabel}：没有可施肥地块，跳过`, {
            module: 'farm',
            event: eventName,
            result: 'skip',
            reason,
            count: 0,
        });
        return { normal: 0, organic: 0 };
    }
    // 每次施肥都重新读地：施肥前后地块状态会变，复用巡田快照会把「刚施过」
    // 当成「还没施」，多季补肥与 smart 判断都会跟着错。
    let latestLands: any[] = [];
    const landTypeById = new Map<number, string>();
    try {
        const latest = await getAllLands();
        latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
    } catch (e: any) {
        logWarn('施肥', `${reasonLabel}：获取土地信息失败，按已知地块继续 ${e.message}`, {
            module: 'farm',
            event: eventName,
            result: 'error',
            reason,
        });
        if (options.propagateErrors) throw e;
    }
    for (const land of latestLands) {
        if (!land) continue;
        const landId = toNum(land.id);
        if (!landId) continue;
        landTypeById.set(landId, getLandTypeByLevel(land.level));
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

    // ── 2x2 催熟（老版 farm-fertilizer 移植）──
    // 识别 2×2 作物主地块（排除从属地块），从常规施肥目标中剔除后单独催熟，
    // 避免普通肥只落在合种作物的其中一个地块上。
    let size2NormalCount: number = 0;
    let size2OrganicCount: number = 0;
    let size2Targets: number[] = [];
    let excludedIds = new Set<number>();
    if (ripenSize2) {
        const { size2LandIds, excludedIds: ripenExcluded } = pickRipen2x2Lands(latestLands);
        excludedIds = ripenExcluded;
        normalTargets = normalTargets.filter((id: number) => !excludedIds.has(id));

        const explicitSet = new Set(planted);
        const landsMap = buildLandMap(latestLands);
        size2Targets = filterLandIdsByTypes(size2LandIds
            .filter((landId: number) => {
                if (explicitSet.size > 0 && !explicitSet.has(landId)) return false;
                const land = landsMap.get(landId);
                const plant = land && land.plant;
                const phase = plant && getCurrentPhase(plant.phases, false, '', toNum(plant.id));
                return phase && phase.phase >= PlantPhase.SEED && phase.phase < PlantPhase.MATURE;
            }), landTypeById, selectedLandTypes);

        if (size2Targets.length > 0) {
            try {
                const normalCandidates = size2Targets.filter((id: number) => {
                    const land = landsMap.get(id);
                    const plant = land && land.plant;
                    if (!plant) return true;
                    return !Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times') || toNum(plant.left_inorc_fert_times) > 0;
                });
                size2NormalCount = normalCandidates.length > 0
                    ? await fertilize(normalCandidates, NORMAL_FERTILIZER_ID, options.propagateErrors)
                    : 0;
                // 逐块循环，避免某块地成熟或失败后打断其余 2x2 作物的催熟。
                for (const landId of size2Targets) {
                    size2OrganicCount += await fertilizeOrganicLoop([landId], { ripenSize2: true });
                }
                const count = size2NormalCount + size2OrganicCount;
                if (count > 0) {
                    recordOperation('fertilize', count);
                    log('施肥', `2x2催熟：普通肥 ${size2NormalCount} 次，有机肥 ${size2OrganicCount} 次`, {
                        module: 'farm', event: '2x2催熟', result: 'ok', reason, count, landIds: size2Targets, landTypes: selectedLandTypes,
                    });
                }
            } catch (e: any) {
                logWarn('施肥', `2x2催熟失败: ${e && e.message ? e.message : e}`, {
                    module: 'farm', event: '2x2催熟', result: 'error', landIds: size2Targets,
                });
                if (options.propagateErrors) throw e;
            }
        }
    }
    if (latestLands.length > 0 && normalTargets.length > 0) {
        const filtered = filterLandIdsForNormalFertilizer(normalTargets, latestLands);
        if (filtered.length !== normalTargets.length) {
            log('施肥', `${reasonLabel}：按普通肥剩余次数筛掉 ${normalTargets.length - filtered.length} 块（还可施 ${filtered.length} 块）`, {
                module: 'farm',
                event: eventName,
                result: 'skip',
                reason,
                type: 'normal',
                count: filtered.length,
                skipped: normalTargets.length - filtered.length,
            });
        }
        normalTargets = filtered;
    }

    let fertilizedNormal: number = 0;
    let fertilizedOrganic: number = 0;

    if (!skipNormal && (fertilizerConfig === 'normal' || fertilizerConfig === 'both' || fertilizerConfig === 'smart')) {
        if (normalTargets.length === 0) {
            log('施肥', `${reasonLabel}：普通化肥目标为空（传入 ${planted.length} 块，范围: ${selectedLandTypeNames.join('、')}），跳过普通施肥`, {
                module: 'farm',
                event: eventName,
                result: 'skip',
                reason,
                type: 'normal',
                count: 0,
                landTypes: selectedLandTypes,
            });
        } else {
        fertilizedNormal = await fertilize(normalTargets, NORMAL_FERTILIZER_ID, options.propagateErrors);
        if (fertilizedNormal > 0) {
            log('施肥', `${reasonLabel}：已为${fertilizedNormal}/${normalTargets.length} 块地施普通化肥（范围: ${selectedLandTypeNames.join('、')}）`, {
            module: 'farm',
            event: eventName,
            result: 'ok',
            reason,
            type: 'normal',
            count: fertilizedNormal,
            landTypes: selectedLandTypes,
        });
            recordOperation('fertilize', fertilizedNormal);
            } else {
                log('施肥', `${reasonLabel}：普通化肥施肥 0/${normalTargets.length} 块（可能化肥不足或地块不可施）`, {
                    module: 'farm',
                    event: eventName,
                    result: 'skip',
                    reason,
                    type: 'normal',
                    count: 0,
                    landTypes: selectedLandTypes,
                });
            }
        }
    }

    if (fertilizerConfig === 'organic' || fertilizerConfig === 'both') {
        let organicTargets: number[] = planted;

        if (latestLands.length > 0) {
            organicTargets = getOrganicFertilizerTargetsFromLands(latestLands);
        }
        if (reason === 'multi_season' && planted.length > 0) {
            const plantedSet = new Set(planted);
            organicTargets = organicTargets.filter(id => plantedSet.has(id));
        }
        // 2×2 作物已由催熟流程单独处理，这里不再重复施有机肥。
        organicTargets = organicTargets.filter(id => !excludedIds.has(id));
        if (landTypeById.size > 0) {
            organicTargets = filterLandIdsByTypes(organicTargets, landTypeById, selectedLandTypes);
            }

        fertilizedOrganic = await fertilizeOrganicLoop(organicTargets, options.propagateErrors);
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
        // 快成熟判定使用配置的固定秒数（默认 300，巡查周期变长时仍能保证催熟命中、缩短成熟后等待收获的被偷窗口），每轮按同一临界点判断。
        const smartSeconds = toNum(automation.fertilizer_smart_seconds) || 300;
        try {
            // smart 要先补普通肥，再按最新状态挑快成熟的地块，必须重新读一次。
            const latest = await getAllLands();
            organicTargets = getFastMatureLands(latest && latest.lands, smartSeconds);
        } catch (e: any) {
            logWarn('施肥', `获取全农场地块失败 ${e.message}`);
            if (options.propagateErrors) throw e;
        }

        // 2×2 主地块已由上面的催熟流程单独施过有机肥，这里排除，避免重复施肥与重复计数。
        if (excludedIds.size > 0) {
            organicTargets = organicTargets.filter((id: number) => !excludedIds.has(id));
        }
        if (organicTargets.length > 0) {
            fertilizedOrganic = await fertilizeOrganicLoop(organicTargets, options.propagateErrors);
            if (fertilizedOrganic > 0) {
                log('施肥', `有机化肥循环施肥完成，共施${fertilizedOrganic} 次`, {
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

    // 2×2 催熟结果必须一并带出：scheduler 依赖返回值决定是否立刻收获刚催熟的地块。
    // normalTargets（1367 行）与 organicTargets（1478 行）都已排除 excludedIds（2×2 主地块），
    // 因此 fertilizedNormal/Organic 与 size2 计数互斥，相加不会重复计数。
    return {
        normal: fertilizedNormal + size2NormalCount,
        organic: fertilizedOrganic + size2OrganicCount,
    };
}

async function fertilizeOwnLand(landIdInput: unknown, fertilizerTypeInput: unknown): Promise<any> {
    const landId = toNum(landIdInput);
    if (!landId || landId <= 0) {
        throw new Error('地块编号无效');
    }

    const fertilizerType = String(fertilizerTypeInput || '').trim().toLowerCase();
    if (fertilizerType !== 'normal' && fertilizerType !== 'organic') {
        throw new Error('化肥类型必须是 normal 或 organic');
    }

    const fertilizerId = fertilizerType === 'organic' ? ORGANIC_FERTILIZER_ID : NORMAL_FERTILIZER_ID;
    const typeName = fertilizerType === 'organic' ? '有机化肥' : '普通化肥';
    let reply: any;
    try {
        reply = await fertilizeOne(landId, fertilizerId);
    }
    catch (error: any) {
        if (error?.name === 'GatewayError'
            || typeof error?.errorMessage === 'string'
            || typeof error?.error_message === 'string'
            || /^(?:[\w-]+\.)+[\w-]+(?:\s+(?:\S.*?)??)?\bcode=\d+(?:\s|$)/.test(String(error?.message || '').trim())) {
            throw error;
        }
        const message = String(error?.message || '').trim() || `${typeName}使用失败`;
        throw new Error(message);
    }
    const replyLands = Array.isArray(reply && reply.land) ? reply.land : [];
    const updatedRaw = replyLands.find((land: any) => toNum(land?.id) === landId) || replyLands[0] || null;
    const nowSec = getServerTimeSec();
    const landsMap = updatedRaw ? buildLandMap([updatedRaw]) : new Map();
    const updatedLand = updatedRaw
        ? buildLandDetail(updatedRaw, { friendMode: false, landsMap, nowSec })
        : null;
    const fertilizerRemainingSec = toNum(reply?.fertilizer?.count);

    recordOperation('fertilize', 1);
    log('施肥', `手动施肥：第 ${landId} 块地已施${typeName}`, {
        module: 'farm',
        event: '手动施肥',
        result: 'ok',
        type: fertilizerType,
        landId,
        remainingSec: fertilizerRemainingSec,
    });

    return {
        landId,
        fertilizerType,
        fertilizerRemainingSec,
        updatedLand,
    };
}

module.exports = {
    getRemainingPlantDelayMs,
    mergeConfirmedEmptyLands,
    getPlantSizeBySeedId,
    plantSeeds,
    getPlantingStrategyLabel,
    sortBagSeedsForPlanting,
    resolveSeedLandTypes,
    plantFromBagSeeds,
    findBestSeed,
    getAvailableSeeds,
    purchaseSeed,
    getLandsDetail,
    autoPlantEmptyLands,
    plantFromShop,
    runFertilizerByConfig,
    fertilizeOwnLand,
    resetPlantingRoundState,
};
