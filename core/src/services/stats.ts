export {};
const path = require('node:path');
const fs = require('node:fs');
const { getSystemDateKey } = require('../utils/utils');
const { renameWithRetry } = require('./json-db');
function getStatsFilePath(accountId: string): string {
    const dataDir: string = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
    return path.join(dataDir, 'stats', `${accountId}.json`);
}

function getTodayKey(): string {
    return getSystemDateKey();
}

function loadPersistedStats(accountId: string): any {
    try {
        const filePath: string = getStatsFilePath(accountId);
        if (!fs.existsSync(filePath)) return null;
        const raw: string = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// 落盘失败只告警一次：原来异常被完全吞掉，容器以只读卷/磁盘写满启动时，
// 面板还在显示「今日收获 N」，重启后 N 全部消失，排障时没有任何线索。
let persistFailureLogged = false;

function savePersistedStats(accountId: string, data: any): void {
    try {
        const filePath: string = getStatsFilePath(accountId);
        const dir: string = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath: string = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        // 与 json-db 共用同一套重试：Windows 上目标文件被杀毒/同步盘短暂占用时
        // rename 会报 EPERM，直接抛会让当日统计偶发丢失。
        renameWithRetry(tmpPath, filePath);
        persistFailureLogged = false;
    } catch (e: any) {
        if (!persistFailureLogged) {
            persistFailureLogged = true;
            // eslint-disable-next-line no-console
            console.warn(`[统计] 今日统计落盘失败，重启后当日计数会丢失: ${e?.code || ''} ${e?.message || e}`);
        }
    }
}

interface OperationsMap {
    [key: string]: number;
    harvest: number;
    water: number;
    weed: number;
    bug: number;
    farming: number;
    fertilize: number;
    plant: number;
    steal: number;
    helpWater: number;
    helpWeed: number;
    helpBug: number;
    goldenBugClear: number;
    goldenBugPut: number;
    taskClaim: number;
    sell: number;
    upgrade: number;
    levelUp: number;
    tongQiGift: number;
}

// 键顺序与老版本一致：决定首页今日统计无记录折叠区的展示顺序。
const operations: OperationsMap = {
    harvest: 0,
    water: 0,
    weed: 0,
    bug: 0,
    farming: 0,
    fertilize: 0,
    plant: 0,
    steal: 0,
    helpWater: 0,
    helpWeed: 0,
    helpBug: 0,
    goldenBugClear: 0,
    goldenBugPut: 0,
    taskClaim: 0,
    sell: 0,
    upgrade: 0,
    levelUp: 0,
    tongQiGift: 0,
};

let currentDateKey: string | null = null;

interface LastState {
    gold: number;
    exp: number;
    coupon: number;
}

const lastState: LastState = {
    gold: -1,
    exp: -1,
    coupon: -1,
};

interface InitialState {
    gold: number | null;
    exp: number | null;
    coupon: number | null;
    goldBean: number | null;
}

const initialState: InitialState = {
    gold: null,
    exp: null,
    coupon: null,
    goldBean: null,
}

// 本次运行基线：每次登录/重启时重新记录，不做持久化恢复。
// 与 initialState（当日基线，同日重启恢复）互不影响，供资产卡片“本次运行”增量使用。
// 资产卡没有金豆的「本次运行」增量，这里不含 goldBean。
interface RunInitialState {
    gold: number | null;
    exp: number | null;
    coupon: number | null;
}

const runInitial: RunInitialState = {
    gold: null,
    exp: null,
    coupon: null,
};

interface SessionData {
    goldGained: number;
    expGained: number;
    couponGained: number;
    goldBeanGained: number;
    runGoldGained: number;
    runExpGained: number;
    runCouponGained: number;
    lastExpGain: number;
    lastGoldGain: number;
    lastExpTime?: number;
}

const session: SessionData = {
    goldGained: 0,
    expGained: 0,
    couponGained: 0,
    goldBeanGained: 0,
    runGoldGained: 0,
    runExpGained: 0,
    runCouponGained: 0,
    lastExpGain: 0,
    lastGoldGain: 0,
};

let currentAccountId: string | null = null;
let sessionStartedAt = Date.now();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function recordOperation(type: string, count: number = 1): void {
    checkAndResetDailyStats();
    if (operations[type] !== undefined) {
        operations[type] += count;
        scheduleSave();
    }
}

function checkAndResetDailyStats(): void {
    if (!currentAccountId) return;
    const todayKey: string = getTodayKey();
    if (currentDateKey && currentDateKey !== todayKey) {
        // 日期键来自服务器时间（登录/心跳都会 syncServerTime），可能被校正而回退。
        // 回退不是新的一天：此时重置会把当天已经累计的统计全部清零，
        // 若两个日期键来回抖动，会每个状态同步周期清一次，当日统计彻底不可用。
        // 只有真正向前跨日才重置；回退只告警，当前归属日保持不变。
        if (todayKey < currentDateKey) {
            console.warn(`[统计] 检测到日期回退，忽略本次重置 (${currentDateKey} -> ${todayKey})`);
            return;
        }
        console.warn(`[统计] 检测到跨天，重置每日统计 (${currentDateKey} -> ${todayKey})`);
        Object.keys(operations).forEach((key: string) => {
            operations[key] = 0;
        });
        // 跨天后基线清空：下次 getStats/recomputeSessionTotals 以当时值重新起算，
        // 金币/经验/点券/金豆当日增量都从新的一天重新累计。
        initialState.gold = null;
        initialState.exp = null;
        initialState.coupon = null;
        initialState.goldBean = null;
        session.goldGained = 0;
        session.expGained = 0;
        session.couponGained = 0;
        session.goldBeanGained = 0;
    }
    currentDateKey = todayKey;
}

function scheduleSave(): void {
    if (!currentAccountId) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        doSave();
    }, 2000);
}

function doSave(): void {
    if (!currentAccountId) return;
    // 落盘用的日期键必须是「这批计数归属的那一天」，不能是落盘那一刻的日期。
    // scheduleSave 是 2 秒防抖：23:59:5x 记下最后一次操作、00:00:0x 才落盘时，
    // 旧写法会把昨天全天的计数写成「今天」的数；同日重启就按 saved.date === todayKey
    // 把昨天的累计当成今天恢复，一整天都虚高。
    // 先做一次跨日检查（内部保证日期单调前进），再取归属日。
    checkAndResetDailyStats();
    const dateKey: string = currentDateKey || getTodayKey();
    const data: any = {
        date: dateKey,
        operations: { ...operations },
        initialState: { ...initialState },
        savedAt: Date.now(),
    };
    savePersistedStats(currentAccountId, data);
}

/**
 * 把登录时拿到的余额转成「基线或未知」。
 * 登录回包缺字段时（`undefined` / `null` / NaN）不能当 0：一旦把 0 钉成当日起点，
 * 之后拿到真实余额就会把整个账户余额算成今日净增，还会被落盘固化。
 * 与金豆同一套语义：未知就留 null，等首次观测到有效值再起算。
 */
function toBaseline(raw: any): number | null {
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function initStats(gold: number | null, exp: number | null, coupon: number | null = null, goldBean: number | null = null): void {
    sessionStartedAt = Date.now();
    const g: number | null = toBaseline(gold);
    const e: number | null = toBaseline(exp);
    const c: number | null = toBaseline(coupon);
    // lastState 用 -1 表示「尚未观测」；未知基线交给 updateStats 的首次观测赋值。
    lastState.gold = g === null ? -1 : g;
    lastState.exp = e === null ? -1 : e;
    lastState.coupon = c === null ? -1 : c;
    initialState.gold = g;
    initialState.exp = e;
    initialState.coupon = c;
    // 金豆当日基线只认「登录时背包同步成功」拿到的余额（含合法的 0）。
    // 背包拉取失败时 userState.goldBean 仍是初始占位 0，若拿它当今日起点，
    // 等 ItemNotify 刷成真实余额就会把全部余额算成今日净增，且会被 doSave 写盘、
    // 同日重启一直错。失败时传 null：基线留空，由首次有效余额观测初始化。
    const b: number | null = goldBean === null || goldBean === undefined ? null : Number(goldBean);
    initialState.goldBean = b !== null && Number.isFinite(b) && b >= 0 ? b : null;
    // 本次运行基线只在登录时重置：资产卡“本次运行”增量从这次登录起算。
    runInitial.gold = g;
    runInitial.exp = e;
    runInitial.coupon = c;
}

/** 从存档恢复当日基线：null/undefined（跨天清空）视为「不恢复」，交给登录基线重算。 */
function restoreInitialBaseline(raw: any): number | null {
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function initStatsWithPersistence(accountId: string, gold: number | null, exp: number | null, coupon: number | null = null, goldBean: number | null = null): void {
    currentAccountId = accountId;
    const todayKey: string = getTodayKey();
    currentDateKey = todayKey;
    const saved: any = loadPersistedStats(accountId);

    if (saved && saved.date === todayKey) {
        Object.keys(saved.operations || {}).forEach((key: string) => {
            if (operations[key] !== undefined) {
                operations[key] = Number(saved.operations[key]) || 0;
            }
        });
        console.warn(`[统计] 已恢复今日统计数据: ${JSON.stringify(saved.operations)}`);
    } else {
        Object.keys(operations).forEach((key: string) => {
            operations[key] = 0;
        });
        if (saved) {
            console.warn(`[统计] 日期已变更，重置统计 (${saved.date} -> ${todayKey})`);
        }
    }

    initStats(gold, exp, coupon, goldBean);

    // 同日重启：用持久化里的当日基线覆盖刚设置的登录基线，
    // 金币/经验当日增量跨重启继续累计，不从头算。
    if (saved && saved.date === todayKey) {
        const savedInitial = saved.initialState || {};
        // 必须显式排除 null/undefined：Number(null) === 0 会通过「>= 0」检查，
        // 把跨天清空的基线误恢复成 0，导致面板「今日收益」显示成整个账户余额。
        const restoredGold = restoreInitialBaseline(savedInitial.gold);
        const restoredExp = restoreInitialBaseline(savedInitial.exp);
        const restoredCoupon = restoreInitialBaseline(savedInitial.coupon);
        const restoredGoldBean = restoreInitialBaseline(savedInitial.goldBean);
        if (restoredGold !== null) initialState.gold = restoredGold;
        if (restoredExp !== null) initialState.exp = restoredExp;
        if (restoredCoupon !== null) initialState.coupon = restoredCoupon;
        if (restoredGoldBean !== null) initialState.goldBean = restoredGoldBean;
    }
}

function updateStats(currentGold: number, currentExp: number): void {
    if (lastState.gold === -1) lastState.gold = currentGold;
    if (lastState.exp === -1) lastState.exp = currentExp;

    if (currentGold > lastState.gold) {
        const delta: number = currentGold - lastState.gold;
        session.lastGoldGain = delta;
    } else if (currentGold < lastState.gold) {
        session.lastGoldGain = 0;
    }
    lastState.gold = currentGold;

    if (currentExp > lastState.exp) {
        const delta: number = currentExp - lastState.exp;
        const now: number = Date.now();
        if (delta === session.lastExpGain && (now - (session.lastExpTime || 0) < 1000)) {
            // console.warn(`[系统] 忽略重复经验增量 +${delta}`);
        } else {
            session.lastExpGain = delta;
            session.lastExpTime = now;
            // console.warn(`[系统] 经验 +${delta} (总计: ${currentExp})`);
        }
    } else {
        session.lastExpGain = 0;
    }
    lastState.exp = currentExp;
}

function recordGoldExp(gold: number, exp: number): void {
    updateStats(gold, exp);
}

function setInitialValues(gold: number | null, exp: number | null, coupon: number | null = null, goldBean: number | null = null): void {
    initStats(gold, exp, coupon, goldBean);
}

function resetSessionGains(): void {
    session.goldGained = 0;
    session.expGained = 0;
    session.couponGained = 0;
    session.goldBeanGained = 0;
    session.lastGoldGain = 0;
    session.lastExpGain = 0;
    session.lastExpTime = 0;
}

function recomputeSessionTotals(currentGold: number, currentExp: number, currentCoupon: number, currentGoldBean: number): void {
    // 逐字段补基线：原来只要有一个为 null 就把三个一起写成当前余额，
    // 存档里只要缺一个（例如 exp 被 restoreInitialBaseline 判为非法丢弃），
    // 已有的金币基线也会被覆盖，当日金币收益瞬间归零。
    if (initialState.gold === null) initialState.gold = currentGold;
    if (initialState.exp === null) initialState.exp = currentExp;
    if (initialState.coupon === null) initialState.coupon = currentCoupon;
    // 本次运行基线同理：登录时未知的字段在首次观测时起算，避免「本次运行」恒为 0。
    if (runInitial.gold === null) runInitial.gold = currentGold;
    if (runInitial.exp === null) runInitial.exp = currentExp;
    if (runInitial.coupon === null) runInitial.coupon = currentCoupon;
    // 金豆：登录背包同步失败时基线仍为 null，只有观测到有效余额（> 0）才起算，
    // 避免把「尚未同步的占位 0」钉成今日起点。基线未就绪期间净增按 0 显示，
    // 不虚高；等权威余额到达后才开始累计当日净值。
    if (initialState.goldBean === null && currentGoldBean > 0)
        initialState.goldBean = currentGoldBean;
    session.goldGained = currentGold - (initialState.gold as number);
    session.expGained = currentExp - (initialState.exp as number);
    session.couponGained = currentCoupon - (initialState.coupon as number);
    // 与金币/点券同源的当日净值：消费后可为负，不做 clamp。
    session.goldBeanGained = initialState.goldBean === null
        ? 0
        : currentGoldBean - (initialState.goldBean as number);
    // 本次运行增量：独立于当日增量，重启/重新登录后从新基线重新累计。
    session.runGoldGained = currentGold - (runInitial.gold ?? currentGold);
    session.runExpGained = currentExp - (runInitial.exp ?? currentExp);
    session.runCouponGained = currentCoupon - (runInitial.coupon ?? currentCoupon);
}

function getStats(statusData: any, userState: any, connected: boolean, limits: any): any {
    checkAndResetDailyStats();
    const statusObj: any = (statusData && typeof statusData === 'object') ? statusData : {};
    const userObj: any = (userState && typeof userState === 'object') ? userState : {};

    const rawGold: any = userObj.gold ?? statusObj.gold;
    const rawExp: any = userObj.exp ?? statusObj.exp;
    const rawCoupon: any = userObj.coupon ?? statusObj.coupon;
    const rawGoldBean: any = userObj.goldBean ?? statusObj.goldBean;
    const currentGold: number = Number.isFinite(Number(rawGold)) ? Number(rawGold) : 0;
    const currentExp: number = Number.isFinite(Number(rawExp)) ? Number(rawExp) : 0;
    const currentCoupon: number = Number.isFinite(Number(rawCoupon)) ? Number(rawCoupon) : 0;
    const currentGoldBean: number = Number.isFinite(Number(rawGoldBean)) ? Number(rawGoldBean) : 0;

    if (connected) {
        updateStats(currentGold, currentExp);
        recomputeSessionTotals(currentGold, currentExp, currentCoupon, currentGoldBean);
    }

    const operationsSnapshot: OperationsMap = { ...operations };
    return {
        connection: { connected },
        status: {
            name: userObj.name || statusObj.name,
            level: statusObj.level || userObj.level || 0,
            gold: currentGold,
            coupon: Number.isFinite(Number(userObj.coupon)) ? Number(userObj.coupon) : 0,
            goldBean: currentGoldBean,
            exp: currentExp,
            platform: statusObj.platform || userObj.platform || 'qq',
            avatarUrl: String(userObj.avatarUrl || statusObj.avatarUrl || '').trim(),
        },
        uptime: process.uptime(),
        sessionElapsedSeconds: Math.max(0, (Date.now() - sessionStartedAt) / 1000),
        operations: operationsSnapshot,
        sessionExpGained: session.expGained,
        sessionGoldGained: session.goldGained,
        sessionCouponGained: session.couponGained,
        sessionGoldBeanGained: session.goldBeanGained,
        runExpGained: session.runExpGained,
        runGoldGained: session.runGoldGained,
        runCouponGained: session.runCouponGained,
        lastExpGain: session.lastExpGain,
        lastGoldGain: session.lastGoldGain,
        limits,
    };
}

function saveStats(): void {
    doSave();
}

module.exports = {
    recordOperation,
    initStats,
    initStatsWithPersistence,
    updateStats,
    setInitialValues,
    recordGoldExp,
    resetSessionGains,
    getStats,
    saveStats,
    getTodayKey,
    loadPersistedStats,
    checkAndResetDailyStats,
};
