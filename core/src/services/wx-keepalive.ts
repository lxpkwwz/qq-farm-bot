export {};
/**
 * 账号在线保障（微信账号）。
 *
 * - 到期前预防性续期（常开）：后端自主按 expires_at 在到期前主动滚动续期并重启，
 *   不依赖浏览器是否打开、也不依赖用户是否停在「账号管理」页。这是老版本
 *   auto-code-refresh 的「后端 scheduler + onlyIfDue 只在到期前刷」思路，
 *   执行器换成现版本更稳的 refreshAccountCredential（自带同账号串行锁、
 *   滚动 token 落盘、expires_at 写回）。日熔断额度只统计失败，成功的常规
 *   续期不占额度，避免凭证按 2 小时滚动时一天内被过早限流。
 * - 掉线重登（可选）：账号因断开或被踢下线而停止后，等待 N 秒自动换 Code 并重新启动。
 *
 * 到期前预防续期只对微信账号生效（只有微信有滚动凭证与 expires_at）；掉线重登
 * 对两类账号都生效 —— 微信走 refreshtoken 滚动续期，QQ 走 NapCat 免扫码重签。
 * 扫码时未回传 refreshtoken、仅有 loginBuffer 的微信账号无法滚动续期，
 * NapCat 不支持重签的 QQ 账号同样只能重新扫码，这两种情况会留下明确日志。
 */

const store = require('../models/store');
const { normalizeAutoCodeRefresh, DEFAULT_AUTO_CODE_REFRESH } = require('../config/config');
const { refreshAccountCredential, hasWxCredential } = require('./wx-credential');
const { tryRefreshQqGameCode, isQqCodeRefreshConfigured } = require('./qq-credential');
const { inspectAccountCodeHealth } = require('./code-watch');

/** 30 秒巡检一次，比老版本 wx_keepalive 的 60 秒更勤；成功续期会推进 expires_at，不会重复刷。 */
const TICK_MS = 30_000;
/** 到期前预警窗口：与 code-watch.WARNING_WINDOW_MS、老版本 WX_CREDENTIAL_REFRESH_WINDOW_MS 一致。 */
const PREFLIGHT_WINDOW_MS = 45 * 60_000;
/** 老版本 MAX_DAILY_RECOVERIES：按 UTC+8 自然日限制单账号「失败」次数，避免打爆续期接口。
 *  成功的常规预防续期不占额度：凭证每 2 小时到期，一天可能触发十几次，按成功计数会过早熔断。 */
const MAX_DAILY_PREFLIGHT_FAILURES = 8;
/** 老版本 MAX_CONSECUTIVE_FAILURES：连续失败熔断。 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** 老版本 WX_CREDENTIAL_RETRY_MS：失败后 5 分钟内不重复打续期接口。 */
const PREFLIGHT_RETRY_MS = 5 * 60_000;

interface KeepAliveDeps {
    restartWorker?: (account: any) => void;
    isAccountRunning?: (accountId: string) => boolean;
    log?: (tag: string, msg: string, extra?: any) => void;
    addAccountLog?: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    /** 持久化「自动续期结果」账本，供账号卡片展示；由 runtime-engine 注入，测试可留空。 */
    recordPreflightResult?: (accountId: string, ok: boolean, now: number) => void;
}

let deps: KeepAliveDeps = {};
let timer: any = null;
let running = false;
const inFlight = new Set<string>();
const offlineTimers = new Map<string, any>();

function log(tag: string, msg: string, extra: any = {}): void {
    if (typeof deps.log === 'function') deps.log(tag, msg, extra);
}

function addAccountLog(action: string, msg: string, accountId: string, accountName: string, extra: any = {}): void {
    if (typeof deps.addAccountLog === 'function') deps.addAccountLog(action, msg, accountId, accountName, extra);
}

function getConfig(): any {
    return normalizeAutoCodeRefresh(store.getSystemConfig?.()?.autoCodeRefresh || DEFAULT_AUTO_CODE_REFRESH);
}

interface PreflightState {
    date: string;
    /** 当日累计失败次数；成功不占额度。 */
    failuresToday: number;
    /** 连续失败次数，成功一次即清零。 */
    failures: number;
    /** 上次尝试时间：两次续期之间至少间隔 PREFLIGHT_RETRY_MS，失败时即为冷却起点。 */
    lastAttemptAt: number;
}

/**
 * 到期前预防性续期的限速 / 熔断状态机。移植老版本 auto-code-refresh.js 的
 * MAX_DAILY_RECOVERIES(8) / MAX_CONSECUTIVE_FAILURES(3) 与 UTC+8 自然日计数，
 * 失败后再叠加 5 分钟冷却，避免反复消耗一次性 refreshtoken。
 *
 * 与老版本的关键差别：日额度只统计「失败」。常规预防续期本来就该一直成功，
 * 若成功也占额度，凭证按 2 小时滚动时当天后段会被误熔断，反而更容易过期。
 */
function createPreflightGovernor(nowFn: () => number = Date.now) {
    const states = new Map<string, PreflightState>();
    function stateOf(id: string, now: number): PreflightState {
        const date = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
        const existing = states.get(id);
        if (existing && existing.date === date) return existing;
        const fresh: PreflightState = { date, failuresToday: 0, failures: 0, lastAttemptAt: 0 };
        states.set(id, fresh);
        return fresh;
    }
    return {
        canAttempt(id: string, now: number = nowFn()): boolean {
            const state = stateOf(id, now);
            if (state.failuresToday >= MAX_DAILY_PREFLIGHT_FAILURES || state.failures >= MAX_CONSECUTIVE_FAILURES) return false;
            return !state.lastAttemptAt || now - state.lastAttemptAt >= PREFLIGHT_RETRY_MS;
        },
        /** 标记「开始一次尝试」：只记时间做最短间隔防抖，不占用日额度。
         *  额度只在 recordFailure 里累加，成功的常规续期永远不消耗额度。 */
        recordAttempt(id: string, now: number = nowFn()): void {
            stateOf(id, now).lastAttemptAt = now;
        },
        /** 成功只清「连续失败」；日额度与冷却都不动。 */
        recordSuccess(id: string, now: number = nowFn()): void {
            stateOf(id, now).failures = 0;
        },
        recordFailure(id: string, error: unknown, now: number = nowFn()): void {
            const state = stateOf(id, now);
            state.failuresToday += 1; // 日额度只统计失败
            state.failures += 1;
            state.lastAttemptAt = now; // 失败冷却 5 分钟
            // 凭证已失效 / 需要重新扫码：继续重试只会反复打接口，直接熔断到当天结束。
            if (/重新扫码|凭证.*(?:失效|过期)|token.*(?:expired|invalid)/i.test(String(error || ''))) {
                state.failures = MAX_CONSECUTIVE_FAILURES;
            }
        },
        snapshot(id: string, now: number = nowFn()): PreflightState {
            return { ...stateOf(id, now) };
        },
        reset(): void { states.clear(); },
    };
}

const preflight = createPreflightGovernor();

/**
 * 与 code-watch 共用同一套到期判定（秒/毫秒兼容、以最近一次成功时间补算），
 * 避免两处逻辑分叉。remainingMs 为 0 表示已过期或暂无到期信息，都值得尝试一次。
 * 老版本 shouldRefreshWxCredential / onlyIfDue 的等价实现。
 */
function isCredentialDue(account: any, now: number = Date.now()): boolean {
    return inspectAccountCodeHealth(account, { now }).remainingMs <= PREFLIGHT_WINDOW_MS;
}

function listWxAccounts(): any[] {
    return (store.getAccounts().accounts || []).filter((account: any) => String(account.platform || '') === 'wx');
}

function findAccount(accountId: unknown): any {
    return (store.getAccounts().accounts || []).find((account: any) => String(account.id) === String(accountId)) || null;
}

/**
 * 把一次「后端自动发起」的续期结果写进持久化账本。
 * 只记 preflight（到期前预防，常开）和 offline（掉线重登）；用户在面板上
 * 手动点「续期全部微信授权」不算无人值守，不进账。账本异常不影响续期结果。
 */
function recordAutomaticResult(accountId: string, reason: 'offline' | 'manual' | 'preflight', ok: boolean, now: number): void {
    if (reason === 'manual' || typeof deps.recordPreflightResult !== 'function') return;
    try {
        deps.recordPreflightResult(accountId, ok, now);
    }
    catch {
        // 账本只用于面板展示，写失败不阻断账号续期与重启。
    }
}

function isRunning(accountId: unknown): boolean {
    if (typeof deps.isAccountRunning !== 'function') return false;
    try {
        return !!deps.isAccountRunning(String(accountId));
    } catch {
        return false;
    }
}

function platformOf(account: any): 'wx' | 'qq' {
    return String(account && account.platform || '') === 'wx' ? 'wx' : 'qq';
}

/**
 * 掉线后能不能免扫码自愈。
 *
 * 微信要有滚动凭证（wxid + refreshtoken）；QQ 没有滚动凭证，只能靠 NapCat
 * 用当前已登录会话重签 Code，所以要求 NapCat 接口已配置。这里的准入条件是
 * 「能不能自动补 Code」，不是「是不是微信」—— 早期实现只认微信，QQ 账号掉线后
 * 永远不会被拉起，表现就是「掉线了就一直离线」。
 */
function canRecoverAccount(account: any): boolean {
    if (!account) return false;
    if (platformOf(account) === 'wx') return hasWxCredential(account);
    return isQqCodeRefreshConfigured();
}

/** 按平台取一次新 Code：微信滚动续期，QQ 走 NapCat 重签。 */
async function refreshCredentialFor(account: any, key: string): Promise<{ ok: boolean; accountName: string; error?: string }> {
    const accountName = String((account && (account.name || account.nick)) || key || '');
    if (platformOf(account) === 'wx') {
        return await refreshAccountCredential(key);
    }
    const result = await tryRefreshQqGameCode(key);
    return { ok: !!(result && result.ok), accountName, error: result && result.error };
}

/**
 * 掉线重登的次数闸门。
 *
 * Code 永久失效（用户换了密码、NapCat 掉线、滚动 token 被别人用掉）时，
 * 「掉线 → 60 秒后重登 → 还是失败 → 再掉线」会变成每小时的死循环，把日志刷满、
 * 还反复打续期与重签接口。这里按自然小时窗口限次：一小时最多 5 次，
 * 超了暂停 30 分钟再放行，给用户留出重新扫码的时间。
 */
const RECONNECT_WINDOW_MS = 60 * 60_000;
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_PAUSE_MS = 30 * 60_000;

interface ReconnectState {
    windowStart: number;
    attempts: number;
    pausedUntil: number;
}

const reconnectStates = new Map<string, ReconnectState>();

function reconnectStateOf(accountId: string, now: number): ReconnectState {
    const existing = reconnectStates.get(accountId);
    if (existing) return existing;
    const fresh: ReconnectState = { windowStart: now, attempts: 0, pausedUntil: 0 };
    reconnectStates.set(accountId, fresh);
    return fresh;
}

/**
 * 申请一次掉线重登名额。返回 allowed=false 表示当前不该再重登：
 * 要么还在上一轮熔断的暂停期，要么这个小时已经用满次数。
 */
function reserveReconnectSlot(accountId: string, now: number): { allowed: boolean; attempt: number; remainingPauseMs: number; state: 'ok' | 'paused' | 'exhausted' } {
    const state = reconnectStateOf(String(accountId), now);
    if (state.pausedUntil > now) {
        return { allowed: false, attempt: state.attempts, remainingPauseMs: state.pausedUntil - now, state: 'paused' };
    }
    if (state.pausedUntil) {
        // 暂停期满：重新起一轮窗口与额度，给「已经恢复的临时故障」一次机会。
        state.pausedUntil = 0;
        state.windowStart = now;
        state.attempts = 0;
    }
    if (now - state.windowStart >= RECONNECT_WINDOW_MS) {
        state.windowStart = now;
        state.attempts = 0;
    }
    if (state.attempts >= RECONNECT_MAX_ATTEMPTS) {
        state.pausedUntil = now + RECONNECT_PAUSE_MS;
        return { allowed: false, attempt: state.attempts, remainingPauseMs: RECONNECT_PAUSE_MS, state: 'exhausted' };
    }
    state.attempts += 1;
    return { allowed: true, attempt: state.attempts, remainingPauseMs: 0, state: 'ok' };
}

/**
 * 续期 + 按需重启。同一账号同时只允许一个续期任务，避免滚动 token 互相覆盖。
 */
async function refreshAndMaybeRestart(accountId: unknown, reason: 'offline' | 'manual' | 'preflight', now: number = Date.now()): Promise<boolean> {
    const key = String(accountId);
    if (inFlight.has(key)) return false;
    const account = findAccount(key);
    if (!canRecoverAccount(account)) return false;
    inFlight.add(key);
    try {
        const result = await refreshCredentialFor(account, key);
        const isPreflight = reason === 'preflight';
        if (!result.ok) {
            const message = `账号 ${result.accountName} 续期失败：${result.error || '未知错误'}`;
            log('错误', message, { accountId: key, accountName: result.accountName, reason });
            if (isPreflight) preflight.recordFailure(key, result.error, now);
            recordAutomaticResult(key, reason, false, now);
            addAccountLog(isPreflight ? 'auto_code_preflight_failed' : 'auto_code_refresh_failed', message, key, result.accountName, { reason });
            return false;
        }
        const message = platformOf(account) === 'wx'
            ? `账号 ${result.accountName} 微信授权已续期`
            : `账号 ${result.accountName} QQ 登录 Code 已重签`;
        log('系统', message, { accountId: key, accountName: result.accountName, reason });
        if (isPreflight) preflight.recordSuccess(key, now);
        recordAutomaticResult(key, reason, true, now);
        addAccountLog(isPreflight ? 'auto_code_preflight' : 'auto_code_refresh', message, key, result.accountName, { reason });

        // 预防性续期 / 掉线重登都要立刻用新 Code 重新上线；手动续期只更新 Code。
        const shouldRestart = reason !== 'manual' && typeof deps.restartWorker === 'function';
        if (shouldRestart) {
            const latest = findAccount(key);
            if (latest) {
                try {
                    deps.restartWorker!(latest);
                } catch (error: any) {
                    log('错误', `账号 ${result.accountName} 重启失败: ${error?.message || error}`, { accountId: key });
                }
            }
        }
        return true;
    } finally {
        inFlight.delete(key);
    }
}

/**
 * 常开的到期前预防性续期通道。返回被触发的账号 id，便于回归测试断言。
 * 与掉线重登共享 inFlight 去重和账号串行锁；滚动续期成功后 expires_at 推进，下一轮自然跳过。
 */
function runCodePreflight(now: number = Date.now()): Promise<string[]> {
    const triggered: string[] = [];
    const tasks: Promise<boolean>[] = [];
    for (const account of listWxAccounts()) {
        const key = String(account.id);
        // 只续期「正在运行」的账号：用户手动停止的账号不能被自动拉起
        // （老版本 versions 代次锁 / manuallyStopped 的等价约束）。
        if (!hasWxCredential(account) || !isRunning(key)) continue;
        if (inFlight.has(key) || !isCredentialDue(account, now)) continue;
        if (!preflight.canAttempt(key, now)) continue;
        // 只标记尝试时间（最短间隔防抖）；成功不占日额度，额度由 recordFailure 在失败时累加。
        preflight.recordAttempt(key, now);
        triggered.push(key);
        tasks.push(refreshAndMaybeRestart(key, 'preflight', now));
    }
    return Promise.all(tasks).then(() => triggered);
}

function tick(): void {
    if (running) return;
    running = true;
    try {
        // 到期前预防性续期常开：不看任何开关、不依赖浏览器，关掉网页后端照样工作。
        void runCodePreflight(Date.now()).catch(() => {});
    } finally {
        running = false;
    }
}

/** 账号掉线（断开 / 被踢下线 / 登录失败）时调用；按配置延时换 Code 并重启。 */
function notifyAccountOffline(accountId: unknown, reason = 'offline'): void {
    const key = String(accountId);
    const config = getConfig();
    if (!config.offlineEnabled) return;
    const account = findAccount(key);
    const accountName = String((account && (account.name || account.nick)) || key);
    if (!canRecoverAccount(account)) {
        // 没有可用的免扫码凭证：重登必然失败，直接把原因写清楚，交给用户重新扫码。
        log('系统', `账号 ${accountName} 掉线（${reason}），当前账号没有可免扫码恢复的凭证，需重新扫码或填写新 Code`, {
            accountId: key,
            accountName,
            reason,
        });
        return;
    }
    if (offlineTimers.has(key)) return;

    const now = Date.now();
    const slot = reserveReconnectSlot(key, now);
    if (!slot.allowed) {
        if (slot.state === 'exhausted') {
            log('错误', `账号 ${accountName} 一小时内已自动重登 ${slot.attempt} 次仍未稳定，暂停 ${Math.round(RECONNECT_PAUSE_MS / 60000)} 分钟；若持续失败请检查凭证或重新扫码`, {
                accountId: key,
                accountName,
                reason,
            });
            addAccountLog('auto_reconnect_paused', `账号 ${accountName} 频繁掉线，自动重登暂停 ${Math.round(RECONNECT_PAUSE_MS / 60000)} 分钟`, key, accountName, { reason, attempts: slot.attempt });
        }
        else {
            log('系统', `账号 ${accountName} 掉线（${reason}），自动重登处于暂停中，${Math.ceil(slot.remainingPauseMs / 60000)} 分钟后恢复`, {
                accountId: key,
                accountName,
                reason,
            });
        }
        return;
    }

    const delayMs = Math.max(1, Number(config.offlineDelaySeconds) || 60) * 1000;
    log('系统', `账号 ${accountName} 掉线（${reason}），${Math.round(delayMs / 1000)} 秒后自动换 Code 重登（本次窗口第 ${slot.attempt} 次）`, {
        accountId: key,
        accountName,
        reason,
    });
    const handle = setTimeout(() => {
        offlineTimers.delete(key);
        const latest = findAccount(key);
        if (!latest || isRunning(key)) return;
        addAccountLog('auto_reconnect', `账号 ${latest.name || key} 掉线后尝试自动重登`, key, String(latest.name || key), { reason });
        void refreshAndMaybeRestart(key, 'offline');
    }, delayMs);
    if (typeof handle.unref === 'function') handle.unref();
    offlineTimers.set(key, handle);
}

function startWxKeepAlive(options: KeepAliveDeps = {}): void {
    deps = { ...deps, ...options };
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const config = getConfig();
    log('系统', `账号在线保障已启动：到期前预防性续期常开（每 ${Math.round(TICK_MS / 1000)} 秒检查、到期前 ${Math.round(PREFLIGHT_WINDOW_MS / 60000)} 分钟续期，当日失败上限 ${MAX_DAILY_PREFLIGHT_FAILURES} 次（成功不占额度） / 连续失败 ${MAX_CONSECUTIVE_FAILURES} 次熔断），掉线重登${config.offlineEnabled ? `等待 ${config.offlineDelaySeconds} 秒（微信续期 / QQ 重签，一小时最多 ${RECONNECT_MAX_ATTEMPTS} 次）` : '关闭'}`);
}

function stopWxKeepAlive(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    for (const handle of offlineTimers.values()) clearTimeout(handle);
    offlineTimers.clear();
    inFlight.clear();
    reconnectStates.clear();
    preflight.reset();
}

/** 掉线重登配置变更后重新读取一次，把当前生效策略写进系统日志。 */
function applyWxKeepAliveConfig(): void {
    const config = getConfig();
    log('系统', `账号在线保障配置已更新：掉线重登${config.offlineEnabled ? `等待 ${config.offlineDelaySeconds} 秒` : '关闭'}，到期前预防性续期常开`);
}

module.exports = {
    startWxKeepAlive,
    stopWxKeepAlive,
    applyWxKeepAliveConfig,
    notifyAccountOffline,
    refreshAndMaybeRestart,
    runCodePreflight,
    isCredentialDue,
    createPreflightGovernor,
    canRecoverAccount,
    reserveReconnectSlot,
    getConfig,
    PREFLIGHT_WINDOW_MS,
    PREFLIGHT_RETRY_MS,
    MAX_DAILY_PREFLIGHT_FAILURES,
    MAX_CONSECUTIVE_FAILURES,
    RECONNECT_WINDOW_MS,
    RECONNECT_MAX_ATTEMPTS,
    RECONNECT_PAUSE_MS,
};
