export {};
/**
 * 自家农场成熟计划 + 提前唤醒请求。
 *
 * 以前自家农场只有 20~25 秒的固定轮询，成熟驱动唤醒只用在好友偷菜上。
 * 这里把「下一块自家作物什么时候熟」记录成秒级墙钟，由 worker 在算
 * nextFarmRunAt 时取 min(常规间隔, 成熟点)，从而不再白等半个轮询周期。
 *
 * 两个防呆：
 * - 成熟点过了 90 秒仍没被新的整片快照刷新就作废，避免一次没收成的旧墙钟
 *   把唤醒永久钉在最小值（与好友偷菜的 DUE_GRACE_MS 同口径）。
 * - 「立刻补跑」一分钟最多 3 次，推送风暴 / 持续失败不会把常规节奏改成 1 秒空转。
 */

const { toNum, getServerTimeSec } = require('../../utils/utils');

const MATURITY_GRACE_MS = 90 * 1000;
const WAKEUP_WINDOW_MS = 60 * 1000;
const WAKEUP_MAX_PER_WINDOW = 3;

let matureAtSec = 0;
let wakeupReason: string | null = null;
let wakeupCount = 0;
let wakeupWindowStartMs = 0;

/** phases.begin_time 既可能是绝对秒 / 毫秒，也可能是相对倒计时秒。 */
export function toAbsoluteTimeSec(value: any, nowSec: number): number {
    const n = Number(toNum(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    const sec = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    if (sec <= 0) return 0;
    return sec > 1_000_000_000 ? sec : nowSec + sec;
}

/** 与好友成熟计划同一口径：phase=6 / phase_id=19 的 begin_time 就是成熟墙钟。 */
export function findNearestOwnMaturityAt(lands: any[], nowSec: number = getServerTimeSec()): number {
    let nearest = 0;
    for (const land of Array.isArray(lands) ? lands : []) {
        const phases = land && land.plant && Array.isArray(land.plant.phases) ? land.plant.phases : [];
        for (const phase of phases) {
            const phaseCode = Number(toNum(phase && phase.phase));
            const phaseId = Number(toNum(phase && phase.phase_id));
            if (phaseCode !== 6 && phaseId !== 19) continue;
            const matureAt = toAbsoluteTimeSec(phase && phase.begin_time, nowSec);
            if (matureAt <= nowSec) continue;
            if (!nearest || matureAt < nearest) nearest = matureAt;
        }
    }
    return nearest;
}

export function observeOwnFarmMaturity(lands: any[], source: 'round' | 'push' = 'round'): void {
    if (!Array.isArray(lands) || lands.length === 0) return;
    const nowSec = getServerTimeSec();
    const observed = findNearestOwnMaturityAt(lands, nowSec);
    if (observed > nowSec) {
        // 推送只是局部通知，不能拿它把整片快照算出的成熟点抹掉，只收紧到更早的已知值。
        if (!matureAtSec || observed < matureAtSec) matureAtSec = observed;
        return;
    }
    // 整轮快照里一块「未来会成熟」的作物都没有，旧计划作废；局部推送不清计划。
    if (source === 'round') matureAtSec = 0;
}

/**
 * 返回距离下一块自家作物成熟还有多少毫秒；0 表示没有可用计划。
 *
 * matureAtSec 与 findNearestOwnMaturityAt 都按「服务器时间」归一（begin_time
 * 相对倒计时是用 getServerTimeSec() 当下值折算的），所以这里必须用服务器时间差
 * 算时长，不能拿 matureAtSec*1000（服务器时间戳）去减本地 Date.now() —— 一旦
 * 服务器时钟与本地时钟不一致（syncServerTime 本就是为这种偏移存在的），旧写法会
 * 把整段偏移当成「还要等多久」喂给调度器，唤醒线被错算。好友成熟计划用的就是
 * nowMs + (matureAt - nowSec)*1000 这一正确口径，自家这里对齐它。
 */
export function getOwnFarmMaturityDelayMs(): number {
    if (!matureAtSec) return 0;
    const delayMs = (matureAtSec - getServerTimeSec()) * 1000;
    if (delayMs < -MATURITY_GRACE_MS) {
        matureAtSec = 0;
        return 0;
    }
    return Math.max(0, delayMs);
}

/** 巡查中到达的推送、收获失败、整轮超时都登记一次「尽快再跑一轮」。 */
export function requestFarmWakeup(reason: string): void {
    const now = Date.now();
    if (now - wakeupWindowStartMs > WAKEUP_WINDOW_MS) {
        wakeupWindowStartMs = now;
        wakeupCount = 0;
    }
    if (wakeupCount >= WAKEUP_MAX_PER_WINDOW) return;
    wakeupReason = String(reason || 'unknown');
}

/** worker 在算 nextFarmRunAt 时消费；返回非空就把到期线拉到 200ms 后。 */
export function consumeFarmWakeup(): string | null {
    const reason = wakeupReason;
    wakeupReason = null;
    if (reason) wakeupCount += 1;
    return reason;
}

export function resetOwnFarmMaturity(): void {
    matureAtSec = 0;
    wakeupReason = null;
    wakeupCount = 0;
    wakeupWindowStartMs = 0;
}

/** 仅供测试：注入一个已知的成熟墙钟。 */
export function setOwnFarmMatureAtForTest(sec: number): void {
    matureAtSec = Number(sec) > 0 ? Math.floor(Number(sec)) : 0;
}
