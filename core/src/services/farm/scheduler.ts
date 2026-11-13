export {};
/**
 * 农场循环调度 - 循环管理、可变状态
 */

const { CONFIG } = require('../../config/config');
const { getPlantById, getItemById } = require('../../config/gameConfig');
const { isAutomationOn, getAutomation, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../../models/store');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, log, logWarn, logFileOnly, isTransientGatewaySkip, randomDelay } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { recordOperation } = require('../stats');
const { getAllLands, harvest, farming, unlockLand, upgradeLand } = require('./api');
const {
    analyzeLands,
    getCleanableFarmSocialEventItemIds,
    getNormalFertilizerTargetsFromLands,
    resolveRemovableHarvestedLands,
    getLandTypeByLevel,
    normalizeFertilizerLandTypes,
    filterLandIdsByTypes,
    ALL_FERTILIZER_LAND_TYPES,
} = require('./land-analysis');
const { autoPlantEmptyLands, getRemainingPlantDelayMs, runFertilizerByConfig } = require('./planting');
const { checkAndBuyFertilizerBoth } = require('../mall');
const ownMaturity = require('./own-maturity');
// 延迟加载以打破循环依赖: visit-strategy → farm/index → scheduler → visit-strategy
function inFarmQuietHours() {
    return require('../friend/visit-strategy').inFarmQuietHours();
}

// ============ 内部状态 ============
let isCheckingFarm: boolean = false;
let isFirstFarmCheck: boolean = true;
let farmLoopRunning: boolean = false;
let externalSchedulerMode: boolean = false;
let farmLoopGeneration: number = 0;
let automaticPlantPacing: any = { lastPlantAt: null, defer: true };
const farmScheduler = createScheduler('farm');
// 两类推送各自节流：以前共用一个节流时间戳和一个 farm_push_check 计时器，
// 土地推送会把同时到达的社交事件推送直接挤掉（同名计时器会先 clear 旧的）。
let lastLandsPushTime: number = 0;
let lastSocialPushTime: number = 0;
// 自动巡田的整轮软预算：超过就停在阶段边界，剩余动作交下一轮，
// 不让一次慢请求 / 长施肥循环把整条自动化链路无限期占住。
const FARM_ROUND_BUDGET_MS = 5 * 60 * 1000;

// ============ 农场循环 ============

function canContinueFarm(generation: number): boolean {
    return generation === farmLoopGeneration
        && !!getUserState().gid && isAutomationOn('farm') && !inFarmQuietHours();
}

function schedulePlantContinuation(generation: number, pacing: any): void {
    if (!farmLoopRunning || !canContinueFarm(generation) || pacing !== automaticPlantPacing || !pacing.deferred) return;
    // 延迟只能由「配置种植间隔 - 本轮已耗时」决定，外部刷新不得覆盖。
    farmScheduler.setTimeoutTask('farm_plant_continue', getRemainingPlantDelayMs(pacing), async () => {
        // 计时器会继承创建时的异步上下文，必须独立入队，不能当作旧锁的重入。
        await runExclusiveAutomationTask('farm_plant_continue', async () => {
            if (!farmLoopRunning || !canContinueFarm(generation) || pacing !== automaticPlantPacing) return;
            await checkFarm();
        }, { detached: true });
    });
}

async function checkFarm(): Promise<boolean> {
    const state = getUserState();
    if (isCheckingFarm || !state.gid || !isAutomationOn('farm')) return false;
    if (inFarmQuietHours()) return false;
    const generation = farmLoopGeneration;
    const pacing = automaticPlantPacing;
    // 本轮开头会清掉待触发的分次种植续跑。若本轮没走到种植决策（异常/让路/
    // 空快照），清掉后必须在 finally 按原剩余间隔接回，否则剩余地块要等下一次
    // 20~25s 常规巡查，配置的种植间隔形同虚设。
    const hadPendingContinuation = farmScheduler.has('farm_plant_continue');
    farmScheduler.clear('farm_plant_continue');
    pacing.deferred = false;
    pacing.plantingResolved = false;
    isCheckingFarm = true;

    try {
        // 复用手动操作逻辑
        const result = await runFarmOperation('all', null, false, {
            generation,
            pacing,
            deadlineMs: Date.now() + FARM_ROUND_BUDGET_MS,
        });
        isFirstFarmCheck = false;
        return !!(result && result.hadWork);
    } catch (err: any) {
        if (isTransientGatewaySkip(err)) {
            // 不是业务失败，只是这一轮自动任务给前台/心跳让路：不进前端日志，下一轮按正常间隔重试。
            logFileOnly('巡田', `本轮让路: ${err.message}`);
            return false;
        }
        logWarn('巡田', `检查失败: ${err.message}`);
        return false;
    } finally {
        isCheckingFarm = false;
        // 只有「本轮确实走到了种植决策」才相信 pacing.deferred；否则把进入本轮时
        // 被清掉的续跑接回。剩余间隔为 0 时不重排，交给常规 tick，避免 0ms 空转。
        if (hadPendingContinuation && !pacing.plantingResolved
            && farmLoopRunning && canContinueFarm(generation)
            && pacing === automaticPlantPacing
            && getRemainingPlantDelayMs(pacing) > 0) {
            pacing.deferred = true;
        }
        schedulePlantContinuation(generation, pacing);
    }
}

async function runMultiSeasonFertilizer(growingLandIds: any[], propagateErrors: boolean = false): Promise<void> {
    if (!isAutomationOn('fertilizer_multi_season')) return;
    const multiSeasonTargets: number[] = [...new Set(
        (Array.isArray(growingLandIds) ? growingLandIds : []).map((v: any) => toNum(v)).filter(Boolean),
    )];
    if (multiSeasonTargets.length === 0) return;

    log('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonTargets.length} 块`, {
        module: 'farm',
        event: '多季节施肥',
        result: 'trigger',
        count: multiSeasonTargets.length,
        landIds: multiSeasonTargets,
    });
    try {
        await runFertilizerByConfig(multiSeasonTargets, { reason: 'multi_season', propagateErrors });
    } catch (e: any) {
        logWarn('施肥', `多季补肥执行失败: ${e.message}`, {
            module: 'farm',
            event: '多季节施肥',
            result: 'error',
        });
        if (propagateErrors) throw e;
    }
}

function autoHarvestLandIds(status: any): number[] {
    if (getAutomation().farm_harvest_tiangong !== false) return status.harvestable;
    const tiangongLandIds = new Set(status.harvestableInfo
        .filter((info: any) => Number(getItemById(getPlantById(info.plantId)?.seed_id)?.rarity) === 4)
        .map((info: any) => info.landId));
    return status.harvestable.filter((id: number) => !tiangongLandIds.has(id));
}

/**
 * smart 有机肥可能让作物在本轮成熟。施肥后只重查并收获一次，避免形成请求循环。
 * 跟随收获也会走多季补肥：这批作物进入下一季后，主循环里的补肥已经跑完了。
 */
async function harvestMatureOwnLandsOnce(actions: string[], propagateErrors: boolean = false): Promise<number> {
    let latest: any;
    try {
        latest = await getAllLands();
    } catch (e: any) {
        logWarn('收获', `施肥后刷新土地失败: ${e.message}`);
        if (propagateErrors) throw e;
        return 0;
    }

    const lands = Array.isArray(latest && latest.lands) ? latest.lands : [];
    if (lands.length === 0) return 0;

    const ownGid = toNum(getUserState().gid);
    const harvestable = autoHarvestLandIds(analyzeLands(lands, false, ownGid));
    if (harvestable.length === 0) return 0;

    try {
        const harvestReply = await harvest(harvestable);
        actions.push(`施肥后收获${harvestable.length}`);
        recordOperation('harvest', harvestable.length);
        networkEvents.emit('farmHarvested', {
            count: harvestable.length,
            landIds: [...harvestable],
            opType: 'fertilizer_followup',
        });
        // 宠物资本模式：施肥后跟随收获同样触发召回。
        try {
            require('../capital-mode').handleFarmHarvested();
        } catch (e: any) {
            logWarn('宠物', `资本模式召回调度失败: ${e?.message || e}`);
        }
        log('收获', `施肥后立即收获 ${harvestable.length} 块土地`, {
            module: 'farm',
            event: '施肥后收获作物',
            result: 'ok',
            count: harvestable.length,
            landIds: [...harvestable],
        });
        const classified = await resolveRemovableHarvestedLands(harvestable, harvestReply);
        await runMultiSeasonFertilizer(classified.growing, propagateErrors);
        return harvestable.length;
    } catch (e: any) {
        logWarn('收获', `施肥后立即收获失败: ${e.message}`, {
            module: 'farm',
            event: '施肥后收获作物',
            result: 'error',
        });
        if (propagateErrors) throw e;
        return 0;
    }
}

/**
 * 手动/自动执行农场操作
 * @param opType - 'all', 'harvest', 'clear', 'plant', 'upgrade'
 */
async function runFarmOperation(
    opType: string,
    targetLandIdInput: unknown = null,
    propagateErrors: boolean = false,
    automatic?: { generation: number; pacing: any; deadlineMs?: number },
): Promise<{ hadWork: boolean; actions: string[] }> {
    const roundDeadlineMs = Number(automatic && automatic.deadlineMs) || 0;
    // 只在阶段边界检查，不打断已经发出去的单个请求；超预算时登记一次提前唤醒，
    // 剩余动作交给下一轮，避免「本轮做不完、又等 20~25 秒」的叠加延迟。
    const overBudget = (): boolean => {
        if (!roundDeadlineMs || Date.now() <= roundDeadlineMs) return false;
        logWarn('巡田', '本轮已超过整轮时间预算，剩余阶段留到下一轮', {
            module: 'farm', event: '农场循环', result: 'budget_exceeded',
        });
        ownMaturity.requestFarmWakeup('budget_exceeded');
        return true;
    };
    const landsReply = await getAllLands();
    // 这一轮已经被停掉或账号换了代次，就别再动任何土地。
    if (automatic && !canContinueFarm(automatic.generation)) return { hadWork: false, actions: [] };
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all') {
            log('农场', '没有土地数据');
        }
        return { hadWork: false, actions: [] };
    }

    const lands = landsReply.lands;
    // 整片土地快照是自家成熟时间的权威来源：记录下一块作物的成熟墙钟，
    // worker 据此把 nextFarmRunAt 提前到成熟点，不必再白等半个轮询周期。
    ownMaturity.observeOwnFarmMaturity(lands, 'round');

    const state = getUserState();
    const status = analyzeLands(lands, isFirstFarmCheck, state.gid);
    // 宠物资本模式：临近成熟时先派出守护宠物（老版逻辑）。
    try {
        await require('../capital-mode').prepareForFarmOperation({ lands, analysis: status, opType });
    } catch (e: any) {
        logWarn('宠物', `资本模式派出检查失败: ${e?.message || e}`);
    }
    const socialEventItemIds: number[] = getCleanableFarmSocialEventItemIds(landsReply);
    const hasTargetLandId = targetLandIdInput !== null
        && targetLandIdInput !== undefined
        && String(targetLandIdInput).trim() !== '';
    const targetLandId = toNum(targetLandIdInput);
    if (hasTargetLandId && (!Number.isSafeInteger(targetLandId) || targetLandId <= 0)) {
        throw new Error('地块编号无效');
    }
    if (hasTargetLandId && opType !== 'clear') {
        throw new Error('指定地块仅支持单点务农');
    }

    // 摘要
    const statusParts: string[] = [];
    if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
    const farmingCount = new Set([...status.needWeed, ...status.needBug, ...status.needInteractionCleanup]).size
        + socialEventItemIds.length;
    if (farmingCount > 0) statusParts.push(`农:${farmingCount}`);
    if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
    if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
    if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
    if (status.unlockable.length) statusParts.push(`解:${status.unlockable.length}`);
    if (status.upgradable.length) statusParts.push(`升:${status.upgradable.length}`);
    statusParts.push(`长:${status.growing.length}`);

    const actions: string[] = [];

    // 执行一键务农 (除草+除虫+浇水) - 串行执行以降低并发压力
    if (opType === 'all' || opType === 'clear') {
        // 检查是否跳过一键务农（仅自动模式生效，手动clear不受影响）
        const skipOwnWeedBug = opType === 'all' && isAutomationOn('skip_own_weed_bug');
        let farmingLandIds = [...new Set([
            ...status.needWeed,
            ...status.needBug,
            ...status.needWater,
            ...status.needInteractionCleanup,
        ])];

        // golden_bug_clear：开关关掉时，自家地块上的黄金虫不进务农集合，避免被自动清理。
        // 开关打开（默认）时行为与之前一致：黄金虫随一键务农一起清掉。
        if (!isAutomationOn('golden_bug_clear')) {
            const goldenBugExclude = new Set(status.goldenBugLandIds || []);
            if (goldenBugExclude.size > 0) {
                farmingLandIds = farmingLandIds.filter((id: number) => !goldenBugExclude.has(id));
            }
        }

        const validSingleLandIds = new Set<number>([
            ...status.growing,
            ...status.harvestable,
            ...status.dead,
        ]);
        if (hasTargetLandId) {
            if (!validSingleLandIds.has(targetLandId)) {
                throw new Error(`土地#${targetLandId} 当前不能执行务农`);
            }
            const targetNeedsFarming = farmingLandIds.includes(targetLandId);
            farmingLandIds = targetNeedsFarming || socialEventItemIds.length > 0 ? [targetLandId] : [];
        } else if (socialEventItemIds.length > 0 && farmingLandIds.length === 0) {
            // 青蛙属于农场级事件，但 Farming 仍需携带一块有效作物地；官方单点抓包也是该结构。
            const fallbackLandId = status.growing[0] || status.harvestable[0] || status.dead[0] || 0;
            if (fallbackLandId > 0) farmingLandIds = [fallbackLandId];
        }

        if (!skipOwnWeedBug && farmingLandIds.length > 0) {
            try {
                await farming(farmingLandIds, socialEventItemIds);
                const parts: string[] = [];
                if (status.needWeed.length) parts.push(`草${status.needWeed.length}`);
                if (status.needBug.length) parts.push(`虫${status.needBug.length}`);
                if (status.needWater.length) parts.push(`水${status.needWater.length}`);
                if (status.needInteractionCleanup.length) parts.push(`道具${status.needInteractionCleanup.length}`);
                if (socialEventItemIds.length) parts.push(`青蛙${socialEventItemIds.length}`);
                actions.push(hasTargetLandId
                    ? `单点务农#${targetLandId}${parts.length ? `(${parts.join('/')})` : ''}`
                    : `一键务农${parts.join('/')}`);
                recordOperation('farming', farmingLandIds.length);
            } catch (e: any) {
                logWarn(hasTargetLandId ? '单点务农' : '一键务农', e.message);
                if (hasTargetLandId || propagateErrors) throw e;
            }
        }
    }

    // 执行收获
    let harvestedLandIds: number[] = [];
    let harvestReply: any = null;
    let postHarvest: any = null;
    if (opType === 'all' || opType === 'harvest') {
        const harvestable = opType === 'all' ? autoHarvestLandIds(status) : status.harvestable;
        if (harvestable.length > 0) {
            try {
                harvestReply = await harvest(harvestable);
                log('收获', `收获完成 ${harvestable.length} 块土地`, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'ok',
                    count: harvestable.length,
                    landIds: [...harvestable],
                });
                actions.push(`收获${harvestable.length}`);
                recordOperation('harvest', harvestable.length);
                harvestedLandIds = [...harvestable];
                networkEvents.emit('farmHarvested', {
                    count: harvestable.length,
                    landIds: [...harvestable],
                    opType,
                });
                // 宠物资本模式：收获完成后召回守护宠物。
                try {
                    require('../capital-mode').handleFarmHarvested();
                } catch (e: any) {
                    logWarn('宠物', `资本模式召回调度失败: ${e?.message || e}`);
                }
            } catch (e: any) {
                logWarn('收获', e.message, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'error',
                });
                // 收获失败时本轮不会铲地也不会补种，别让剩下的动作等下一轮
                // 20~25 秒才被重试；登记一次提前唤醒即可。
                ownMaturity.requestFarmWakeup('harvest_failed');
                if (propagateErrors) throw e;
            }
        }
    }

    // 执行种植
    if (opType === 'all' || opType === 'plant') {
        if (overBudget()) return { hadWork: actions.length > 0, actions };
        // 已走到种植决策：即使最终没有空地可种，也不该触发 checkFarm 的续跑兜底，
        // 避免「确实没地」时按剩余间隔无限空转。
        if (automatic) automatic.pacing.plantingResolved = true;
        const allEmptyLands: number[] = [...new Set(status.empty)] as number[];
        let allDeadLands: number[] = [...new Set(status.dead)] as number[];

        if (opType === 'all' && harvestedLandIds.length > 0) {
            // 收获后延迟再铲除枯地
            await randomDelay(1000, 1500);
            postHarvest = await resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
            allDeadLands = [...new Set([...allDeadLands, ...postHarvest.removable])];
        }
        // 注意：如果是单纯点"一键种植"，harvestedLandIds 为空，只种当前的空地/死地
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                if (automatic && !canContinueFarm(automatic.generation)) return { hadWork: actions.length > 0, actions };
                const plantResult = await autoPlantEmptyLands(allDeadLands, allEmptyLands, {
                    propagateErrors, knownLands: lands, force: opType !== 'all',
                    pacing: automatic ? automatic.pacing : { lastPlantAt: null, delaySeconds: 0 },
                });
                const plantedCount = Array.isArray(plantResult?.plantedLands) ? plantResult.plantedLands.length : 0;
                if (plantedCount > 0) {
                    actions.push(`种植${plantedCount}`);
                    recordOperation('plant', plantedCount);
                }
                // 「预留 N 块地」不是实际动作，计入 hadWork 会让上层误判为本轮有进展、
                // 提前拉起下一轮巡田，从而造成 2×2 部分空出时的高频重复请求。
            } catch (e: any) {
                logWarn('种植', e.message);
                if (propagateErrors) throw e;
            }
        }
    }
    if (opType === 'all' && postHarvest && Array.isArray(postHarvest.growing) && postHarvest.growing.length > 0) {
        await runMultiSeasonFertilizer(postHarvest.growing, propagateErrors);
    }

    // 执行土地解锁/升级（手动 upgrade 总是执行；自动 all 受开关控制）
    if (overBudget()) return { hadWork: actions.length > 0, actions };
    const shouldAutoUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
    if (shouldAutoUpgrade || opType === 'upgrade') {
        if (status.unlockable.length > 0) {
            let unlocked: number = 0;
            for (const landId of status.unlockable) {
                try {
                    await unlockLand(landId, false);
                    log('解锁', `土地#${landId} 解锁成功`, {
                        module: 'farm', event: '解锁土地', result: 'ok', landId
                    });
                    unlocked++;
                } catch (e: any) {
                    logWarn('解锁', `土地#${landId} 解锁失败: ${e.message}`, {
                        module: 'farm', event: '解锁土地', result: 'error', landId
                    });
                    if (propagateErrors) throw e;
                }
                await randomDelay(1000, 1500);
            }
            if (unlocked > 0) {
                actions.push(`解锁${unlocked}`);
            }
        }

        if (status.upgradable.length > 0) {
            let upgraded: number = 0;
            for (const landId of status.upgradable) {
                try {
                    const reply = await upgradeLand(landId);
                    const newLevel = reply.land ? toNum(reply.land.level) : '?';
                    log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
                        module: 'farm', event: '升级土地', result: 'ok', landId, level: newLevel
                    });
                    upgraded++;
                } catch (e: any) {
                    log('升级', `土地#${landId} 升级失败: ${e.message}`, {
                        module: 'farm', event: '升级土地', result: 'error', landId
                    });
                    if (propagateErrors) throw e;
                }
                await randomDelay(1000, 1500);
            }
            if (upgraded > 0) {
                actions.push(`升级${upgraded}`);
                recordOperation('upgrade', upgraded);
            }
        }
    }

    if (opType === 'all') {
        if (overBudget()) return { hadWork: actions.length > 0, actions };
        const fertilizerConfig = getAutomation().fertilizer || 'none';
        const canApplyNormal = fertilizerConfig === 'normal'
            || fertilizerConfig === 'both'
            || fertilizerConfig === 'smart';
        if (isAutomationOn('fertilizer_multi_season') && canApplyNormal) {
            try {
                const latest = await getAllLands();
                const latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
                let targets = getNormalFertilizerTargetsFromLands(latestLands);
                // 先按施肥土地范围过滤，避免范围外地块每轮都触发"检测到但目标为空"的无效调用。
                // 过滤规则与 runFertilizerByConfig 内部一致：勾满全部类型视为不限制；确认不了土地类型时跳过本轮。
                const selectedLandTypes = normalizeFertilizerLandTypes(getAutomation().fertilizer_land_types);
                if (selectedLandTypes.length > 0 && selectedLandTypes.length < ALL_FERTILIZER_LAND_TYPES.length) {
                    const landTypeById = new Map<number, string>();
                    for (const land of latestLands) {
                        if (!land) continue;
                        const landId = toNum(land.id);
                        if (!landId) continue;
                        landTypeById.set(landId, getLandTypeByLevel(land.level));
                    }
                    targets = landTypeById.size > 0
                        ? filterLandIdsByTypes(targets, landTypeById, selectedLandTypes)
                        : [];
                }
                if (targets.length > 0) {
                    log('施肥', `巡田补肥：检测到 ${targets.length} 块地仍可施普通化肥`, {
                        module: 'farm',
                        event: '多季节施肥',
                        result: 'trigger',
                        count: targets.length,
                        landIds: targets,
                    });
                    const result = await runFertilizerByConfig(targets, { reason: 'multi_season', propagateErrors });
                    if (result.normal > 0) actions.push(`补肥${result.normal}`);
                }
            } catch (e: any) {
                logWarn('施肥', `巡田补肥失败: ${e.message}`, {
                    module: 'farm',
                    event: '多季节施肥',
                    result: 'error',
                });
                if (propagateErrors) throw e;
            }
        }
        // 巡田施肥（老版口径）：smart 策略照常；另外只要开了「2x2催熟」，即使策略为
        // 不施肥/普通肥，也要进入施肥流程 —— runFertilizerByConfig 内部会单独催熟 2×2 作物。
        if (fertilizerConfig === 'smart' || isAutomationOn('fertilizer_2x2_ripen')) {
            try {
                const result = await runFertilizerByConfig([], { skipNormal: true, propagateErrors });
                if (result.organic > 0) {
                    actions.push(`有机肥${result.organic}`);
                    await harvestMatureOwnLandsOnce(actions, propagateErrors);
                } else if (result.normal > 0) {
                    actions.push(`2x2催熟${result.normal}`);
                }
            } catch (e: any) {
                logWarn('施肥', `巡田时施肥失败: ${e.message}`);
                if (propagateErrors) throw e;
            }
        }
    }
    // 日志
    const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
    if (actions.length > 0) {
         log('农场', `[${statusParts.join(' ')}]${actionStr}`, {
             module: 'farm', event: '农场循环', opType, actions
         });
    }
    return { hadWork: actions.length > 0, actions };
}

function scheduleNextFarmCheck(delayMs: number = CONFIG.farmCheckInterval): void {
    if (externalSchedulerMode) return;
    if (!farmLoopRunning) return;
    const waitMs = Math.max(0, delayMs);
    farmScheduler.setTimeoutTask('farm_check_loop', waitMs, async () => {
        if (!farmLoopRunning) return;
        await runExclusiveAutomationTask('farm_check_loop', checkFarm);
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(CONFIG.farmCheckInterval);
    });
}

function startFarmCheckLoop(options: { externalScheduler?: boolean } = {}): void {
    if (farmLoopRunning) return;
    farmLoopGeneration++;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('landsChanged', onLandsChangedPush);
    networkEvents.on('farmSocialEventsChanged', onFarmSocialEventsChangedPush);
    if (!externalSchedulerMode) {
        scheduleNextFarmCheck(2000);
    }
    // 启动化肥自动购买检测定时器
    startFertilizerBuyCheckTimer();
}

const FARM_PUSH_LOCK_WAIT_MS = 30 * 1000;

/** 巡查中 / 计时器落地时撞上巡查的推送不再无声丢弃，改成登记一次提前唤醒。 */
function markFarmPushDuringCheck(reason: string): void {
    logFileOnly('巡田', `巡查中收到${reason}，登记延后检查`);
    ownMaturity.requestFarmWakeup(reason);
}

function scheduleFarmPushCheck(taskName: string, reason: string): void {
    farmScheduler.setTimeoutTask(taskName, 100, async () => {
        if (isCheckingFarm) {
            markFarmPushDuringCheck(reason);
            return;
        }
        await runExclusiveAutomationTask(taskName, checkFarm, {
            priority: true,
            timeoutMs: FARM_PUSH_LOCK_WAIT_MS,
        });
    });
}

function onLandsChangedPush(lands: any[]): void {
    if (!isAutomationOn('farm_push')) return;
    // 局部通知也可能带成熟时刻：只收紧计划，不清掉整片快照算出的更晚成熟点。
    ownMaturity.observeOwnFarmMaturity(lands, 'push');
    if (isCheckingFarm) {
        markFarmPushDuringCheck('土地变化推送');
        return;
    }
    const now: number = Date.now();
    if (now - lastLandsPushTime < 500) return;
    lastLandsPushTime = now;
    const count = Array.isArray(lands) ? lands.length : 0;
    log('农场', `收到推送: ${count}块土地变化，检查中...`, {
        module: 'farm', event: '土地推送通知', result: 'trigger_check', count
    });
    scheduleFarmPushCheck('farm_push_check_lands', 'lands_push');
}

function onFarmSocialEventsChangedPush(events: any[]): void {
    if (!isAutomationOn('farm_push')) return;
    if (isCheckingFarm) {
        markFarmPushDuringCheck('农场社交事件推送');
        return;
    }
    const now: number = Date.now();
    if (now - lastSocialPushTime < 500) return;
    lastSocialPushTime = now;
    const count = Array.isArray(events) ? events.length : 0;
    log('农场', `收到农场社交事件推送: ${count}个，检查中...`, {
        module: 'farm', event: '农场社交事件通知', result: 'trigger_check', count
    });
    scheduleFarmPushCheck('farm_push_check_social', 'social_push');
}

function stopFarmCheckLoop(): void {
    farmLoopRunning = false;
    farmLoopGeneration++;
    automaticPlantPacing = { lastPlantAt: null, defer: true, plantingResolved: false };
    externalSchedulerMode = false;
    farmScheduler.clearAll();
    ownMaturity.resetOwnFarmMaturity();
    lastLandsPushTime = 0;
    lastSocialPushTime = 0;
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
    networkEvents.removeListener('farmSocialEventsChanged', onFarmSocialEventsChangedPush);
    // 停止化肥自动购买检测定时器
    stopFertilizerBuyCheckTimer();
}

function refreshFarmCheckLoop(delayMs: number = 200): void {
    if (!farmLoopRunning) return;
    // 分次种植的续跑有自己的计时（配置间隔减已耗时），配置下发不能把它压成 200ms，
    // 否则每轮 config_sync 都会提前叫醒一整轮巡田。setTimeoutTask 同名会先清旧计时器，
    // 所以这里不手动 clear：守卫不通过时旧计时器原样保留，剩余地块不会被晾到下一轮。
    if (farmScheduler.has('farm_plant_continue')) {
        schedulePlantContinuation(farmLoopGeneration, automaticPlantPacing);
    }
    if (externalSchedulerMode) {
        // 统一调度器模式下 scheduleNextFarmCheck 会直接 return，配置下发叫不醒农场线。
        // 登记一次唤醒请求，由 worker 的 resetUnifiedSchedule 消费成短到期线。
        ownMaturity.requestFarmWakeup('config_sync');
        return;
    }
    scheduleNextFarmCheck(delayMs);
}

// ============ 化肥自动购买定时检测 ============
// 当前已生效的开关与间隔（用于判断配置下发后是否需要重建）。
let fertilizerTimerSignature = '';

function startFertilizerBuyCheckTimer(): void {
    const buyOrganic: boolean = isAutomationOn('fertilizer_buy_organic');
    const buyNormal: boolean = isAutomationOn('fertilizer_buy_normal');

    // 检查是否有开启的化肥购买功能
    if (!buyOrganic && !buyNormal) {
        if (fertilizerTimerSignature) stopFertilizerBuyCheckTimer();
        return;
    }

    // 设置定时检测
    const intervalMinutes: number = getFertilizerBuyCheckIntervalMinutes();
    const intervalMs: number = intervalMinutes * 60 * 1000;
    const signature: string = `${buyOrganic ? 1 : 0}${buyNormal ? 1 : 0}|${intervalMinutes}`;
    // 配置没变就不重建：重建会把计时重新起算，频繁保存设置会让巡检永远等不到触发。
    if (signature === fertilizerTimerSignature && farmScheduler.has('fertilizer_buy_check')) return;
    fertilizerTimerSignature = signature;

    farmScheduler.clear('fertilizer_buy_check');
    farmScheduler.setIntervalTask('fertilizer_buy_check', intervalMs, () => {
        runExclusiveAutomationTask('fertilizer_buy_check', checkFertilizerBuyOnce).catch(() => null);
    });

    log('农场', `化肥自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'start',
        intervalMinutes,
    });
}

function stopFertilizerBuyCheckTimer(): void {
    fertilizerTimerSignature = '';
    farmScheduler.clear('fertilizer_buy_check');
    log('农场', '化肥自动购买检测定时器已停止', {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'stop',
    });
}

async function checkFertilizerBuyOnce(): Promise<void> {
    if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) {
        return;
    }

    try {
        const options = {
            buyOrganic: isAutomationOn('fertilizer_buy_organic'),
            buyNormal: isAutomationOn('fertilizer_buy_normal'),
            organicCount: getFertilizerBuyOrganicCount(),
            organicThresholdHours: getFertilizerBuyOrganicThresholdHours(),
            normalCount: getFertilizerBuyNormalCount(),
            normalThresholdHours: getFertilizerBuyNormalThresholdHours(),
        };

        await checkAndBuyFertilizerBoth(options);
    } catch (e: any) {
        logWarn('农场', `化肥自动购买检测失败: ${e.message}`, {
            module: 'farm',
            event: 'fertilizer_auto_buy',
            result: 'error',
            error: e.message,
        });
    }
}

module.exports = {
    checkFarm,
    runFarmOperation,
    scheduleNextFarmCheck,
    startFarmCheckLoop,
    onLandsChangedPush,
    onFarmSocialEventsChangedPush,
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
    startFertilizerBuyCheckTimer,
    stopFertilizerBuyCheckTimer,
    checkFertilizerBuyOnce,
    getOwnFarmMaturityDelayMs: ownMaturity.getOwnFarmMaturityDelayMs,
    consumeFarmWakeup: ownMaturity.consumeFarmWakeup,
    requestFarmWakeup: ownMaturity.requestFarmWakeup,
};
