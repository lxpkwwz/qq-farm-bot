export {};

/**
 * 好友成熟计划（移植自老版本 services/friend-maturity-plan.js + steal-schedule.js）。
 *
 * 作用：把「偷菜什么时候去」从固定轮询改成按好友作物成熟时间动态唤醒。
 * 两个观测来源：
 * - 好友列表摘要的 plant.ripe_time_sec（倒计时秒或服务器绝对时间戳，精度一般，用于排程）
 * - 进好友农场时 Enter 回包地块 phases 里的精确成熟墙钟（精度高，覆盖摘要值）
 *
 * 消费方：
 * - core/worker.ts runFriendTick：nextFriendRunAt 取 min(常规随机间隔, getNextStealDelayMs())，
 *   成熟窗口到来时提前唤醒好友巡查（帮助仍保底常规节奏）。
 * - friend/scheduler.ts checkFriends：每轮巡查后 claimDueFriends 归位到期计划，
 *   防止一次没偷成的旧到期点把动态唤醒长期钉在最小值。
 */

const { toNum, getServerTimeSec } = require('../../utils/utils');

const DEFAULT_RECHECK_AFTER_DUE_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_WAKE_MS = 15 * 60 * 1000;
const MIN_WAKE_MS = 1000;
// 已到期计划在 90 秒宽限内仍参与动态唤醒，超时仍未被摘要刷新则清零。
const DUE_GRACE_MS = 90 * 1000;

interface MaturityPlan {
    gid: number;
    name: string;
    matureAt: number;      // 秒级墙钟
    summaryObservedAt: number;
    landsObservedAt: number;
    source: string;
}

const plans = new Map<number, MaturityPlan>();

function toTimeSec(value: any): number {
    const n = toNum(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // Long/毫秒时间戳防御：> 1e12 视为毫秒
    if (n > 1e12) return Math.floor(n / 1000);
    return Math.floor(n);
}

export function normalizeAbsoluteTime(value: any, nowSec: number = getServerTimeSec()): number {
    const raw = toTimeSec(value);
    if (raw <= 0) return 0;
    return raw > 1_000_000_000 ? raw : nowSec + raw;
}

export function findNearestFutureMaturity(lands: any[], nowSec: number = getServerTimeSec()): number {
    let nearest = 0;
    for (const land of Array.isArray(lands) ? lands : []) {
        const phases = land && land.plant && Array.isArray(land.plant.phases) ? land.plant.phases : [];
        for (const phase of phases) {
            const phaseCode = toNum(phase && phase.phase);
            const phaseId = toNum(phase && phase.phase_id);
            if (phaseCode !== 6 && phaseId !== 19) continue;
            const matureAt = normalizeAbsoluteTime(phase && phase.begin_time, nowSec);
            if (matureAt <= nowSec) continue;
            if (!nearest || matureAt < nearest) nearest = matureAt;
        }
    }
    return nearest;
}

function updatePlan(gid: number, patch: Partial<MaturityPlan>): MaturityPlan {
    const current = plans.get(gid) || {
        gid, name: '', matureAt: 0, summaryObservedAt: 0, landsObservedAt: 0, source: '',
    };
    const next: MaturityPlan = { ...current, ...patch, gid };
    plans.set(gid, next);
    return next;
}

/**
 * 清理过期计划：到期超过宽限期的成熟点不再参与唤醒。
 * 否则一次没偷成的旧墙钟会永久把动态唤醒钉在最小值。
 */
function pruneExpiredPlans(): void {
    // plan.matureAt 是 normalizeAbsoluteTime 按服务器时间折算的秒级墙钟，必须和服务器当下时间比，
    // 不能拿调用方传入的本地 Date.now()（nowMs）当分母，否则本机/服务器时钟一偏就会在错误时刻清零或滞留。
    const nowSec = getServerTimeSec();
    for (const plan of plans.values()) {
        if (plan.matureAt > 0 && plan.matureAt * 1000 <= nowSec * 1000 - DUE_GRACE_MS) {
            plan.matureAt = 0;
            plan.source = 'expired';
        }
    }
}

export function observeFriendSummary(friend: any, nowMs: number = Date.now(), nowSec: number = getServerTimeSec()): void {
    const gid = toNum(friend && friend.gid);
    if (!gid) return;
    pruneExpiredPlans();
    const plant = (friend && friend.plant) || {};
    const matureAt = normalizeAbsoluteTime(plant.ripe_time_sec, nowSec);
    updatePlan(gid, {
        name: String(friend.remark || friend.name || `GID:${gid}`),
        matureAt: matureAt > nowSec ? matureAt : (plans.get(gid)?.matureAt || 0),
        summaryObservedAt: nowMs,
        source: matureAt > nowSec ? 'summary' : (plans.get(gid)?.source || 'summary'),
    });
}

export function observeFriendLands(
    gidInput: any,
    lands: any[],
    options: { name?: string; nowMs?: number; nowSec?: number; source?: string } = {},
): void {
    const gid = toNum(gidInput);
    if (!gid) return;
    const nowMs = Number(options.nowMs) || Date.now();
    const nowSec = Number(options.nowSec) || getServerTimeSec();
    const source = String(options.source || 'lands');
    pruneExpiredPlans();
    const observedMatureAt = findNearestFutureMaturity(lands, nowSec);
    const currentMatureAt = plans.get(gid)?.matureAt || 0;
    // 部分来源（通知/收获回包）不做整片覆盖，只收紧到更早的已知值。
    const partial = source === 'lands_notify' || source === 'harvest_reply';
    const matureAt = partial && currentMatureAt > nowSec
        ? (observedMatureAt > nowSec ? Math.min(currentMatureAt, observedMatureAt) : currentMatureAt)
        : observedMatureAt;
    updatePlan(gid, {
        name: String(options.name || plans.get(gid)?.name || `GID:${gid}`),
        matureAt,
        landsObservedAt: nowMs,
        source,
    });
}

/**
 * 归位已到期计划：取走（返回）后把 matureAt 推到 now + 5 分钟。
 * 语义与老版本一致——到期点只允许在宽限期内反复唤醒，之后退回常规节奏，
 * 等下一轮摘要给出新的成熟时间。
 */
export function claimDueFriends(options: { nowSec?: number; limit?: number } = {}): Array<{ gid: number; name: string }> {
    const nowSec = Number(options.nowSec) || getServerTimeSec();
    const limit = Math.max(1, Math.min(Number(options.limit) || 30, 60));
    const due = [...plans.values()]
        .filter(plan => plan.matureAt > 0 && plan.matureAt <= nowSec)
        .sort((a, b) => a.matureAt - b.matureAt || a.gid - b.gid)
        .slice(0, limit);
    for (const plan of due) {
        updatePlan(plan.gid, {
            matureAt: nowSec + Math.ceil(DEFAULT_RECHECK_AFTER_DUE_MS / 1000),
            source: 'due-recheck',
        });
    }
    return due.map(plan => ({ gid: plan.gid, name: plan.name || `GID:${plan.gid}` }));
}

/**
 * 下一次偷菜唤醒延迟（毫秒）：所有计划里最早的成熟时间，钳制在 [1s, fallback]。
 * 没有任何已知成熟点时返回 fallback（调用方应与常规随机间隔取 min）。
 */
export function getNextStealDelayMs(options: { nowMs?: number; nowSec?: number; fallbackMs?: number } = {}): number {
    const nowMs = Number(options.nowMs) || Date.now();
    const nowSec = Number(options.nowSec) || getServerTimeSec();
    const fallbackMs = Math.max(MIN_WAKE_MS, Number(options.fallbackMs) || DEFAULT_FALLBACK_WAKE_MS);
    let wakeAt = 0;
    for (const plan of plans.values()) {
        if (plan.matureAt <= 0) continue;
        const matureMs = nowMs + Math.max(0, plan.matureAt - nowSec) * 1000;
        if (!wakeAt || matureMs < wakeAt) wakeAt = matureMs;
    }
    if (!wakeAt) return fallbackMs;
    return Math.max(MIN_WAKE_MS, Math.min(fallbackMs, wakeAt - nowMs));
}

export function resetFriendMaturityPlans(): void {
    plans.clear();
}

/**
 * 按 gid 丢弃成熟计划：好友被拉黑 / 判定失效后，拉黑前写下的到期点仍留在内存里。
 * 不清掉的话 claimDueFriends 会把到期点推后 5 分钟反复捞出，
 * getNextStealDelayMs 也会按这个成熟点频繁唤醒偷菜巡查。
 */
export function dropFriendMaturityPlans(gids: Iterable<number>): number {
    let removed = 0;
    for (const gid of gids) {
        if (plans.delete(Number(gid))) removed += 1;
    }
    return removed;
}

export function getFriendMaturityPlanSnapshot(): { plans: MaturityPlan[] } {
    return { plans: [...plans.values()].map(item => ({ ...item })) };
}
