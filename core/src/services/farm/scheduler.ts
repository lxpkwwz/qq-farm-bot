export {};
/**
 * 农场循环调度 - 循环管理、可变状态
 */

const { CONFIG } = require('../../config/config');
const { isAutomationOn, getAutomation, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../../models/store');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, log, logWarn, randomDelay } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');
const { recordOperation } = require('../stats');
const { getAllLands, harvest, farming, unlockLand, upgradeLand } = require('./api');
const { analyzeLands, resolveRemovableHarvestedLands } = require('./land-analysis');
const { autoPlantEmptyLands, runFertilizerByConfig } = require('./planting');
const { checkAndBuyFertilizerBoth } = require('../mall');
// 延迟加载以打破循环依赖: visit-strategy → farm/index → scheduler → visit-strategy
function inFriendQuietHours() {
    return require('../friend/visit-strategy').inFriendQuietHours();
}

// ============ 内部状态 ============
let isCheckingFarm: boolean = false;
let isFirstFarmCheck: boolean = true;
let farmLoopRunning: boolean = false;
let externalSchedulerMode: boolean = false;
let fertilizerBuyCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastFertilizerBuyCheckAt: number = 0;
const farmScheduler = createScheduler('farm');
let lastPushTime: number = 0;

// ============ 农场循环 ============

async function checkFarm(): Promise<boolean> {
    const state = getUserState();
    if (isCheckingFarm || !state.gid || !isAutomationOn('farm')) return false;
    // if (inFriendQuietHours()) return false;
    isCheckingFarm = true;

    try {
        // 复用手动操作逻辑
        const result = await runFarmOperation('all');
        isFirstFarmCheck = false;
        return !!(result && result.hadWork);
    } catch (err: any) {
        logWarn('巡田', `检查失败: ${err.message}`);
        return false;
    } finally {
        isCheckingFarm = false;
    }
}

/**
 * 手动/自动执行农场操作
 * @param opType - 'all', 'harvest', 'clear', 'plant', 'upgrade'
 */
async function runFarmOperation(opType: string): Promise<{ hadWork: boolean; actions: string[] }> {
    const landsReply = await getAllLands();
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all') {
            log('农场', '没有土地数据');
        }
        return { hadWork: false, actions: [] };
    }

    const lands = landsReply.lands;

    const state = getUserState();
    const status = analyzeLands(lands, isFirstFarmCheck, state.gid);

    // 摘要
    const statusParts: string[] = [];
    if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
    const farmingCount = new Set([...status.needWeed, ...status.needBug]).size;
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
        const farmingLandIds = [...new Set([...status.needWeed, ...status.needBug, ...status.needWater])];
        if (!skipOwnWeedBug && farmingLandIds.length > 0) {
            try {
                await farming(farmingLandIds);
                const parts: string[] = [];
                if (status.needWeed.length) parts.push(`草${status.needWeed.length}`);
                if (status.needBug.length) parts.push(`虫${status.needBug.length}`);
                if (status.needWater.length) parts.push(`水${status.needWater.length}`);
                actions.push(`一键务农${parts.join('/')}`);
                recordOperation('farming', farmingLandIds.length);
            } catch (e: any) {
                logWarn('一键务农', e.message);
            }
        }
    }

    // 执行收获
    let harvestedLandIds: number[] = [];
    let harvestReply: any = null;
    let postHarvest: any = null;
    if (opType === 'all' || opType === 'harvest') {
        if (status.harvestable.length > 0) {
            try {
                harvestReply = await harvest(status.harvestable);
                log('收获', `收获完成 ${status.harvestable.length} 块土地`, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'ok',
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                });
                actions.push(`收获${status.harvestable.length}`);
                recordOperation('harvest', status.harvestable.length);
                harvestedLandIds = [...status.harvestable];
                networkEvents.emit('farmHarvested', {
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                    opType,
                });
            } catch (e: any) {
                logWarn('收获', e.message, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'error',
                });
            }
        }
    }

    // 执行种植
    if (opType === 'all' || opType === 'plant') {
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
                const plantCount = allDeadLands.length + allEmptyLands.length;
                await autoPlantEmptyLands(allDeadLands, allEmptyLands);
                actions.push(`种植${plantCount}`);
                recordOperation('plant', plantCount);
            } catch (e: any) { logWarn('种植', e.message); }
        }
    }
    if (opType === 'all' && postHarvest && Array.isArray(postHarvest.growing) && postHarvest.growing.length > 0 && isAutomationOn('fertilizer_multi_season')) {
        const multiSeasonTargets: number[] = [...new Set(postHarvest.growing.map((v: any) => toNum(v)).filter(Boolean))] as number[];
        if (multiSeasonTargets.length > 0) {
            log('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonTargets.length} 块`, {
                module: 'farm',
                event: '多季节施肥',
                result: 'trigger',
                count: multiSeasonTargets.length,
                landIds: multiSeasonTargets,
            });
            try {
                await runFertilizerByConfig(multiSeasonTargets, { reason: 'multi_season' });
            } catch (e: any) {
                logWarn('施肥', `多季补肥执行失败: ${e.message}`, {
                    module: 'farm',
                    event: '多季节施肥',
                    result: 'error',
                });
            }
        }
    }

    // 执行土地解锁/升级（手动 upgrade 总是执行；自动 all 受开关控制）
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
        const fertilizerConfig = getAutomation().fertilizer || 'none';
        if (fertilizerConfig === 'smart') {
            try {
                const result = await runFertilizerByConfig([], { skipNormal: true });
                if (result.organic > 0) {
                    actions.push(`有机肥${result.organic}`);
                }
            } catch (e: any) {
                logWarn('施肥', `巡田时施肥失败: ${e.message}`);
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
    farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, delayMs), async () => {
        if (!farmLoopRunning) return;
        await checkFarm();
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(CONFIG.farmCheckInterval);
    });
}

function startFarmCheckLoop(options: { externalScheduler?: boolean } = {}): void {
    if (farmLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('landsChanged', onLandsChangedPush);
    if (!externalSchedulerMode) {
        scheduleNextFarmCheck(2000);
    }
    // 启动化肥自动购买检测定时器
    startFertilizerBuyCheckTimer();
}

function onLandsChangedPush(lands: any[]): void {
    if (!isAutomationOn('farm_push')) {
        return;
    }
    if (isCheckingFarm) return;
    const now: number = Date.now();
    if (now - lastPushTime < 500) return;
    lastPushTime = now;
    log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
        module: 'farm', event: '土地推送通知', result: 'trigger_check', count: lands.length
    });
    farmScheduler.setTimeoutTask('farm_push_check', 100, async () => {
        if (!isCheckingFarm) await checkFarm();
    });
}

function stopFarmCheckLoop(): void {
    farmLoopRunning = false;
    externalSchedulerMode = false;
    farmScheduler.clearAll();
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
    // 停止化肥自动购买检测定时器
    stopFertilizerBuyCheckTimer();
}

function refreshFarmCheckLoop(delayMs: number = 200): void {
    if (!farmLoopRunning) return;
    scheduleNextFarmCheck(delayMs);
}

// ============ 化肥自动购买定时检测 ============
function startFertilizerBuyCheckTimer(): void {
    if (fertilizerBuyCheckTimer) {
        clearInterval(fertilizerBuyCheckTimer);
    }

    // 检查是否有开启的化肥购买功能
    if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) {
        return;
    }

    // 设置定时检测
    const intervalMinutes: number = getFertilizerBuyCheckIntervalMinutes();
    const intervalMs: number = intervalMinutes * 60 * 1000;

    fertilizerBuyCheckTimer = setInterval(() => {
        checkFertilizerBuyOnce();
    }, intervalMs);

    log('农场', `化肥自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'start',
        intervalMinutes,
    });
}

function stopFertilizerBuyCheckTimer(): void {
    if (fertilizerBuyCheckTimer) {
        clearInterval(fertilizerBuyCheckTimer);
        fertilizerBuyCheckTimer = null;
    }
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
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
    startFertilizerBuyCheckTimer,
    stopFertilizerBuyCheckTimer,
    checkFertilizerBuyOnce,
};
