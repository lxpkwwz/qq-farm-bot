export {};
/**
 * 子进程 Worker - 负责运行单个账号的挂机逻辑
 */
const { parentPort, workerData } = require('node:worker_threads');

const { CONFIG, updateRuntimeConfig } = require('../config/config');
const { getLevelExpProgress, loadConfigs } = require('../config/gameConfig');
const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot } = require('../models/store');
const { checkAndClaimEmails, configureEmailClaim, getEmailDailyState } = require('../services/email');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, startFertilizerBuyCheckTimer, getOwnFarmMaturityDelayMs, consumeFarmWakeup, getLandsDetail, getAvailableSeeds, purchaseSeed, runFarmOperation, runFertilizerByConfig, fertilizeOwnLand } = require('../services/farm');
const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, getFriendsList, getFriendsListCacheOnly, getFriendLandsDetail, doFriendOperation, deleteFriend, runScheduledStealCheck, runGoldenBugPlacement } = require('../services/friend');
const { getInteractRecords } = require('../services/interact');
const { processInviteCodes } = require('../services/invite');
const { autoBuyFertilizer, checkAndBuyFertilizerBoth, buyFreeGifts, getFreeGiftDailyState } = require('../services/mall');
const { performDailyMonthCardGift, getMonthCardDailyState } = require('../services/monthcard');
const { performDailyVipGift, getVipDailyState } = require('../services/qqvip');
const { runExclusiveAutomationTask } = require('../services/automation-lock');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { checkDailyShareStatus, getShareDailyState } = require('../services/share');
const { refreshActivityWindows } = require('../services/activity-windows');
const { resetSessionGains, recordOperation, initStatsWithPersistence, saveStats } = require('../services/stats');
const { startPetFeedCheckTimer, stopPetFeedCheckTimer } = require('../services/pet-feed');
const { initStatusBar, setStatusPlatform, statusData } = require('../services/status');
const { setRecordGoldExpHook } = require('../services/status');
const { cleanupTaskSystem, checkAndClaimTasks, getTaskClaimDailyState, getTaskDailyStateLikeApp, getGrowthTaskStateLikeApp } = require('../services/task');
const { runIllustratedDailyAutomation, ILLUSTRATED_AUTO_KEYS } = require('../services/illustrated-auto');
const {
    sellAllFruits,
    getBag,
    getBagItems,
    openFertilizerGiftPacksSilently,
    openCharitySettlementGiftPacksSilently,
} = require('../services/warehouse');
const { checkAndClaimDogSkillGifts } = require('../services/dog-skill-gifts');
const { isGatewayHealthyForBusiness, nextBusinessBackoffMs } = require('../utils/low-priority-gate');
const { readCountOr, readId, readNonNegativeIntOr } = require('../utils/input-guards');
const { connect, cleanup, getWs, getUserState, networkEvents, getGatewayLoad } = require('../utils/network');
const { loadProto } = require('../utils/proto');
const { formatDurationZh } = require('../utils/net-diagnosis-text');
const { runWithRequestClass } = require('../utils/request-context');
const { setLogHook, log, logWarn, logFileOnly, toNum, getSystemDateKey, formatSystemDateTime24 } = require('../utils/utils');
const { getRequestProfile, isForegroundActive } = require('../utils/request-governor');

// Extend CONFIG with the unified friend-task interval used by this worker.
interface WorkerRuntimeConfig {
    friendCheckIntervalMin: number;
    friendCheckIntervalMax: number;
    [key: string]: any;
}

const workerConfig = CONFIG as WorkerRuntimeConfig;

if (parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}

function sendToMaster(payload: Record<string, any>): void {
    if (process.send) {
        process.send(payload);
        return;
    }
    if (parentPort) {
        parentPort.postMessage(payload);
    }
}

/**
 * 回送面板 API 结果。
 *
 * result 里混入 BigInt / 循环引用时 `process.send` 会同步抛 TypeError；worker 正在
 * 退出、IPC 已关闭时也会抛。原实现把这一句放在 try/catch 之外，异常直接变成
 * handleApiCall 的 Promise 拒绝 → Node 20 fatal，且主进程永远收不到回包。
 */
function sendApiResponse(id: any, result: any, error: any): void {
    try {
        sendToMaster({ type: 'api_response', id, result, error });
    } catch (e: any) {
        try {
            sendToMaster({
                type: 'api_response',
                id,
                result: null,
                error: {
                    message: `回包发送失败: ${String((e && e.message) || e)}`,
                    name: 'WorkerApiResponseError',
                },
            });
        } catch {
            // IPC 已彻底关闭，主进程侧的调用定时器会兜底。
        }
    }
}

function onMasterMessage(handler: (msg: any) => void | Promise<void>): void {
    // 指令处理器常写成 async；Node 20 把未处理的 Promise 拒绝当致命错误，
    // 这里统一接管，避免一条指令的处理异常直接带走整个 worker。
    const safeHandler = (msg: any): void => {
        try {
            const result: any = handler(msg);
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch((error: any) => {
                    logWarn('系统', `主进程指令处理异常: ${String((error && error.message) || error)}`, { module: 'system', event: '主进程指令', result: 'error' });
                });
            }
        } catch (error: any) {
            logWarn('系统', `主进程指令处理异常: ${String((error && error.message) || error)}`, { module: 'system', event: '主进程指令', result: 'error' });
        }
    };
    if (process.send) {
        process.on('message', safeHandler);
    }
    if (parentPort) {
        parentPort.on('message', safeHandler);
    }
}

function exitWorker(code: number = 0): void {
    if (parentPort) {
        try {
            parentPort.close();
        } catch {}
        return;
    }
    process.exit(code);
}

// 捕获日志发送给主进程
setLogHook((tag: string, msg: string, isWarn: boolean, meta: any) => {
    sendToMaster({
        type: 'log',
        data: {
            time: formatSystemDateTime24(),
            tag,
            msg,
            isWarn,
            meta: meta || {},
        }
    });
});

// 捕获金币经验变化
setRecordGoldExpHook((gold: number, exp: number) => {
    // 更新内部统计
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);

    // 发送给主进程
    sendToMaster({ type: 'stat_update', data: { gold, exp } });
});

let isRunning: boolean = false;
let loginReady: boolean = false;
let appliedConfigRevision: number = 0;
let unifiedSchedulerRunning: boolean = false;
let farmTaskRunning: boolean = false;
let nextFarmRunAt: number = 0;
let friendTaskRunning: boolean = false;
let nextFriendRunAt: number = 0;
let stealTaskRunning: boolean = false;
let nextStealRunAt: number = 0;
let nextStealDelayMs: number = 0;
// 网关卡住时两条定时任务各自的退避时长（毫秒），0 表示按正常间隔跑
const businessBackoffMs: Record<string, number> = { farm: 0, friend: 0 };
// 网关「半死不活」（心跳时好时坏、持续慢请求）时闸门会长期为 false，退避会
// 每轮把到期线往后推，形成无限饥饿。与前台让路同口径加连续次数 + 累计时长
// 双上限，到顶强制照常跑一轮，由 checkFarm 内部的请求超时自行兜底。
const BUSINESS_BACKOFF_MAX_STREAK = 5;
const BUSINESS_BACKOFF_MAX_TOTAL_MS = 5 * 60 * 1000;
const businessBackoffStreak: Record<string, number> = { farm: 0, friend: 0 };
const businessBackoffTotalMs: Record<string, number> = { farm: 0, friend: 0 };
let lastStatusHash: string = '';
let lastStatusSentAt: number = 0;
let onSellGain: ((deltaGold: any) => void) | null = null;
let onFarmHarvested: (() => Promise<void>) | null = null;
let onDogSkillGiftPending: ((count: any) => void) | null = null;
let harvestSellRunning: boolean = false;
let onWsError: ((payload: any) => void) | null = null;
let onDisconnected: ((payload: any) => void) | null = null;
let wsErrorHandledAt: number = 0;
let shutdownStarted: boolean = false;
let runtimeGeneration: number = 0;
let lastDailyRunDate: string = '';
const workerScheduler = createScheduler('worker');

async function runDailyRoutines(force: boolean = false): Promise<void> {
    if (!loginReady) return;
    try {
        // 邮箱按配置时刻每日检查一次，不受 force 影响（否则每次重连都会重复请求）。
        await checkAndClaimEmails();
        await openCharitySettlementGiftPacksSilently();
        await checkDailyShareStatus(force);
        await performDailyMonthCardGift(force);
        await buyFreeGifts(force);
        await performDailyVipGift(force);
    } catch (e: any) {
        log('系统', `每日任务调度失败: ${e.message}`, { module: 'system', event: '每日任务', result: 'error' });
    }
    // 独立于其它每日任务：前面任一任务失败也不影响图鉴检查。
    // 收藏图鉴每天只检查一次（服务内部按日期键去重）：自动领奖 + 自动补种未点亮且背包没有的种子。
    try {
        await runIllustratedDailyAutomation();
    } catch (e: any) {
        logWarn('系统', `图鉴每日检查失败: ${e.message}`, { module: 'system', event: '每日任务', result: 'error' });
    }
}

function stopDailyRoutineTimer(): void {
    workerScheduler.clear('daily_routine_interval');
}

function startDailyRoutineTimer(runImmediately: boolean = true): void {
    stopDailyRoutineTimer();
    lastDailyRunDate = getSystemDateKey();
    // 新账号登录后强制执行一次领取
    if (runImmediately) runExclusiveAutomationTask('daily_routines', () => runDailyRoutines(true)).catch(() => null);
    // 对齐老版：60 秒一次日期轮询；同一天内不重复跑日常，但要继续做两件轻量检查——
    // 分享资格在服务端日切后可能延迟刷新（服务内 10 分钟冷却），持续检查可避免
    // 零点单次未命中后必须重连才能领取。
    workerScheduler.setIntervalTask('daily_routine_interval', 60 * 1000, () => {
        if (!loginReady) return;
        const today = getSystemDateKey();
        if (today === lastDailyRunDate) {
            checkDailyShareStatus(false).catch(() => null);
            // 邮箱：到达配置时刻且当天未出结果时补跑一次（跨日后到点才触发，不会 60 秒打一次）。
            const email = getEmailDailyState();
            if (!email.doneToday && email.result !== 'running' && Date.now() >= email.nextCheckAt) {
                runExclusiveAutomationTask('email_claim', async () => {
                    if (loginReady) await checkAndClaimEmails();
                }).catch(() => null);
            }
            return;
        }
        lastDailyRunDate = today;
        runExclusiveAutomationTask('daily_routines', () => runDailyRoutines(true)).catch(() => null);
    });
}

/**
 * 巡查间隔的统一上界（秒），与 models/store/shared-state 的 INTERVAL_MAX_SEC 必须一致。
 * 这里再夹一次是因为配置可能是旧文件 / 手写 JSON，绕过了 store 的归一化；
 * 而 `秒 * 1000` 一旦超过 2^31-1 毫秒，setTimeout 会溢出成 1ms（见 scheduler 的 toDelayMs）。
 */
const MAX_INTERVAL_SEC = 86400;

function normalizeIntervalRangeSec(minSec: any, maxSec: any, fallbackSec: any): { min: number; max: number } {
    const clamp = (v: any, d: number): number => Math.max(1, Math.min(MAX_INTERVAL_SEC, v || d));
    const fallback = clamp(Number.parseInt(fallbackSec, 10), 1);
    let min = clamp(Number.parseInt(minSec, 10), fallback);
    let max = clamp(Number.parseInt(maxSec, 10), fallback);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals: any): void {
    const data = (intervals && typeof intervals === 'object') ? intervals : {};

    // 农场巡查默认 20-25 秒（farmMin/farmMax 存在时以它们为准，farm 只是历史遗留单值）。
    const farmLegacy = Math.max(1, Math.min(MAX_INTERVAL_SEC, Number.parseInt(data.farm, 10) || 20));
    const farmRange = normalizeIntervalRangeSec(data.farmMin, data.farmMax, farmLegacy);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    // 好友帮助、偷菜、放虫放草共用一个好友任务间隔（对齐老版 DEFAULT_INTERVALS：30-35 秒）。
    const helpMin = Number.parseInt(data.helpMin, 10) || 30;
    const helpMax = Number.parseInt(data.helpMax, 10) || 35;
    const stealMin = Number.parseInt(data.stealMin, 10) || 30;
    const stealMax = Number.parseInt(data.stealMax, 10) || 35;
    const friendMin = data.friendMin ?? Math.min(helpMin, stealMin);
    const friendMax = data.friendMax ?? Math.min(helpMax, stealMax);
    const friendRange = normalizeIntervalRangeSec(friendMin, friendMax, 12);
    workerConfig.friendCheckIntervalMin = friendRange.min * 1000;
    workerConfig.friendCheckIntervalMax = friendRange.max * 1000;
}

function randomIntervalMs(minMs: number, maxMs: number): number {
    const minSec = Math.max(1, Math.floor(Math.max(1000, Number(minMs) || 1000) / 1000));
    const maxSec = Math.max(minSec, Math.floor(Math.max(1000, Number(maxMs) || minSec * 1000) / 1000));
    if (maxSec === minSec) return minSec * 1000;
    const sec = minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
    return sec * 1000;
}

// 自家农场成熟驱动：比服务端成熟墙钟晚 1.5 秒唤醒，避开时间同步的小偏差。
const FARM_MATURITY_WAKE_BUFFER_MS = 1500;
const FARM_WAKEUP_IMMEDIATE_MS = 200;
const FARM_TICK_LOCK_WAIT_MS = 30 * 1000;

/**
 * 算农场线下一次唤醒时刻。
 * 优先级：巡查中攒下的推送 / 收获失败 / 整轮超时登记的「尽快补跑」
 *       > 下一块自家作物的成熟点
 *       > 常规 20~25 秒随机轮询。
 * 配置下发时也走这里，所以不会再出现「面板保存把到期线推后、农场二十多秒叫不醒」。
 */
function planNextFarmRun(nowMs: number, farmMs: number): number {
    const wakeReason = consumeFarmWakeup();
    if (wakeReason) {
        logFileOnly('巡田', `提前唤醒农场巡查: ${wakeReason}`);
        return nowMs + FARM_WAKEUP_IMMEDIATE_MS;
    }
    const maturityDelayMs = getOwnFarmMaturityDelayMs();
    const maturityAt = maturityDelayMs > 0
        ? nowMs + maturityDelayMs + FARM_MATURITY_WAKE_BUFFER_MS
        : Number.POSITIVE_INFINITY;
    return Math.max(nowMs + 1000, Math.min(nowMs + farmMs, maturityAt));
}

function resetUnifiedSchedule(options: { preserveSteal?: boolean } = {}): void {
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    const friendMs = randomIntervalMs(
        workerConfig.friendCheckIntervalMin || 12000,
        workerConfig.friendCheckIntervalMax || 15000
    );
    const now = Date.now();
    nextFarmRunAt = planNextFarmRun(now, farmMs);
    // 老版本节奏：帮忙循环保底常规间隔，偷菜首轮给一个短的随机窗口，
    // 后续完全由 runScheduledStealCheck 返回的成熟时间动态决定。
    nextFriendRunAt = now + friendMs;
    // 配置下发不是重启：偷菜到期时间是按好友作物成熟时刻算出来的，
    // 只有调度器首次启动时才打回随机窗口，否则会错过成熟瞬间。
    if (!options.preserveSteal) nextStealRunAt = now + randomIntervalMs(5000, 15000);
    businessBackoffMs.farm = 0;
    businessBackoffMs.friend = 0;
    businessBackoffStreak.farm = 0;
    businessBackoffStreak.friend = 0;
    businessBackoffTotalMs.farm = 0;
    businessBackoffTotalMs.friend = 0;
}

const BUSINESS_TICK_LABEL: Record<string, string> = { farm: '农场定时任务', friend: '好友定时任务' };

/**
 * 前台让路：用户正在面板上操作时，定时任务本轮短顺延。
 *
 * 并发层已经保证「前台请求优先派发、后台业务最多占 1 个槽位」，但已经在飞的那一条
 * 自动请求仍然会占着连接几百毫秒到几秒。把 tick 往后挪 2 秒，用户点击时基本不会
 * 撞上一个刚发出去的农场/好友请求，页面响应会明显更跟手。
 *
 * 连续让路有上限：用户持续操作时最多顺延 5 次（约 10 秒），之后照常执行，
 * 避免定时任务被无限期饿死。
 */
const FOREGROUND_YIELD_MS = 2000;
const FOREGROUND_YIELD_MAX_STREAK = 5;
const foregroundYieldStreak: Record<string, number> = { farm: 0, friend: 0 };

function nextForegroundYieldMs(kind: string): number {
    const load = getGatewayLoad();
    const foregroundActive = isForegroundActive(Date.now()) || Number(load.foregroundPending) > 0;
    if (!foregroundActive) {
        foregroundYieldStreak[kind] = 0;
        return 0;
    }
    const streak = (foregroundYieldStreak[kind] || 0) + 1;
    foregroundYieldStreak[kind] = streak;
    if (streak > FOREGROUND_YIELD_MAX_STREAK) return 0;
    return FOREGROUND_YIELD_MS;
}

function describeGatewayStall(load: any): string {
    const parts: string[] = [];
    const misses = Number(load && load.heartbeatMisses) || 0;
    const oldest = Number(load && load.oldestPendingAgeMs) || 0;
    if (misses > 0) parts.push(`心跳漏 ${misses} 次`);
    if (oldest > 0) parts.push(`最老在途 ${formatDurationZh(oldest)}`);
    parts.push(`等待回包 ${Number(load && load.pending) || 0} 个`);
    parts.push(`排队 ${Number(load && load.queued) || 0} 个`);
    return parts.join('、');
}

/**
 * 网关卡住（心跳漏拍或有在途请求超过 5 秒没回包）时定时任务整轮让路，把连接留给心跳和 ACE 上报。
 * 返回本轮需要推迟的毫秒数，0 表示可以正常跑。日志只在进入/退出退避时各打一次，避免刷屏。
 */
function nextBusinessTickDeferMs(kind: string): number {
    const load = getGatewayLoad();
    if (isGatewayHealthyForBusiness(load)) {
        if (businessBackoffMs[kind] > 0) {
            businessBackoffMs[kind] = 0;
            businessBackoffStreak[kind] = 0;
            businessBackoffTotalMs[kind] = 0;
            log('系统', `网关已恢复，${BUSINESS_TICK_LABEL[kind]}回到正常间隔`, {
                module: 'system',
                event: '网关退避',
                result: 'resume',
                requestClass: kind,
            });
        }
        return 0;
    }

    const firstDefer = businessBackoffMs[kind] === 0;
    const backoffMs = nextBusinessBackoffMs(businessBackoffMs[kind]);
    businessBackoffMs[kind] = backoffMs;
    businessBackoffStreak[kind] = (businessBackoffStreak[kind] || 0) + 1;
    businessBackoffTotalMs[kind] = (businessBackoffTotalMs[kind] || 0) + backoffMs;
    if (firstDefer) {
        logWarn('系统', `网关无回包，${BUSINESS_TICK_LABEL[kind]}退避 ${formatDurationZh(backoffMs)}（${describeGatewayStall(load)}）`, {
            module: 'system',
            event: '网关退避',
            result: 'defer',
            requestClass: kind,
            backoffMs,
        });
    }
    // 到顶强制探活一轮：连续 5 次或累计推迟超过 5 分钟后，本轮不再 defer，
    // 并重置计数让下一轮从 30s 重新计。否则慢网关会让自家农场被无限期晾着。
    if (businessBackoffStreak[kind] > BUSINESS_BACKOFF_MAX_STREAK
        || businessBackoffTotalMs[kind] > BUSINESS_BACKOFF_MAX_TOTAL_MS) {
        logWarn('系统', `网关退避已达上限，${BUSINESS_TICK_LABEL[kind]}强制探活一轮`, {
            module: 'system',
            event: '网关退避',
            result: 'force_probe',
            requestClass: kind,
            streak: businessBackoffStreak[kind],
            totalMs: businessBackoffTotalMs[kind],
        });
        businessBackoffMs[kind] = 0;
        businessBackoffStreak[kind] = 0;
        businessBackoffTotalMs[kind] = 0;
        return 0;
    }
    return backoffMs;
}

async function runFarmTick(auto: any): Promise<void> {
    if (farmTaskRunning) return;
    const foregroundYieldMs = nextForegroundYieldMs('farm');
    if (foregroundYieldMs > 0) {
        nextFarmRunAt = Date.now() + foregroundYieldMs;
        return;
    }
    const farmDeferMs = nextBusinessTickDeferMs('farm');
    if (farmDeferMs > 0) {
        nextFarmRunAt = Date.now() + farmDeferMs;
        return;
    }
    farmTaskRunning = true;
    const generation = runtimeGeneration;
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    try {
        // 自己农场的定时任务统一挂在 farm 班次：优先级高于好友任务，低于用户前台操作。
        await runWithRequestClass('farm', async () => {
            if (auto.farm) await checkFarm();
            // task_after_farm：把「日常任务领取」绑定到农场循环之后立即跑一轮，
            // 不必等独立的任务定时器；与 auto.task 互不冲突（领取幂等）。
            if (auto.task_after_farm) await checkAndClaimTasks();
            if (auto.task) await checkAndClaimTasks();
            if (auto.email !== false) await openCharitySettlementGiftPacksSilently();
            if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
        });
    } catch (e: any) {
        // 整轮失败不能静默：否则某个 helper 永久失效时面板上看起来一切正常。
        logWarn('系统', `农场定时任务执行失败: ${e?.message || e}`, {
            module: 'system', event: '农场定时任务', result: 'error', requestClass: 'farm',
        });
    } finally {
        // 与 friend/steal tick 一致：账号停机又立刻重启时，旧轮次不能把新会话
        // 刚算好的到期时间覆盖掉，也不能提前解除新会话的运行中守卫。
        if (generation === runtimeGeneration) {
            nextFarmRunAt = planNextFarmRun(Date.now(), farmMs);
            farmTaskRunning = false;
        }
    }
}

// ============ 帮助 Tick（帮忙 + 放虫放草，低频固定 10 分钟一轮）============
// 好友帮忙不需要追着时间跑：每日额度、经验上限、捣乱次数都是低频约束；
// 偷菜才需要精确卡成熟时刻，已拆到独立的 runStealTick（成熟驱动）。
// 调度器首次启动的首次到期窗口由 friendCheckIntervalMin/Max 决定（30~35 秒），
// 之后每轮结束都按这里的固定间隔推进 nextFriendRunAt。
const HELP_TICK_INTERVAL_MS = 10 * 60 * 1000;

async function runFriendTick(auto: any): Promise<void> {
    if (friendTaskRunning) return;
    const generation = runtimeGeneration;
    const helpMs = HELP_TICK_INTERVAL_MS;
    // friend 总开关仍控制好友任务总入口；关闭时也要推进到期时间，避免调度器每秒空转。
    if (!auto.friend) {
        nextFriendRunAt = Date.now() + helpMs;
        return;
    }

    const foregroundYieldMs = nextForegroundYieldMs('friend');
    if (foregroundYieldMs > 0) {
        nextFriendRunAt = Date.now() + foregroundYieldMs;
        return;
    }

    const friendDeferMs = nextBusinessTickDeferMs('friend');
    if (friendDeferMs > 0) {
        nextFriendRunAt = Date.now() + friendDeferMs;
        return;
    }

    friendTaskRunning = true;
    try {
        // 帮助循环保留各自开关、经验上限、黑名单和每日捣乱次数判断。
        // 偷菜已拆到独立的成熟驱动 Tick（runStealTick），这里只管帮忙与放虫放草。
        await runWithRequestClass('friend', async () => {
            if (auto.friend_help) await checkFriends({ onlyHelp: true });
            if (auto.friend_bad) await checkFriends({ onlyBad: true });
            if (auto.friend_golden_bug) await runGoldenBugPlacement();
        });
    } catch (e: any) {
        log('系统', `好友帮助任务执行失败: ${e.message}`, { module: 'system', event: '好友帮助任务', result: 'error' });
    } finally {
        // 账号已经重启/停跑时不要再把旧轮次的到期时间写回去。
        if (generation === runtimeGeneration) {
            nextFriendRunAt = Date.now() + helpMs;
            friendTaskRunning = false;
            scheduleUnifiedNextTick();
        }
    }
}

// ============ 偷菜 Tick（成熟驱动，老版本 runStealTick 移植）============
async function runStealTick(auto: any): Promise<void> {
    if (stealTaskRunning) return;
    const generation = runtimeGeneration;
    if (!auto.friend || !auto.friend_steal) {
        nextStealRunAt = Date.now() + (15 * 60 * 1000);
        return;
    }
    const deferMs = nextBusinessTickDeferMs('friend');
    if (deferMs > 0) {
        nextStealRunAt = Date.now() + deferMs;
        return;
    }
    stealTaskRunning = true;
    nextStealDelayMs = 0;
    try {
        await runWithRequestClass('friend', async () => {
            nextStealDelayMs = await runScheduledStealCheck();
        });
    } catch (e: any) {
        log('系统', `偷菜巡查执行失败: ${e.message}`, { module: 'system', event: '偷菜巡查', result: 'error' });
    } finally {
        if (generation === runtimeGeneration) {
            nextStealRunAt = Date.now() + Math.max(1000, Number(nextStealDelayMs) || 15 * 60 * 1000);
            stealTaskRunning = false;
            scheduleUnifiedNextTick();
        }
    }
}

async function runUnifiedTick(): Promise<void> {
    if (!unifiedSchedulerRunning || !loginReady) return;
    const generation = runtimeGeneration;
    const now = Date.now();
    const dueFarm = now >= nextFarmRunAt;
    const dueFriend = now >= nextFriendRunAt;
    const dueSteal = now >= nextStealRunAt;
    if (!dueFarm && !dueFriend && !dueSteal) return;

    const auto = getAutomation();
    // 农场仍串行（要等它真做完）；好友/偷菜在访问间隔中会让出锁，不必让它们挡住后续 tick。
    if (dueFarm) await runExclusiveAutomationTask('farm_tick', () => runFarmTick(auto), {
        priority: true,
        timeoutMs: FARM_TICK_LOCK_WAIT_MS,
    });
    if (!unifiedSchedulerRunning || !loginReady || generation !== runtimeGeneration) return;
    // 好友/偷菜这里**不能**再套一层自动化锁：checkFriends 内部按单次访问用 detached 独立入队，
    // 一旦外层也持锁，那些 detached 调用会排到「外层任务自己」后面，而外层正在 await 它们 —— 死锁。
    if (dueFriend && !friendTaskRunning) void runFriendTick(auto).catch(() => null);
    if (dueSteal && !stealTaskRunning) void runStealTick(auto).catch(() => null);
}

function scheduleUnifiedNextTick(): void {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');
    if (!loginReady) return;

    const now = Date.now();
    // 正在跑的任务不参与排期：它的 finally 会重新排一次，避免盯着一个已经过期的到期时间空转。
    const nextAt = Math.min(
        farmTaskRunning ? Number.POSITIVE_INFINITY : (Number(nextFarmRunAt) || (now + 1000)),
        friendTaskRunning ? Number.POSITIVE_INFINITY : (Number(nextFriendRunAt) || (now + 1000)),
        stealTaskRunning ? Number.POSITIVE_INFINITY : (Number(nextStealRunAt) || (now + 1000))
    );
    if (!Number.isFinite(nextAt)) return;
    const delayMs = Math.max(1000, nextAt - now); // 最低 1 秒

    workerScheduler.setTimeoutTask('unified_next_tick', delayMs, async () => {
        try {
            await runUnifiedTick();
        } finally {
            scheduleUnifiedNextTick();
        }
    });
}

function startUnifiedScheduler(): void {
    if (unifiedSchedulerRunning) return;
    unifiedSchedulerRunning = true;
    resetUnifiedSchedule();
    scheduleUnifiedNextTick();
}

function stopUnifiedScheduler(): void {
    unifiedSchedulerRunning = false;
    // 三个「运行中」标记必须一起清：漏掉的那个在下一轮登录后会一直为 true，
    // 对应的 tick 会被自己的守卫永久挡住（偷菜尤其明显，只能重启容器才恢复）。
    farmTaskRunning = false;
    friendTaskRunning = false;
    stealTaskRunning = false;
    workerScheduler.clear('unified_next_tick');
    // 停机 300ms 内可能被重新拉起，让路/退避状态不带进新会话。
    businessBackoffMs.farm = 0;
    businessBackoffMs.friend = 0;
    businessBackoffStreak.farm = 0;
    businessBackoffStreak.friend = 0;
    businessBackoffTotalMs.farm = 0;
    businessBackoffTotalMs.friend = 0;
    foregroundYieldStreak.farm = 0;
    foregroundYieldStreak.friend = 0;
    nextStealDelayMs = 0;
}

function stopMysteryShopTimer(): void {
    workerScheduler.clear('mystery_shop_initial');
    workerScheduler.clear('mystery_shop_interval');
    workerScheduler.clear('mystery_shop_after_save');
}

/** 活动自动化：与农场主循环同进程，按 automation 开关逐项执行活动领取。 */
function startActivityAutomationTimer(): void {
    if (!loginReady) return;
    // 开启状态每轮由 getAutomationSnapshot() 现读，所以配置下发时无需重建；
    // 而重建会把 5 分钟周期清零——面板上频繁保存设置时，活动自动化会被无限推后。
    // 保存后立即生效由 scheduleActivityAutomationAfterSave 的 2 秒补跑负责。
    if (workerScheduler.has('activity_automation_interval')) return;
    const { startActivityAutomation } = require('../services/activity-automation');
    startActivityAutomation(workerScheduler);
}


/**
 * 登录完成后的启动序列。
 *
 * 以前这里是四个错峰定时器（2s / 8s / 45s / 60s），结果每日礼包和任务要等到登录一分钟后
 * 才领，而且那时农场和好友循环已经在跑，几件事叠在一起反而把连接打满。
 * 现在改成登录动作一结束就**串行**跑完：串行意味着同一时刻只有一个业务请求在飞，
 * 既领得及时，也不会和心跳抢连接。
 */
async function runStartupSequence(canContinue: () => boolean = () => loginReady): Promise<void> {
    if (!loginReady || !canContinue()) return;

    // 这个序列跑在登录初始化的 await 链上（心跳和 ACE 此时已经启动），
    // 抛出去会被 network.ts 当成「登录初始化失败」直接掐掉连接，所以整段自己兜住异常。
    try {
        // 登录期要领的东西按 farm 班次串行跑完：邮件 / 每日分享 / 月卡 / 免费礼包 / VIP → 任务。
        await runWithRequestClass('farm', async () => {
            if (!loginReady || !canContinue()) return;
            await runExclusiveAutomationTask('daily_routines', () => runDailyRoutines(true));

            if (!loginReady || !canContinue()) return;
            try {
                await checkAndClaimTasks();
            } catch (e: any) {
                log('系统', `登录后领取任务失败: ${e.message}`, { module: 'system', event: '启动序列', result: 'error' });
            }
        });

        if (!loginReady || !canContinue()) return;
        // 登录串行部分跑完，才挂上主循环和后续周期性定时器，避免启动期任务叠跑。
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });
        startUnifiedScheduler();
        startDailyRoutineTimer(false);
        startMysteryShopTimer();
        startActivityAutomationTimer();
        startPetFeedCheckTimer();
    } catch (e: any) {
        log('系统', `登录启动序列执行失败: ${e.message}`, { module: 'system', event: '启动序列', result: 'error' });
    }
}

function runMysteryShopTick(): Promise<void> {
    if (!loginReady) return Promise.resolve();
    const {
        isMysteryShopWatchEnabled,
        checkMysteryShopTick,
    } = require('../services/mystery-shop-auto');
    if (!isMysteryShopWatchEnabled(getAutomation())) return Promise.resolve();
    return checkMysteryShopTick().then((result: any) => {
        // 面板内消息（局内通知）：本地落盘即可，不依赖外部推送渠道；写失败不影响外部提醒。
        if (result?.event) {
            try {
                require('../services/panel-notification').appendPanelNotification(
                    String(process.env.FARM_ACCOUNT_ID || ''),
                    result.event,
                );
            } catch (e: any) {
                logWarn('商城', `面板消息写入失败: ${e.message}`, {
                    module: 'shop', event: '面板消息', result: 'error', error: e.message,
                });
            }
        }
        if (result?.push?.title && result?.push?.content) {
            sendToMaster({ type: 'push_notify', title: result.push.title, content: result.push.content });
        }
    });
}

function startMysteryShopTimer(): void {
    const {
        isMysteryShopWatchEnabled,
        AUTO_BUY_CHECK_INTERVAL_MS,
    } = require('../services/mystery-shop-auto');
    if (!loginReady || !isMysteryShopWatchEnabled(getAutomation())) {
        stopMysteryShopTimer();
        return;
    }
    // 巡查间隔没有变化时不要重建：setIntervalTask 会先 clear 再注册，
    // 每保存一次设置就把下一次巡查推后一整个周期（默认 10 分钟）。
    if (workerScheduler.has('mystery_shop_interval')) return;
    stopMysteryShopTimer();
    // 对齐老版 mystery_shop_auto_buy_initial：登录后 10 秒先探一次（商人可能在登录后任意时间出现）。
    workerScheduler.setTimeoutTask('mystery_shop_initial', 10 * 1000, () => {
        runExclusiveAutomationTask('mystery_shop', runMysteryShopTick).catch(() => null);
    });
    workerScheduler.setIntervalTask('mystery_shop_interval', AUTO_BUY_CHECK_INTERVAL_MS, () => {
        runExclusiveAutomationTask('mystery_shop', runMysteryShopTick).catch(() => null);
    });
}

function applyRuntimeConfig(snapshot: any, syncNow: boolean = false): number {
    const rev = Number((snapshot || {}).__revision || 0);
    if (rev > 0 && rev < appliedConfigRevision) {
        if (syncNow) syncStatus();
        return appliedConfigRevision;
    }
    // 同一个 revision 的补充下发（好友黑名单 / 已知 GID 同步）只需要把新配置内容
    // 应用进来，不能重复跑「保存后重排」那一整套副作用：那会反复重置成熟驱动的
    // 偷菜排程、重建活动定时器、重复安排 after_save 任务。rev=0 是面板开关这类
    // 不带版本号的局部下发，仍按一次真实变更处理。
    const freshRevision = rev > appliedConfigRevision;

    const prevAuto = getAutomation();
    const { getCapitalMode } = require('../models/store');
    // 单测里 store 常被局部 mock，缺这个函数时按「无资本模式」处理即可。
    const prevCapitalMode = typeof getCapitalMode === 'function' ? getCapitalMode() : null;
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    if (snapshot && snapshot.systemTimeZone !== undefined) {
        updateRuntimeConfig({ timeZone: snapshot.systemTimeZone });
    }
    if (!loginReady && snapshot && snapshot.systemServerUrl !== undefined) {
        updateRuntimeConfig({ serverUrl: String(snapshot.systemServerUrl || '') });
    }
    if (!loginReady && snapshot?.systemDeviceInfo) {
        updateRuntimeConfig({ deviceInfo: snapshot.systemDeviceInfo });
    }
    if (!loginReady && snapshot?.systemWxClientVersion !== undefined) {
        updateRuntimeConfig({ wxClientVersion: String(snapshot.systemWxClientVersion || '') });
    }
    if (!loginReady && snapshot && snapshot.systemClientVersion !== undefined) {
        updateRuntimeConfig({ clientVersion: String(snapshot.systemClientVersion || '') });
    }
    const appliedSnapshot = applyConfigSnapshot(snapshot || {}, { persist: false, accountId });
    // 邮箱每日检查时刻按账号生效：这里必须每次配置下发都同步，
    // 否则 email 服务拿不到账号与时刻，状态不会落盘、会反复请求。
    configureEmailClaim({ hour: appliedSnapshot.emailClaimHour, accountId });
    if (rev > appliedConfigRevision) appliedConfigRevision = rev;

    // 资本模式配置变更（关闭/换狗）时收回自动派出的宠物。
    try {
        require('../services/capital-mode').reconcileConfigChange(prevCapitalMode, getCapitalMode()).catch(() => null);
    } catch {
        // capital-mode 未初始化时忽略
    }

    // 优先使用本次下发的间隔，避免 worker 内部 store 漂移导致回退默认值
    const incomingIntervals = (snapshot && snapshot.intervals && typeof snapshot.intervals === 'object')
        ? snapshot.intervals
        : null;
    if (incomingIntervals) {
        applyIntervalsToRuntime(incomingIntervals);
    }

    if (loginReady && (freshRevision || rev === 0)) {
        refreshFarmCheckLoop(200);
        refreshFriendCheckLoop(200);
        resetUnifiedSchedule({ preserveSteal: true });
        scheduleUnifiedNextTick();

        const hasAutomationPayload = !!(snapshot && snapshot.automation && typeof snapshot.automation === 'object');
        if (hasAutomationPayload) {
            const nextAuto = getAutomation();

            const prevFertilizerMode = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const nextFertilizerMode = String(nextAuto && nextAuto.fertilizer ? nextAuto.fertilizer : '').toLowerCase();
            const fertilizerChanged = prevFertilizerMode !== nextFertilizerMode;
            // 老版口径：2×2 催熟从关变开也立即触发一轮施肥（skipNormal，由内部单独催熟）。
            const size2RipenEnabled = !(prevAuto && prevAuto.fertilizer_2x2_ripen === true) && nextAuto && nextAuto.fertilizer_2x2_ripen === true;
            if (size2RipenEnabled || (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic' || nextFertilizerMode === 'smart'))) {
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 600, async () => {
                    if (!loginReady) return;
                    try {
                        await runExclusiveAutomationTask('fertilizer_immediate', () => runFertilizerByConfig([], { skipNormal: true }));
                    } catch (e: any) {
                        log('施肥', `保存配置后立即施肥失败: ${e.message}`, {
                            module: 'farm',
                            event: '施肥',
                            result: 'error',
                        });
                    }
                });
            }

            startMysteryShopTimer();
            startActivityAutomationTimer();
            startPetFeedCheckTimer();
            // 化肥自动购买检测：原来只在 startFarmCheckLoop（登录/启动）建一次，
            // 而两个开关默认都是关的，登录时定时器根本不会建；之后在面板打开开关
            // 也不会再调用，功能永远不启动，间隔改了也不生效。这里随配置下发重建
            // （内部按「开关 + 间隔」签名去重，配置没变不会重置计时）。
            startFertilizerBuyCheckTimer();

            // 对齐老版 mystery_shop_auto_buy_after_save：神秘商人相关开关变化且巡查已启用时，
            // 保存后 2 秒立即巡查一次，不用等下一个 10 分钟周期。
            // 用服务侧的键表，避免新增货币 / 通知开关后这里漏配（钻石、到货提醒、购买通知曾遗漏）。
            // 图鉴每日自动化的两个开关由关变开时，保存后 2 秒立即检查一次，
            // 不必等明天或重登；同一天的例行检查仍由服务内部日期键去重。
            const illustratedSwitchedOn = ILLUSTRATED_AUTO_KEYS.some(key => !(prevAuto && prevAuto[key] === true) && nextAuto && nextAuto[key] === true);
            if (illustratedSwitchedOn) {
                workerScheduler.setTimeoutTask('illustrated_auto_after_save', 2000, () => {
                    if (!loginReady) return;
                    runExclusiveAutomationTask('illustrated_auto', () => runIllustratedDailyAutomation(true)).catch(() => null);
                });
            }

            const { isMysteryShopWatchEnabled, mysteryShopConfigChanged } = require('../services/mystery-shop-auto');
            if (isMysteryShopWatchEnabled(nextAuto) && mysteryShopConfigChanged(prevAuto, nextAuto)) {
                workerScheduler.setTimeoutTask('mystery_shop_after_save', 2000, () => {
                    if (!loginReady) return;
                    runExclusiveAutomationTask('mystery_shop', runMysteryShopTick).catch(() => null);
                });
            }

            // 对齐老版 star_activity_claim_after_save：保存自动化配置后 2 秒立即跑一轮，
            // 新开启的开关清掉冷却，本轮即可生效，不用等下一个 5 分钟周期。
            try {
                const { scheduleActivityAutomationAfterSave, resetCooldownsForEnabledKeys } = require('../services/activity-automation');
                const nextAutoAll = getAutomation();
                resetCooldownsForEnabledKeys(Object.keys(nextAutoAll)
                    .filter(key => nextAutoAll[key] === true && !(prevAuto && prevAuto[key] === true)));
                scheduleActivityAutomationAfterSave(workerScheduler);
            } catch {
                // 活动自动化未初始化时忽略
            }

            // 对齐老版：放黄金虫开关从关变开时，保存后 2 秒立即投放一轮（force）。
            const goldenBugEnabled = !!(nextAuto && nextAuto.friend_golden_bug === true)
                && !(prevAuto && prevAuto.friend_golden_bug === true);
            if (goldenBugEnabled) {
                workerScheduler.setTimeoutTask('golden_bug_after_save', 2000, () => {
                    if (!loginReady) return;
                    runGoldenBugPlacement({ force: true }).catch(() => null);
                });
            }
        }
    }

    if (syncNow) syncStatus();
    return appliedConfigRevision;
}

// 接收主进程指令
onMasterMessage(async (msg: any) => {
    try {
        if (msg.type === 'start') {
            try {
                await startBot(msg.config);
            } catch (startError: any) {
                // startBot 一进来就把 isRunning 置 true；初始化阶段（config 缺字段 /
                // loadProto 失败 / connect 因空 Code 抛错）失败时不回滚，之后所有 start
                // 消息都会被 `if (isRunning) return` 静默吞掉，账号再也起不来。
                isRunning = false;
                shutdownStarted = false;
                throw startError;
            }
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            // fire-and-forget 的 async 函数一旦拒绝就是 Node 20 的致命错误，
            // 外层同步 try/catch 完全拦不住，必须显式挂 catch。
            void handleApiCall(msg).catch((error: any) => {
                sendApiResponse(msg.id, null, {
                    message: String((error && error.message) || error || 'Worker API error'),
                    name: String((error && error.name) || 'Error'),
                });
            });
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        } else if (msg.type === 'reload_config') {
            if (typeof loadConfigs === 'function') loadConfigs();
        }
    } catch (e: any) {
        sendToMaster({
            type: 'error',
            error: {
                message: String(e?.message || e || 'Worker error'),
                code: e?.code,
                errorMessage: e?.errorMessage ?? e?.error_message,
                name: String(e?.name || 'Error'),
            },
        });
    }
});

async function startBot(config: any): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    shutdownStarted = false;
    runtimeGeneration += 1;

    const { code, platform, systemTimeZone, systemServerUrl, systemClientVersion, systemWxClientVersion, systemDeviceInfo } = config;

    if (systemTimeZone !== undefined) updateRuntimeConfig({ timeZone: systemTimeZone });
    if (systemServerUrl !== undefined) updateRuntimeConfig({ serverUrl: String(systemServerUrl || '') });
    if (systemDeviceInfo) updateRuntimeConfig({ deviceInfo: systemDeviceInfo });
    if (systemWxClientVersion !== undefined) updateRuntimeConfig({ wxClientVersion: String(systemWxClientVersion || '') });
    if (systemClientVersion !== undefined) updateRuntimeConfig({ clientVersion: String(systemClientVersion || '') });
    CONFIG.platform = platform || 'qq';
    // 注意：间隔配置由 applyIntervalsToRuntime 统一处理，不要在这里覆盖

    await loadProto();

    log('系统', '正在连接服务器...');

    // 加载保存的配置
    applyRuntimeConfig(getConfigSnapshot(), false);

    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (payload: any) => {
        if ((Number(payload?.code) || 0) !== 400) return;
        const now = Date.now();
        if (now - wsErrorHandledAt < 4000) return;
        wsErrorHandledAt = now;
        log('系统', '连接被拒绝，可能需要更新 Code');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: payload?.message || '',
        });
        if (isRunning) {
            handleTerminalDisconnect({
                source: 'ws_error',
                code: 400,
                reason: payload?.message || '连接被拒绝',
                phase: 'connecting',
            });
        }
    };
    networkEvents.on('ws_error', onWsError);

    if (onDisconnected) {
        networkEvents.off('disconnected', onDisconnected);
    }
    onDisconnected = (payload: any) => {
        handleTerminalDisconnect(payload);
    };
    networkEvents.on('disconnected', onDisconnected);
    networkEvents.on('kickout', onKickout);

    const generation = runtimeGeneration;
    const canContinueLogin = (): boolean => isRunning && !shutdownStarted && generation === runtimeGeneration;
    const onLoginSuccess = async (): Promise<void> => {
        if (!canContinueLogin() || loginReady) return;
        loginReady = true;
        if (onSellGain) {
            networkEvents.off('sell', onSellGain);
        }
        onSellGain = (sellInfo: any) => {
            // warehouse 恒向事件里发 { gold, count }；以 count（实际卖出果实数量）为准。
            // 旧口径的 `gold || sellInfo` 在 gold===0 时会回落成对象，Number(obj) 得 NaN，
            // 进而直接 return 丢掉本次卖出计数。这里只认 count，不依赖金币金额。
            const count = Number(sellInfo && typeof sellInfo === 'object' ? sellInfo.count : 0) || 0;
            if (count > 0) recordOperation('sell', count);
        };
        networkEvents.on('sell', onSellGain);

        if (onFarmHarvested) {
            networkEvents.off('farmHarvested', onFarmHarvested);
        }
        onFarmHarvested = async () => {
            // 收获后 2 秒补一次活动自动化（老版 rain_poem_after_harvest）：
            // 雷雨期间的收获进度决定要不要续下一场雨，必须排在出售守卫之前。
            if (getAutomation().rain_poem_summon_use === true) {
                const { scheduleActivityAutomationAfterHarvest } = require('../services/activity-automation');
                scheduleActivityAutomationAfterHarvest();
            }
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await runExclusiveAutomationTask('harvest_sell', sellAllFruits);
            } catch (e: any) {
                log('仓库', `收获后自动出售失败: ${e.message}`, { module: 'warehouse', event: '收获后出售', result: 'error' });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        if (onDogSkillGiftPending) {
            networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        }
        onDogSkillGiftPending = (count: any) => {
            const pendingCount = Math.max(0, toNum(count));
            if (pendingCount <= 0 || !loginReady) return;
            runExclusiveAutomationTask('dog_skill_gifts', () => checkAndClaimDogSkillGifts(pendingCount)).catch(() => null);
        };
        networkEvents.on('dogSkillGiftPending', onDogSkillGiftPending);

        try {
            await runExclusiveAutomationTask('activity_windows_refresh', refreshActivityWindows);
        } catch (e: any) {
            logWarn('仓库', `活动时间初始化失败: ${e?.message || e}`);
        }
        if (!canContinueLogin()) return;

        // 登录后只拉一次背包，同时初始化点券（1002）和金豆豆（1005）
        // goldBeanReady 决定金豆当日基线能否用登录余额：背包拉取失败时
        // userState.goldBean 仍是占位 0，拿它当基线会把全部余额算成今日净增。
        let goldBeanReady = false;
        try {
            const bagReply = await runExclusiveAutomationTask('login_bag_init', getBag);
            const items = getBagItems(bagReply);
            let coupon = 0;
            let goldBean = 0;
            for (const it of (items || [])) {
                const id = toNum(it && it.id);
                if (id === 1002) {
                    coupon = toNum(it.count);
                } else if (id === 1005) {
                    goldBean = toNum(it.count);
                }
            }
            const state = getUserState();
            state.coupon = Math.max(0, coupon);
            state.goldBean = Math.max(0, goldBean);
            goldBeanReady = true;
        } catch {
            // 背包拉取失败：金豆基线传 null，等 ItemNotify 带回权威余额后再起算。
        }
        // 登录成功后，以当前金币/经验/点券作为统计基线，并清空会话增量
        const latest = getUserState();
        const accountId = process.env.FARM_ACCOUNT_ID || '';
        try {
            // 传原始值而不是 Number(x || 0)：登录回包缺字段时 0 是「假基线」，
            // 会把整个账户余额算成今日净增。未知就让 stats 留 null，等首次有效观测起算。
            initStatsWithPersistence(
                accountId,
                latest.gold ?? null,
                latest.exp ?? null,
                latest.coupon ?? null,
                goldBeanReady ? (latest.goldBean ?? 0) : null,
            );
            resetSessionGains();
        } catch (e: any) {
            // 统计落盘失败（磁盘只读/写满）不应反噬已建立的连接。
            logWarn('系统', `登录后统计初始化失败: ${e?.message || e}`, { module: 'system', event: '统计初始化', result: 'error' });
        }

        // 以下均为附属初始化。network 的 sendLogin 会把 onLoginSuccess 抛出的错误
        // 当成「登录初始化失败」直接 finalize + terminate 连接，所以每一步都必须自带
        // 兜底，避免附属功能的小故障把刚登录成功的健康连接掐掉（可形成重启循环）。
        try {
            await runExclusiveAutomationTask('invite_codes', processInviteCodes);
        } catch (e: any) {
            logWarn('系统', `登录后邀请码处理失败: ${e?.message || e}`, { module: 'system', event: '邀请码处理', result: 'error' });
        }
        if (!canContinueLogin()) return;
        if (getAutomation().fertilizer_gift) {
            await runExclusiveAutomationTask('fertilizer_gifts_login', openFertilizerGiftPacksSilently).catch(() => 0);
            if (!canContinueLogin()) return;
        }

        if (!canContinueLogin()) return;
        // 立即发送一次状态，再串行跑启动序列（不阻塞状态上报）
        try {
            syncStatus();
        } catch (e: any) {
            logWarn('系统', `登录后状态同步失败: ${e?.message || e}`, { module: 'system', event: '状态同步', result: 'error' });
        }
        try {
            await runExclusiveAutomationTask('startup_sequence', () => runStartupSequence(canContinueLogin));
        } catch (e: any) {
            logWarn('系统', `启动序列执行失败: ${e?.message || e}`, { module: 'system', event: '启动序列', result: 'error' });
        }
    };

    connect(code, onLoginSuccess);

    // 启动定时状态同步（对齐老版 resource-policy：默认 10s，可用 FARM_STATUS_SYNC_INTERVAL_MS 覆盖）。
    workerScheduler.setIntervalTask('status_sync', statusSyncIntervalMs(), syncStatus, { preventOverlap: true });

    // 请求画像（只写文件，5 分钟一行）：额度过紧时能直接看出是哪个接口在吃自动任务额度。
    workerScheduler.setIntervalTask('gateway_profile', 5 * 60 * 1000, () => {
        try {
            const profile = getRequestProfile();
            const top = profile.top.slice(0, 5)
                .map((item: any) => `${item.method.split('.').slice(-1)[0]}×${item.count}`)
                .join(' ');
            logFileOnly(
                '系统',
                `60s 流量画像: 自动 ${profile.autoCount}/${profile.totalLimit}, `
                + `前台 ${profile.foregroundCount}, 保命 ${profile.criticalCount}, `
                + `累计让路 ${profile.droppedTotal}${top ? ` | ${top}` : ''}`,
            );
        } catch {}
    }, { preventOverlap: true });
}

/** 老版 runtime/resource-policy.js：statusSyncIntervalMs = env 覆盖，否则 10s（低内存 30s）。 */
function statusSyncIntervalMs(): number {
    const env = Number.parseInt(String(process.env.FARM_STATUS_SYNC_INTERVAL_MS || ''), 10);
    if (Number.isFinite(env) && env >= 1000) return env;
    return 10 * 1000;
}

function detachRuntimeListeners(): void {
    networkEvents.off('kickout', onKickout);
    if (onDisconnected) {
        networkEvents.off('disconnected', onDisconnected);
        onDisconnected = null;
    }
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }
    if (onDogSkillGiftPending) {
        networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        onDogSkillGiftPending = null;
    }
}

function quiesceBot(reason: string): void {
    shutdownStarted = true;
    runtimeGeneration += 1;
    isRunning = false;
    loginReady = false;
    stopUnifiedScheduler();
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopPetFeedCheckTimer();
    stopDailyRoutineTimer();
    cleanupTaskSystem();
    // 2×2 预留窗口、整轮闸门、已注册布局都是模块级跨轮状态；
    // 停机/重登时统一复位，避免 thread 复用时把上一轮的身份签名带进新会话。
    try {
        require('../services/farm/planting').resetPlantingRoundState();
    } catch {
        // 种植引擎尚未加载时无需复位
    }
    workerScheduler.clearAll();
    detachRuntimeListeners();
    cleanup(reason);
    syncStatus(true);
}

async function stopBot(): Promise<void> {
    if (!shutdownStarted) {
        saveStats();
        quiesceBot('主动停止');
    }
    exitWorker(0);
}

function handleTerminalDisconnect(payload: any): void {
    if (shutdownStarted) return;
    const source = String(payload?.source || 'ws_close');
    const code = Number(payload?.code) || 0;
    const reason = String(payload?.reason || '连接已断开');
    const phase = String(payload?.phase || 'unknown');
    log('系统', `连接已断开，等待自动补 Code 重登 (source=${source}, code=${code}, phase=${phase})`, {
        source, disconnectCode: code, reason, phase, diagnostics: payload?.diagnostics || null,
    });
    saveStats();
    quiesceBot(`连接断开: ${source}`);
    sendToMaster({
        type: 'account_disconnected',
        source,
        code,
        reason,
        phase,
        connectionId: Number(payload?.connectionId) || 0,
        diagnostics: payload?.diagnostics || null,
        at: Number(payload?.at) || Date.now(),
    });
    setTimeout(exitWorker, 300, 0);
}

function onKickout(payload: any): void {
    if (shutdownStarted) return;
    const reason = payload && payload.reason ? payload.reason : '未知';
    const reasonCode = Number(payload?.reasonCode) || 0;
    const diagnostics = payload?.diagnostics || null;
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${reason} (${reasonCode})`, { reasonCode, diagnostics });
    saveStats();
    quiesceBot(`踢下线: ${reason}`);
    sendToMaster({ type: 'account_kicked', reason, reasonCode, diagnostics });
    setTimeout(exitWorker, 300, 0);
}

// 处理来自 Admin 面板的直接调用请求 (如: 购买种子、开关设置等)
async function handleApiCall(msg: any): Promise<void> {
    const { id, method, args } = msg;
    let result: any = null;
    let error: { message: string; code?: string | number; errorMessage?: string; name?: string } | string | null = null;

    try {
        if (method === 'applyRuntimeConfigSnapshot') {
            const appliedRevision = applyRuntimeConfig((args && args[0]) || {}, true);
            result = { appliedRevision };
        } else {
            if (!isRunning || shutdownStarted || !loginReady) {
                throw new Error('账号未连接');
            }
            switch (method) {
            case 'getLands':
                result = await getLandsDetail(args[0] === true);
                break;
            case 'getCareerProfile':
                // 个人页（角色生涯）：按当前账号自己的 GID 拉取完整收获明细。
                result = await require('../services/career').getCareerProfile(getUserState().gid);
                break;
            case 'getIllustratedSnapshot':
                result = await require('../services/illustrated').getIllustratedSnapshot();
                break;
            case 'getCollectionsSnapshot':
                result = await require('../services/collections').getCollectionsSnapshot();
                break;
            case 'operateCollections':
                result = await require('../services/collections').operateCollections(args[0], args[1]);
                break;
            case 'claimIllustratedRewards':
                result = await require('../services/illustrated').claimIllustratedRewards(args[0]);
                break;
            case 'getSolarCalendar':
                result = await require('../services/solar-calendar').getSolarCalendar();
                break;
            case 'operateSolarCalendar':
                result = await require('../services/solar-calendar').operateSolarCalendar(args[0], args[1]);
                break;
            case 'getFriends':
                result = await getFriendsList(args[0] === true, 'normal', args[1] === true);
                break;
            case 'getFriendsCache':
                result = getFriendsListCacheOnly();
                break;
            case 'clearFriendsCache':
                require('../services/friend').clearFriendsListCache();
                result = { ok: true };
                break;
            case 'getInteractRecords':
                result = await getInteractRecords();
                break;
            case 'getFriendLands':
                result = await getFriendLandsDetail(args[0], args[1] === true);
                break;
            case 'getFriendInteractionItems':
                result = await require('../services/friend-interaction-items').getFriendInteractionItems(args[0] === true);
                break;
            case 'useFriendInteractionItemBatch':
                result = await require('../services/friend-interaction-items').useFriendInteractionItemBatch(args[0], args[1], args[2], args[3] === true);
                break;
            case 'useFriendFarmInteractionItem':
                result = await require('../services/friend-interaction-items').useFriendFarmInteractionItem(args[0], args[1], args[2] === true);
                break;
            case 'getSelfInteractionItems':
                result = await require('../services/friend-interaction-items').getSelfInteractionItems(args[0] === true);
                break;
            case 'useSelfInteractionItemBatch':
                result = await require('../services/friend-interaction-items').useSelfInteractionItemBatch(args[0], args[1], args[2] === true);
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1], args[2] === true);
                break;
            case 'delFriend':
                result = await deleteFriend(args[0]);
                break;
            case 'getSeeds':
                result = await getAvailableSeeds(args[0] === true);
                break;
            case 'purchaseSeed':
                result = await purchaseSeed(args[0], args[1]);
                break;
            case 'getBag':
                result = await require('../services/warehouse').getBagDetail();
                break;
            case 'getBagSeeds':
                result = await require('../services/warehouse').getBagSeeds();
                break;
            case 'getDiamondBalance':
                result = await require('../services/pay').getDiamondBalance();
                break;
            case 'useItem': {
                const { useItem: _useItem } = require('../services/warehouse');
                // `Number(args[0]) || 0` 对 `1e400` 得到 Infinity：它是 truthy，`||` 不生效。
                const itemId = readId(args[0], 'itemId');
                const count = readCountOr(args[1], 1, 'count');
                const uid = readNonNegativeIntOr(args[2], 0, 'uid');
                result = await _useItem(itemId, count, [], uid);
                break;
            }
            case 'sellItems': {
                const { sellItems: _sell } = require('../services/warehouse');
                const sellList = Array.isArray(args[0]) ? args[0] : [];
                // 手动出售同样按老版口径记录：累计卖出果实数量。
                const sellTotalCount = sellList.reduce((sum: number, it: any) => sum + (Number(it?.count) || 0), 0);
                result = await _sell(sellList.map((it: any) => ({
                    id: it.id,
                    count: it.count,
                    uid: it.uid || 0,
                    expire_time: it.expireTime ?? it.expire_time,
                })));
                if (sellTotalCount > 0) recordOperation('sell', sellTotalCount);
                break;
            }
            case 'setItemsLocked':
                result = await require('../services/warehouse').setItemsLocked(args[0], args[1] === true);
                break;
            case 'getDogSkillGiftStatus': {
                const dogGifts = require('../services/dog-skill-gifts');
                const info = await dogGifts.getDogInfo();
                result = { pendingCount: dogGifts.getPendingGiftCount(info) };
                break;
            }
            case 'claimDogSkillGifts':
                result = await require('../services/dog-skill-gifts').checkAndClaimDogSkillGifts(undefined, true);
                break;
            case 'getPetInfo':
                result = await require('../services/pets').getPetInfo();
                break;
            case 'activateDog':
                result = await require('../services/pets').activateDog(args[0]);
                break;
            case 'deployDog':
                // 手动派出：释放资本模式的自动召回所有权。
                try {
                    require('../services/capital-mode').releaseForManualCommand();
                } catch {
                    // capital-mode 未初始化时忽略
                }
                result = await require('../services/pets').deployDog(args[0]);
                break;
            case 'withdrawDog':
                result = await require('../services/pets').withdrawDog();
                break;
            case 'useDogFood':
                result = await require('../services/pets').useDogFood(args[0], args[1], args[2]);
                break;
            case 'getPetProtectLogs':
                result = await require('../services/pets').getProtectLogs();
                break;
            case 'setAutomation': {
                const payload = args && args[0] ? args[0] : {};
                applyRuntimeConfig({ automation: { [payload.key]: payload.value } }, true);
                result = getAutomation();
                break;
            }
            case 'doFarmOp':
                result = await runFarmOperation(args[0], args[1], args[2] === true); // opType, optional targetLandId
                break;
            case 'fertilizeOwnLand':
                result = await fertilizeOwnLand(args[0], args[1]);
                break;
            case 'removePlant':
                result = await require('../services/farm/api').removePlant([readId(args[0], 'landId')]);
                break;
            case 'previewRipenAll':
                result = await require('../services/farm/ripen-all').previewRipenAll();
                break;
            case 'ripenAllStep':
                // cursor 只用于与预览会话比对，非法值落到 0 会直接被判定「预览已失效」。
                result = await require('../services/farm/ripen-all').ripenAllStep(args[0], readNonNegativeIntOr(args[1], 0, 'cursor'));
                break;
            case 'fertilizeAllOwnLands':
                result = await require('../services/farm').fertilizeAllOwnLands(args[0], args[1]);
                break;
            case 'buyFertilizer': {
                const fertilizerType = args[0] || 'organic';
                // 0 = 不限数量，与账户配置的 10000 上限对齐。
                const fertilizerCount = readCountOr(args[1], 0, 'count', 10000, 0);
                result = await autoBuyFertilizer(true, fertilizerType, fertilizerCount, args[2] === true);
                break;
            }
            case 'checkAndBuyFertilizer': {
                const options = args[0] || {};
                result = await checkAndBuyFertilizerBoth(options, args[1] === true);
                break;
            }
            case 'getAnalytics': {
                const { getPlantRankings } = require('../services/analytics');
                result = getPlantRankings(args[0]); // sortBy
                break;
            }
            case 'getDailyGiftOverview':
                result = await getDailyGiftOverview(args[0] === true);
                break;
            case 'getActivityDirectorySnapshot':
                result = await require('../services/activity-center').getActivityDirectorySnapshot();
                break;
            case 'getActivityCenterSnapshot':
                result = await require('../services/activity-center').getActivityCenterSnapshot();
                break;
            case 'getCurrentSeasonEvent':
                result = await require('../services/activity-center').getCurrentSeasonEvent();
                break;
            case 'getCurrentStellarActivity':
                result = await require('../services/activity-center').getCurrentStellarActivity();
                break;
            case 'getCurrentStarSandShop':
                result = await require('../services/activity-center').getCurrentStarSandShop();
                break;
            case 'getCurrentSolarTerms':
                result = await require('../services/activity-center').getCurrentSolarTerms();
                break;
            case 'getCurrentQixiActivity':
                result = await require('../services/activity-center').getCurrentQixiActivity();
                break;
            case 'getCurrentCharityRedFlowerActivity':
                result = await require('../services/activity-center').getCurrentCharityRedFlowerActivity();
                break;
            case 'getPetDiary':
                result = await require('../services/activity-center').getPetDiary();
                break;
            case 'operatePetDiary':
                result = await require('../services/activity-center').operatePetDiary(args[0], args[1]);
                break;
            case 'getPetDiaryRecords':
                result = await require('../services/activity-center').getPetDiaryRecords(args[0]);
                break;
            case 'getPetDiaryFriend':
                result = await require('../services/activity-center').getPetDiaryFriend(args[0]);
                break;
            case 'claimCharityRedFlowerSeeds':
                result = await require('../services/activity-center').claimCharityRedFlowerSeeds();
                break;
            case 'donateCharityRedFlowerLove':
                result = await require('../services/activity-center').donateCharityRedFlowerLove();
                break;
            case 'claimCharityRedFlowerDailyGift':
                result = await require('../services/activity-center').claimCharityRedFlowerDailyGift();
                break;
            case 'claimCharityRedFlowerProgressReward':
                result = await require('../services/activity-center').claimCharityRedFlowerProgressReward(args[0]);
                break;
            case 'getCurrentWeatherActivity':
                result = await require('../services/activity-center').getCurrentWeatherActivity();
                break;
            case 'buyWeatherBottle':
                result = await require('../services/activity-center').buyWeatherBottle(args[0]);
                break;
            case 'collectWeatherBottle':
                result = await require('../services/activity-center').collectWeatherBottle(args[0]);
                break;
            case 'lightWeatherResearch':
                result = await require('../services/activity-center').lightWeatherResearch(args[0]);
                break;
            case 'summonWeatherRain':
                result = await require('../services/activity-center').summonWeatherRain();
                break;
            case 'claimBattlePassRewards':
                result = await require('../services/activity-center').claimBattlePassRewards();
                break;
            case 'exchangeStarSandGoods':
                result = await require('../services/activity-center').exchangeStarSandGoods(args[0], args[1]);
                break;
            case 'lightConstellation':
                result = await require('../services/activity-center').lightConstellation();
                break;
            case 'claimSolarTerm':
                result = await require('../services/activity-center').claimSolarTerm(String(args[0] || ''));
                break;
            case 'getCurrentQingMeiActivity':
                result = await require('../services/activity-center').getCurrentQingMeiActivity();
                break;
            case 'claimQingMeiDailySeed':
                result = await require('../services/activity-center').claimQingMeiDailySeed();
                break;
            case 'startQingMeiBrew':
                result = await require('../services/activity-center').startQingMeiBrew(args[0]);
                break;
            case 'continueQingMeiBrew':
                result = await require('../services/activity-center').continueQingMeiBrew();
                break;
            case 'settleQingMeiBrew':
                result = await require('../services/activity-center').settleQingMeiBrew();
                break;
            case 'claimQixiBridgeRewards':
                result = await require('../services/activity-center').claimQixiBridgeRewards();
                break;
            case 'giftQixiSachet':
                result = await require('../services/activity-center').giftQixiSachet(args[0], args[1]);
                break;
            case 'exchangeWeatherCollectorBottle':
                result = await require('../services/activity-center').exchangeWeatherCollectorBottle();
                break;
            case 'getWeatherFriends':
                result = await require('../services/activity-center').getWeatherFriends();
                break;
            case 'scanWeatherFriends':
                result = await require('../services/activity-center').scanWeatherFriends(args[0]);
                break;
            case 'useWeatherCollectorBottle':
                result = await require('../services/activity-center').useWeatherCollectorBottle(args[0]);
                break;
            case 'useWeatherSummonBottle':
                result = await require('../services/activity-center').useWeatherSummonBottle();
                break;
            case 'useWeatherFrogBottle':
                result = await require('../services/activity-center').useWeatherFrogBottle(args[0]);
                break;
            case 'useWeatherCloudBottle':
                result = await require('../services/activity-center').useWeatherCloudBottle(args[0], args[1]);
                break;
            case 'advanceWeatherResearch':
                result = await require('../services/activity-center').advanceWeatherResearch(args[0]);
                break;
            case 'getAutumnActivity':
                result = await require('../services/autumn-activities').getAutumnActivity(args[0]);
                break;
            case 'getMilkTeaActivity':
                result = await require('../services/milk-tea').getMilkTeaActivity(args[0], args[1]);
                break;
            case 'operateMilkTeaActivity':
                result = await require('../services/milk-tea').operateMilkTeaActivity(args[0], args[1]);
                break;
            case 'getMilkTeaLegacy':
                result = await require('../services/milk-tea-legacy').getMilkTea();
                break;
            case 'operateMilkTeaLegacy':
                result = await require('../services/milk-tea-legacy').operateMilkTea(args[0], args[1]);
                break;
            case 'milkTeaRecordsLegacy':
                result = await require('../services/milk-tea-legacy').milkTeaRecords(args[0], args[1]);
                break;
            case 'getShareRewardActivity':
                result = await require('../services/share-reward-activity').getShareRewardActivity(args[0]);
                break;
            case 'operateShareRewardActivity':
                result = await require('../services/share-reward-activity').operateShareRewardActivity(args[0], args[1], args[2]);
                break;
            case 'operateAutumnActivity':
                result = await require('../services/autumn-activities').operateAutumnActivity(args[0], args[1], args[2]);
                break;
            case 'getPropsShop':
                result = await require('../services/commerce').getPropsShop();
                break;
            case 'purchaseProps':
                result = await require('../services/commerce').purchaseProps(args[0], args[1], args[2]);
                break;
            case 'getMallCatalog':
                result = await require('../services/commerce').getMallCatalog(args[0], args[1]);
                break;
            case 'purchaseMallProduct':
                result = await require('../services/commerce').purchaseMallProduct(args[0], args[1], args[2], args[3]);
                break;
            case 'getMysteryShop':
                result = await require('../services/commerce').getMysteryShop();
                break;
            case 'purchaseMysteryOffer':
                // 后台 API 只可能是页面手动购买；自动购买由 mystery-shop-auto 内部标记 'auto'。
                result = await require('../services/commerce').purchaseMysteryOffer(args[0], 'manual');
                break;
            case 'getSchedulers':
                result = getSchedulerRegistrySnapshot();
                break;
            default:
                error = 'Unknown method';
            }
        }
    } catch (e: any) {
        error = {
            message: String(e?.message || e || 'Worker API error'),
            code: e?.code,
            errorMessage: e?.errorMessage ?? e?.error_message,
            name: String(e?.name || 'Error'),
        };
    }

    sendApiResponse(id, result, error);
}

async function getDailyGiftOverview(propagateErrors: boolean = false): Promise<any> {
    const auto = getAutomation() || {};
    const task = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp(propagateErrors)
        : (getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 });
    const growthTask = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp(propagateErrors)
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };
    const email = getEmailDailyState ? getEmailDailyState() : { doneToday: false, lastCheckAt: 0 };
    const free = getFreeGiftDailyState ? getFreeGiftDailyState() : { doneToday: false, lastClaimAt: 0 };
    const share = getShareDailyState ? getShareDailyState() : { doneToday: false, lastClaimAt: 0 };
    const vip = getVipDailyState ? getVipDailyState() : { doneToday: false, lastClaimAt: 0 };
    const month = getMonthCardDailyState ? getMonthCardDailyState() : { doneToday: false, lastClaimAt: 0 };

    return {
        date: getSystemDateKey(),
        timeZone: CONFIG.timeZone,
        growth: {
            key: 'growth_task',
            label: '成长任务',
            doneToday: !!growthTask.doneToday,
            completedCount: Number(growthTask.completedCount || 0),
            totalCount: Number(growthTask.totalCount || 0),
            currentTask: growthTask.currentTask || null,
            tasks: Array.isArray(growthTask.tasks) ? growthTask.tasks : [],
        },
        gifts: [
            {
                key: 'task_claim',
                label: '每日任务',
                enabled: !!auto.task,
                doneToday: !!task.doneToday,
                lastAt: Number(task.lastClaimAt || 0),
                completedCount: Number(task.completedCount || 0),
                totalCount: Number(task.totalCount || 3),
            },
            // 以下功能默认启用，enabled 固定为 true
            {
                key: 'email_rewards',
                label: '邮箱奖励',
                enabled: true,
                doneToday: email.doneToday,
                lastAt: email.lastCheckAt,
                nextAt: email.nextCheckAt,
                scheduledHour: email.scheduledHour,
                result: email.result,
                lastError: email.lastError,
            },
            { key: 'mall_free_gifts', label: '商城免费礼包', enabled: true, doneToday: !!free.doneToday, lastAt: Number(free.lastClaimAt || 0) },
            {
                key: 'daily_share',
                label: '分享礼包',
                enabled: true,
                mode: 'auto_claim',
                doneToday: !!share.doneToday,
                checkedToday: !!share.checkedToday,
                checkStatus: String(share.checkStatus || 'unchecked'),
                canShare: typeof share.canShare === 'boolean' ? share.canShare : null,
                lastAt: Number(share.lastClaimAt || share.lastCheckAt || 0),
            },
            {
                key: 'vip_daily_gift',
                label: '会员礼包',
                enabled: true,
                doneToday: !!vip.doneToday,
                lastAt: Math.max(Number(vip.lastClaimAt || 0), Number(vip.lastCheckAt || 0)),
                isVip: typeof vip.isVip === 'boolean' ? vip.isVip : null,
                hasGift: typeof vip.hasGift === 'boolean' ? vip.hasGift : null,
                canClaim: typeof vip.canClaim === 'boolean' ? vip.canClaim : null,
                result: vip.result || '',
                lastError: vip.lastError || '',
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: true,
                doneToday: !!month.doneToday,
                lastAt: Number(month.lastClaimAt || month.lastCheckAt || 0),
                hasCard: Object.hasOwn(month, 'hasCard') ? !!month.hasCard : undefined,
                hasClaimable: Object.hasOwn(month, 'hasClaimable') ? !!month.hasClaimable : undefined,
                result: month.result || '',
            },
        ],
    };
}

/**
 * 奶茶热销中：把「活动自动化」的真实调度状态折算成首页倒计时用的结构。
 * 旧版由活动自动检查循环提供；新版这些开关统一走 activity_automation_interval 定时任务，
 * 所以这里直接读该任务的下次到期时间，开关全关时返回 disabled，避免首页显示假倒计时。
 */
const MILK_TEA_AUTOMATION_KEYS = [
    'milk_tea_auto_open',
    'milk_tea_share',
    'milk_tea_share_daily',
    'milk_tea_share_rewards',
    'milk_tea_fund_rewards',
    'milk_tea_cashier',
    'milk_tea_wages',
    'milk_tea_upgrade',
    'milk_tea_craft',
    'milk_tea_boost',
    'milk_tea_interact',
    'milk_tea_hire',
    'milk_tea_seed_buy',
    // 两个化肥开关是独立的调度动作；金币果/经验蘑菇种子只是购种的附加范围，
    // 不是独立动作，主开关关闭时不应让首页显示「已有自动化待执行」。
    'milk_tea_fertilizer_buy_normal',
    'milk_tea_fertilizer_buy_organic',
];

function getMilkTeaAutoCheckStatus(): any {
    const automation = getAutomation() || {};
    const enabledActionCount = MILK_TEA_AUTOMATION_KEYS.filter(key => automation[key] === true).length;
    const base = { intervalSec: 300, enabledActionCount, nextRunAt: null };
    if (!enabledActionCount) return { ...base, state: 'disabled' };
    let tasks: any[] = [];
    try {
        const snapshot = workerScheduler.getSnapshot ? workerScheduler.getSnapshot() : null;
        tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : [];
    } catch {
        tasks = [];
    }
    // 与老版一致：轮询、启动首轮、保存后一轮和三个事件唤醒都算「下一次触发」，取最近的。
    const triggers = new Set([
        'activity_automation_initial',
        'activity_automation_interval',
        'activity_automation_after_save',
        'rain_poem_weather_renew',
        'rain_poem_after_harvest',
        'pet_diary_treasure_ready',
    ]);
    const nextRunAt = Math.min(...tasks
        .filter(item => item && triggers.has(String(item.name)) && !item.running && Number(item.nextRunAt) > 0)
        .map(item => Number(item.nextRunAt)));
    if (!Number.isFinite(nextRunAt)) return { ...base, state: 'idle' };
    return { ...base, state: 'scheduled', nextRunAt };
}

function syncStatus(force: boolean = false): void {
    if (!process.send && !parentPort) return;

    const userState = getUserState();
    const ws = getWs();
    const connected = !!(loginReady && ws && ws.readyState === 1);

    let expProgress: any = null;
    const level = (userState.level ?? statusData.level ?? 0);
    const exp = (userState.exp ?? statusData.exp ?? 0);

    if (level > 0 && exp >= 0) {
        expProgress = getLevelExpProgress(level, exp);
    }

    const limits = require('../services/friend').getOperationLimits();
    const fullStats = require('../services/stats').getStats(statusData, userState, connected, limits);
    const nowMs = Date.now();
    const farmRemainSec = Math.max(0, Math.ceil((Number(nextFarmRunAt || 0) - nowMs) / 1000));
    const friendRemainSec = Math.max(0, Math.ceil((Number(nextFriendRunAt || 0) - nowMs) / 1000));
    const stealRemainSec = Math.max(0, Math.ceil((Number(nextStealRunAt || 0) - nowMs) / 1000));
    const visitStrategy = require('../services/friend/visit-strategy');
    const friendQuiet = !!visitStrategy.inFriendQuietHours();
    const farmQuiet = !!visitStrategy.inFarmQuietHours();
    const automation = getAutomation() || {};
    fullStats.nextChecks = {
        farmRemainSec,
        helpRemainSec: friendRemainSec,
        stealRemainSec,
        friendRemainSec,
        farmQuiet,
        friendQuiet,
        helpQuiet: friendQuiet,
        stealQuiet: friendQuiet,
        // 帮忙与偷菜是两条独立到期时间线：helpRemainSec 取 nextFriendRunAt（固定 10 分钟一轮），
        // stealRemainSec 取 nextStealRunAt（按好友作物成熟时刻动态唤醒）。开关各自独立，
        // 首页据此决定每条倒计时显示读数还是「已关闭」。
        helpEnabled: automation.friend_help !== false,
        stealEnabled: automation.friend_steal !== false,
        friendEnabled: automation.friend !== false,
        milkTea: getMilkTeaAutoCheckStatus(),
    };

    fullStats.automation = getAutomation();
    fullStats.preferredSeed = getPreferredSeed();
    fullStats.levelProgress = expProgress;
    fullStats.levelForecast = require('../services/level-forecast').getLevelForecast(
        userState, expProgress, fullStats, fullStats.automation, farmQuiet,
    );
    fullStats.configRevision = appliedConfigRevision;
    const hash = JSON.stringify(fullStats);
    const now = Date.now();
    if (force || hash !== lastStatusHash || now - lastStatusSentAt > 8000) {
        lastStatusHash = hash;
        lastStatusSentAt = now;
        sendToMaster({ type: 'status_sync', data: fullStats });
    }
}
