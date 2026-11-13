/**
 * 活动自动化执行器。
 *
 * 旧版把这些开关直接写在 worker 的调度里；这一版把开关还原成 Same 语义的
 * automation 字段，并按「活动 → 可执行操作」的注册表分发到 activity-center
 * 的新协议实现上。所有操作都经过冷却与串行保护，单个活动失败不影响其它活动。
 */
export {};

const { log, logWarn, logFileOnly, isTransientGatewaySkip, getServerTimeSec, toNum } = require('../utils/utils');
const { runWithRequestClass } = require('../utils/request-context');
const { withActivityRound, readActivityRound, invalidateActivityRound } = require('../utils/activity-round');

/**
 * 常态性「本轮无事可做」的报错。
 *
 * 老版是「先读活动状态 → 不满足就整段不进分支」，所以这些情况根本不会发请求、
 * 也不会有任何日志。当前版的协议实现会先自己读一遍状态再抛业务错误，
 * 因此把这些消息统一按「静默跳过」处理，只在日志文件里留痕。
 */
function isActivityNotOpenMessage(message: string): boolean {
    const text = String(message || '');
    return text.includes('活动未开始')
        || text.includes('活动已结束')
        || text.includes('活动未开启')
        || text.includes('活动不存在')
        || text.includes('活动数据未下发')
        || text.includes('未查询到活动')
        || text.includes('activity not found')
        || text.includes('not active')
        // 本轮无事可做（老版对应分支直接不进）
        || text.includes('当前没有可领取')
        || text.includes('没有可领取的')
        || text.includes('今日已领取')
        || text.includes('今日已分享')
        || text.includes('今日已购买')
        || text.includes('今日已达上限')
        || text.includes('已达今日上限');
}

/** 单个操作的最小重试间隔；对齐老版 5 分钟轮询节奏（老版无冷却，靠状态守卫，这里用 5 分钟上限兑底）。 */
const OP_COOLDOWN_MS = 5 * 60 * 1000;
/** 每轮最多执行的操作数，防止一轮里串太久。奶茶/活动开关较多时按单键预留。 */
const MAX_OPS_PER_ROUND = 24;

const lastRunAt = new Map<string, number>();
const warnedKeys = new Set<string>();

let ticking = false;
let timer: any = null;
/** 降级通道（无 workerScheduler）里那条 10 秒首跑的句柄，stop 时必须能取消。 */
let fallbackInitialTimer: any = null;
/** 启动/停止之间记住 scheduler，便于 stop 时清理一次性任务（含三个事件驱动唤醒）。 */
let workerSchedulerRef: any = null;

/**
 * 事件驱动定时器的任务名（对齐老版 worker.js 的同名任务）。
 *
 * 老版除 5 分钟轮询外还有三处「精准唤醒」，都是 setTimeoutTask 一次性触发、
 * 回调重入同一个活动自动化循环：
 * - rain_poem_weather_renew：雷雨快结束时续下一场（不然 5 分钟轮询会整段错过雷雨窗口）
 * - rain_poem_after_harvest：收获后 2 秒补一次（雷雨期间的收获才算数）
 * - pet_diary_treasure_ready：押镖/护送结束的那一刻开宝藏
 */
const EVENT_TIMER_KEYS = ['rain_poem_weather_renew', 'rain_poem_after_harvest', 'pet_diary_treasure_ready'];
/** 无 scheduler 的降级通道：按任务名记住 setTimeout 句柄。 */
const eventTimerHandles = new Map<string, any>();

/** 活动窗口 ID（ActivityList 下发），用于「过期活动直接不发请求」的前置闸门。 */
const WINDOW_IDS = {
    qingmei: ['2026080100', '2026081200'],
    qixi: ['2026081800'],
    charity: ['2026090900'],
    petDiary: ['2026090100'],
    rainPoem: ['2026070300'],
    milkTea: ['2026110100', '2026110101', '2026110102', '2026110103'],
    shareReward: ['2026092500', '2026092501', '2026110104'],
};

interface AutomationOp {
    /** automation 字段名 */
    key: string;
    /** 面向用户的操作名，用于日志 */
    label: string;
    /** 执行体；返回 true 表示确实做了操作（用于日志），返回 false / 抛错都只记录 */
    run: (automation: any) => Promise<boolean>;
    /** 覆盖默认冷却间隔；默认已是老版 5 分钟节奏，保留字段供个别操作单独调速。 */
    cooldownMs?: number;
    /**
     * 所属活动窗口 ID（可多个，任一在开放区间即放行）。
     *
     * 老版是「先读活动状态 → active=false 整段不进分支」，从不给过期活动发请求。
     * 这里先用 ActivityList 的本地窗口缓存做零成本前置判断：明确过期就不读状态、
     * 不发任何请求；窗口未知（未加载/服务端没下发）时放行，交给 op 自身的状态守卫。
     */
    activityIds?: string[];
}

function getAutomationSnapshot(): any {
    try {
        const store = require('../models/store');
        return store.getAutomation ? (store.getAutomation() || {}) : {};
    } catch {
        return {};
    }
}

function isCoolingDown(op: AutomationOp, now: number): boolean {
    const last = lastRunAt.get(op.key) || 0;
    return now - last < (op.cooldownMs || OP_COOLDOWN_MS);
}

/**
 * 本轮的「活动窗口闸门」。
 *
 * 数据来自 ActivityList（登录时已拉、5 分钟缓存、activitiesChanged 时失效），
 * 属于本地判断，不给每个活动额外发状态请求。判定规则：
 * - 该 ID 在缓存里且当前不在 [begin, end] → 明确过期/未开始，直接拦掉；
 * - 该 ID 不在缓存里 → 未知，放行（交给 op 自己的状态守卫，避免因服务端没下发而误停）；
 * - 缓存整体没加载成功 → 全部放行，不让网络问题把自动化整体停摆。
 */
async function buildActivityWindowGate(): Promise<(ids?: string[]) => boolean> {
    let windows: any[] = [];
    try {
        const { getActivityWindows } = require('./activity-windows');
        windows = await getActivityWindows() || [];
    } catch {
        windows = [];
    }
    const byId = new Map<string, any>();
    for (const row of Array.isArray(windows) ? windows : []) {
        const id = String(row?.id || '').trim();
        if (id) byId.set(id, row);
    }
    if (byId.size === 0) return () => true;
    const nowSec = getServerTimeSec();
    return (ids?: string[]): boolean => {
        if (!Array.isArray(ids) || ids.length === 0) return true;
        return ids.some((id) => {
            const window = byId.get(String(id));
            if (!window) return true;
            const begin = toNum(window.beginTime);
            const end = toNum(window.endTime);
            if (begin > 0 && nowSec < begin) return false;
            if (end > 0 && nowSec > end) return false;
            return true;
        });
    };
}

function clearEventTimer(key: string): void {
    if (workerSchedulerRef && typeof workerSchedulerRef.clear === 'function') {
        try { workerSchedulerRef.clear(key); } catch {}
    }
    const handle = eventTimerHandles.get(key);
    if (handle != null) {
        try { clearTimeout(handle); } catch {}
        eventTimerHandles.delete(key);
    }
}

function clearAllEventTimers(): void {
    for (const key of EVENT_TIMER_KEYS) clearEventTimer(key);
}

/** 一次性精准唤醒：触发后重入同一轮活动自动化（与老版 setTimeoutTask 回调一致）。 */
function scheduleEventTimer(key: string, delayMs: number): void {
    clearEventTimer(key);
    const delay = Math.max(1000, Math.round(Number(delayMs) || 0));
    const fire = () => {
        eventTimerHandles.delete(key);
        const { runExclusiveAutomationTask } = require('./automation-lock');
        return runExclusiveAutomationTask('activity_automation', () => runActivityAutomationOnce())
            .catch(() => null);
    };
    if (workerSchedulerRef && typeof workerSchedulerRef.setTimeoutTask === 'function') {
        workerSchedulerRef.setTimeoutTask(key, delay, fire);
        return;
    }
    const handle = setTimeout(fire, delay);
    if (handle && typeof handle.unref === 'function') handle.unref();
    eventTimerHandles.set(key, handle);
}

/**
 * 一轮结束后重排事件唤醒（对齐老版 worker.js）。
 *
 * 三个任务都是「先清后设」：条件不满足就等于取消唤醒，不会留着过期的定时器乱跑。
 * 活动已过期时 windowGate 直接拦掉，连状态请求都不发。
 */
async function rescheduleActivityEventTimers(automation: any, windowGate: (ids?: string[]) => boolean): Promise<void> {
    const activityCenter = require('./activity-center');

    // 1) 萌宠日记：押镖/护送结束的那一刻准时开宝藏。
    clearEventTimer('pet_diary_treasure_ready');
    if (automation.pet_diary_treasure_open && windowGate(WINDOW_IDS.petDiary)) {
        const pet = await readRoundActivityState('pet', () => activityCenter.getPetDiary());
        if (pet && pet.active === true) {
            const nowMs = getServerTimeSec() * 1000;
            const nextEnd = (Array.isArray(pet.treasures) ? pet.treasures : [])
                .filter((item: any) => toNum(item?.status) === 2 && toNum(item?.endTime) > nowMs)
                .map((item: any) => toNum(item.endTime))
                .sort((a: number, b: number) => a - b)[0];
            if (nextEnd) scheduleEventTimer('pet_diary_treasure_ready', nextEnd - nowMs + 2000);
        }
    }

    // 2) 雨落成诗：雷电变异每日目标未做满时，雷雨一结束就续下一场。
    clearEventTimer('rain_poem_weather_renew');
    if (automation.rain_poem_summon_use && windowGate(WINDOW_IDS.rainPoem)) {
        const weather = await readRoundActivityState('weather', () => activityCenter.getCurrentWeatherActivity());
        if (weather && weather.active !== false) {
            const own = weather.ownWeather || {};
            const endSec = toNum(own.endTime);
            const lightningComplete = weather?.lightningHarvest?.complete === true;
            if (!lightningComplete && own.isThunderstorm === true && endSec > 0) {
                scheduleEventTimer('rain_poem_weather_renew', (endSec - getServerTimeSec() + 2) * 1000);
            }
        }
    }
}

/**
 * 一轮内的活动状态缓存。
 *
 * 老版是「每个活动先读一次状态，再决定要不要发操作请求」，读不到 / active=false 就整段跳过。
 * 当前版按操作粒度拆开，所以这里做一层 round 级缓存：同一活动一轮只读一次状态，
 * 既对齐老版语义，也不会让 30 多个操作各拉一遍状态把请求预算吃光。
 */
async function readRoundActivityState(key: string, loader: () => Promise<any>): Promise<any> {
    // 优先走轮次共享缓存（活动自动化轮内 = 只读一次；轮外调用直接直连）。
    try {
        return await readActivityRound(`state:${key}`, loader);
    } catch {
        return null;
    }
}

/** 活动是否处于开启窗口：DTO 走 active 字段，青酿这类只有时间窗的按 endTime 判定。 */
function isActivityOpen(state: any): boolean {
    if (!state) return false;
    if (state.active === false) return false;
    if (state.active === true) return true;
    const endSec = toNum(state.endTime);
    // endTime 与同文件 buildActivityWindowGate / rescheduleActivityEventTimers 一样按服务器时间折算，
    // 不能拿本地 Date.now() 比，否则本机时钟与服务器时钟有偏移时开关边界会判错。
    if (endSec > 0) return endSec > getServerTimeSec();
    return true;
}

async function petDiaryOpen(): Promise<boolean> {
    const activityCenter = require('./activity-center');
    const state = await readRoundActivityState('pet', () => activityCenter.getPetDiary());
    return isActivityOpen(state);
}

async function weatherActivityOpen(): Promise<boolean> {
    const activityCenter = require('./activity-center');
    const state = await readRoundActivityState('weather', () => activityCenter.getCurrentWeatherActivity());
    return isActivityOpen(state);
}

/** 奶茶人才偏好：与老版 selectHireCandidate 相同的选人策略。 */
function selectHireCandidate(candidates: any, primaryTalentId: number, backupTalentId: number, now: number): any {
    const idle = (entry: any) => entry?.friend?.gid && toNum(entry.state) === 0
        && toNum(entry.state_until_at || 0) <= now && toNum(entry.rehire_available_at || 0) <= now;
    const friends = (candidates.friends || []).filter((entry: any) => !entry.is_robot && idle(entry));
    const robots = (candidates.robots || []).filter(idle);
    const findByTalent = (talentId: number) => talentId === 9004
        ? robots[0]
        : talentId === 0
            ? (friends[0] || robots[0])
            : friends.find((entry: any) => toNum(entry.talent_id) === talentId);
    return findByTalent(primaryTalentId) || (backupTalentId !== primaryTalentId ? findByTalent(backupTalentId) : undefined);
}

/**
 * 奶茶兑换商店种子的购买优先级。
 *
 * 奶茶券/金币额度有限，先买活动（奶茶）种子，保证当天能做奶茶；其次买经验种子
 * 补等级；最后才是金币种子。识别方式按「数据优先、命名兜底」：
 * 活动种子用配方果实表（MilkTeaRecipeConfig 的 fruit_item_id，种子 ID = 果实 ID - 20000）
 * 判定，经验/金币种子用商品名兜底，识别不出来的排在最后。
 */
const MILK_TEA_SEED_TIER = { activity: 0, exp: 1, coin: 2, other: 3 } as const;

function milkTeaFruitIds(): Set<string> {
    try {
        const rows = require('../activity-data/milk-tea-20261015.json').MilkTeaRecipeConfig || [];
        const ids = new Set<string>();
        for (const row of rows) {
            const fruitId = String(row?.fruit_item_id || '').split(':')[0];
            if (fruitId && fruitId !== '0') ids.add(fruitId);
        }
        return ids;
    } catch {
        return new Set<string>();
    }
}

function milkTeaSeedTier(goods: any, fruitIds: Set<string>): number {
    const rewardItems = [...(goods?.rewards || []), ...(goods?.items || [])];
    const label = [goods?.name, ...rewardItems.map((entry: any) => entry?.name)].filter(Boolean).join(' ');
    const rewardIds = rewardItems
        .map((entry: any) => String(toNum(entry?.id)))
        .filter((id: string) => id && id !== '0');
    const isActivitySeed = fruitIds.size > 0 && rewardIds.some((id: string) => fruitIds.has(id) || fruitIds.has(String(Number(id) + 20000)));
    if (isActivitySeed || label.includes('森野') || label.includes('奶茶'))
        return MILK_TEA_SEED_TIER.activity;
    if (label.includes('经验'))
        return MILK_TEA_SEED_TIER.exp;
    if (label.includes('金币'))
        return MILK_TEA_SEED_TIER.coin;
    return MILK_TEA_SEED_TIER.other;
}

/**
 * 按「活动种子 → 经验种子 → 金币种子 → 其它」挑一件当前可兑换的种子商品。
 * filters 供自动化开关限定购买范围：金币果/经验蘑菇默认不买，只有对应开关打开才纳入候选。
 */
function pickSeedGoods(catalog: any[], filters: { allowCoin?: boolean, allowExp?: boolean } = {}): any | null {
    const allowCoin = filters.allowCoin !== false;
    const allowExp = filters.allowExp !== false;
    const fruitIds = milkTeaFruitIds();
    let picked: any = null;
    let pickedTier = Number.POSITIVE_INFINITY;
    for (const goods of catalog) {
        if (goods?.category !== 'seed' || !goods.available) continue;
        if (goods.remaining != null && toNum(goods.remaining) <= 0) continue;
        const tier = milkTeaSeedTier(goods, fruitIds);
        if (tier === MILK_TEA_SEED_TIER.exp && !allowExp) continue;
        if (tier === MILK_TEA_SEED_TIER.coin && !allowCoin) continue;
        if (tier < pickedTier) {
            picked = goods;
            pickedTier = tier;
        }
    }
    return picked;
}

/** 兑换商店化肥奖励的官方物品 ID：80001~80004 普通、80011~80014 有机，礼包按名称兜底。 */
const MILK_TEA_NORMAL_FERTILIZER_IDS = new Set(['80001', '80002', '80003', '80004', '100003']);
const MILK_TEA_ORGANIC_FERTILIZER_IDS = new Set(['80011', '80012', '80013', '80014', '100004']);

/** 判定一件兑换商品属于普通化肥还是有机肥料；ID 优先、名称兜底，未知商品返回 null。 */
function milkTeaFertilizerKind(goods: any): 'normal' | 'organic' | null {
    if (!goods || typeof goods !== 'object') return null;
    // 遍历的是整个兑换目录，商品形状可能异常；非数组奖励字段直接忽略，避免一轮调度因脏数据中断。
    const rewards = [
        ...(Array.isArray(goods.rewards) ? goods.rewards : []),
        ...(Array.isArray(goods.items) ? goods.items : []),
    ];
    const ids = rewards
        .map((entry: any) => String(toNum(entry?.id)))
        .filter((id: string) => id && id !== '0');
    if (ids.some(id => MILK_TEA_ORGANIC_FERTILIZER_IDS.has(id))) return 'organic';
    if (ids.some(id => MILK_TEA_NORMAL_FERTILIZER_IDS.has(id))) return 'normal';
    const label = [goods.name, ...rewards.map((entry: any) => entry?.name)].filter(Boolean).join(' ');
    if (!label) return null;
    if (/有机化肥|有机肥料|有机肥/.test(label)) return 'organic';
    if (/化肥|肥料/.test(label)) return 'normal';
    return null;
}

/** 按化肥类型挑一件当前可兑换的商品；两个开关互相独立，不看购种开关状态。 */
function pickFertilizerGoods(catalog: any[], kind: 'normal' | 'organic'): any | null {
    for (const goods of catalog) {
        if (!goods?.available) continue;
        if (goods.remaining != null && toNum(goods.remaining) <= 0) continue;
        if (milkTeaFertilizerKind(goods) === kind) return goods;
    }
    return null;
}

/** 兑换商品统一结算：按剩余限购与各货币余额折算数量，买不到就静默跳过。 */
async function buyMilkTeaExchangeGoods(goods: any, state: any, operate: (action: string, input?: any) => Promise<any>): Promise<boolean> {
    if (!goods) return false;
    let count = goods.remaining == null ? 1 : Number(goods.remaining);
    for (const cost of goods.costs || []) {
        const balance = toNum(state.balances?.[String(toNum(cost.id))]);
        count = Math.min(count, Math.floor(balance / Math.max(1, toNum(cost.count))));
    }
    if (!Number.isSafeInteger(count) || count < 1) return false;
    await operate('exchange', { goodsId: goods.id, count, expectedCosts: goods.costs });
    return true;
}

/**
 * 奶茶热销中自动操作（老版 runStarActivityAutoClaims 的 milkTea 分支移植）。
 * 基于本版 milk-tea.ts 协议实现；每个操作先查状态、无可做时静默返回 false。
 */
function buildMilkTeaOps(): AutomationOp[] {
    const milkTea = require('./milk-tea');
    // 自动化只要执行结果：skipRefresh 跳过 perform 尾部「给面板用的整页重读」，
    // 省掉每个写操作后的一整轮 GetGroup + 背包 + 页面读。
    const operateMilkTea = (action: string, input: any = {}) => milkTea.operateMilkTeaActivity(action, input, { skipRefresh: true });
    const shareReward = require('./share-reward-activity');
    const MILK_SHARE_ID = '2026110104';
    const shopOps: AutomationOp[] = [
        {
            key: 'milk_tea_cashier', label: '奶茶热销中-领取收益', activityIds: WINDOW_IDS.milkTea,
            run: async () => {
                const state = await milkTea.getMilkTeaActivity('shop');
                if (!state.active || !(state.shop?.pending_rewards || []).some((v: any) => toNum(v.count) > 0)) return false;
                await operateMilkTea('claim');
                return true;
            },
        },
        {
            key: 'milk_tea_wages', label: '奶茶热销中-领取工资', activityIds: WINDOW_IDS.milkTea,
            run: async () => {
                const state = await milkTea.getMilkTeaActivity('work');
                if (!state.active || !(state.work?.slips || []).some((v: any) => toNum(v.wage_status) === 1)) return false;
                await operateMilkTea('wages');
                return true;
            },
        },
        {
            key: 'milk_tea_upgrade', label: '奶茶热销中-升级店铺', activityIds: WINDOW_IDS.milkTea,
            run: async () => {
                const state = await milkTea.getMilkTeaActivity('upgrade');
                if (!state.active || !state.summary?.can_upgrade) return false;
                await operateMilkTea('upgrade', { expectedLevel: toNum(state.shop?.level) });
                return true;
            },
        },
        {
            key: 'milk_tea_craft', label: '奶茶热销中-制作奶茶', activityIds: WINDOW_IDS.milkTea,
            run: async () => {
                const state = await milkTea.getMilkTeaActivity('workshop');
                if (!state.active || state.settling) return false;
                const eligible = new Set((state.recipes || []).filter((r: any) => r.unlocked && r.is_advanced).map((r: any) => toNum(r.fruitId)));
                const fruits = (state.fruits || []).filter((f: any) => eligible.has(toNum(f.id)) && toNum(f.count) > 0 && !f.locked)
                    .map((f: any) => ({ uid: String(f.uid), count: toNum(f.count) }));
                if (!fruits.length) return false;
                await operateMilkTea('craft', { fruits });
                return true;
            },
        },
        {
            key: 'milk_tea_boost', label: '奶茶热销中-使用宣传喇叭', activityIds: WINDOW_IDS.milkTea,
            run: async () => {
                const state = await milkTea.getMilkTeaActivity('shop');
                const salesItemId = toNum(state.shop?.sales_item_id);
                if (!state.active || state.settling || !salesItemId || toNum(state.balances?.[String(salesItemId)]) <= 0) return false;
                await operateMilkTea('boost', { count: 1, expectedCosts: [{ id: salesItemId, count: 1 }] });
                return true;
            },
        },
        {
            key: 'milk_tea_hire', label: '奶茶热销中-雇佣员工', activityIds: WINDOW_IDS.milkTea,
            run: async (automation: any) => {
                // 班次时长读设置里的 milk_tea_hire_duration（1=4h/2=12h/3=24h），不传时用 1。
                const durationInput = Number(automation.milk_tea_hire_duration);
                const durationId = [1, 2, 3].includes(durationInput) ? durationInput : 1;
                const state = await milkTea.getMilkTeaActivity('hireList', { durationId });
                const now = toNum(state.serverTime);
                const hire = state.hire;
                if (!state.active || state.settling || !hire) return false;
                if (toNum(state.settleStartTime) - now < toNum(hire.min_remain_biz_sec)) return false;
                const capacity = (state.levels || []).find((v: any) => toNum(v.level) === toNum(state.shop?.level))?.employee_slot_count || 0;
                const slot = Array.from({ length: capacity }, (_, i) => i)
                    .find(i => !(state.shop?.slots || []).some((v: any) => toNum(v.slot_index) === i && toNum(v.end_at) > now));
                if (slot == null) return false;
                // milk_tea_hire_policy.talent 可覆盖首选人才（0/9001~9004）；未设置时回退到现有字段。
                const hirePolicy: any = automation.milk_tea_hire_policy || {};
                const policyTalent = Number(hirePolicy.talent);
                const primaryInput = [0, 9001, 9002, 9003, 9004].includes(policyTalent)
                    ? policyTalent
                    : Number(automation.milk_tea_hire_primary_talent ?? automation.milk_tea_hire_talent);
                const primaryTalentId = [0, 9001, 9002, 9003, 9004].includes(primaryInput) ? primaryInput : 0;
                const backupInput = Number(automation.milk_tea_hire_backup_talent);
                const backupTalentId = primaryTalentId === 0 ? 0 : ([0, 9001, 9002, 9003, 9004].includes(backupInput) ? backupInput : 0);
                const target = selectHireCandidate(hire, primaryTalentId, backupTalentId, now);
                if (!target) return false;
                await operateMilkTea('hire', {
                    targetGid: String(target.friend.gid),
                    durationId,
                    expectedCosts: [{ id: 1041, count: toNum(hire.wage_total) }],
                });
                return true;
            },
        },
        {
            key: 'milk_tea_interact', label: '奶茶热销中-打工互动', activityIds: WINDOW_IDS.milkTea,
            run: async (automation: any) => {
                const state = await milkTea.getMilkTeaActivity('work');
                const shift = state.work?.my_shift;
                if (!state.active || state.settling || !shift) return false;
                if (toNum(shift.begin_at) > toNum(state.serverTime) || toNum(shift.end_at) <= toNum(state.serverTime)) return false;
                if (state.work.interact_done || toNum(shift.interact_count) >= toNum(shift.interact_limit)) return false;
                // milk_tea_work_interaction_type 作为打工互动类型的覆盖项；未设置时回退到 milk_tea_interaction_type。
                const type = Number(automation.milk_tea_work_interaction_type ?? automation.milk_tea_interaction_type);
                const kind = [1, 2, 3, 4, 5].includes(type) ? type : 1;
                await operateMilkTea('interact', { interactionType: kind, expectedShiftId: String(shift.shift_id) });
                return true;
            },
        },
        {
            key: 'milk_tea_seed_buy', label: '奶茶热销中-购买活动种子', activityIds: WINDOW_IDS.milkTea,
            run: async (automation: any) => {
                const state = await milkTea.getMilkTeaActivity('exchange');
                if (!state.active || state.settling) return false;
                // 金币果/经验蘑菇种子默认不买；两个附加开关只有主开关开启时才会走到这里。
                const goods = pickSeedGoods(state.goods || [], {
                    allowCoin: !!automation.milk_tea_seed_buy_coin,
                    allowExp: !!automation.milk_tea_seed_buy_exp,
                });
                return buyMilkTeaExchangeGoods(goods, state, operateMilkTea);
            },
        },
        {
            key: 'milk_tea_fertilizer_buy_normal', label: '奶茶热销中-购买普通化肥', activityIds: WINDOW_IDS.milkTea,
            run: async () => {
                const state = await milkTea.getMilkTeaActivity('exchange');
                if (!state.active || state.settling) return false;
                const goods = pickFertilizerGoods(state.goods || [], 'normal');
                return buyMilkTeaExchangeGoods(goods, state, operateMilkTea);
            },
        },
        {
            key: 'milk_tea_fertilizer_buy_organic', label: '奶茶热销中-购买有机肥料', activityIds: WINDOW_IDS.milkTea,
            run: async () => {
                const state = await milkTea.getMilkTeaActivity('exchange');
                if (!state.active || state.settling) return false;
                const goods = pickFertilizerGoods(state.goods || [], 'organic');
                return buyMilkTeaExchangeGoods(goods, state, operateMilkTea);
            },
        },
        {
            key: 'milk_tea_fund_rewards', label: '奶茶热销中-领取成长基金奖励', activityIds: WINDOW_IDS.milkTea,
            run: async () => {
                const state = await milkTea.getMilkTeaActivity('fund');
                if (!state.active || !state.fund?.unlocked) return false;
                if (!(state.fund.tiers || []).some((t: any) => toNum(t.state) === 2)) return false;
                await operateMilkTea('fundClaim');
                return true;
            },
        },
    ];
    // 奶茶的分享子活动（首次分享 / 每日快乐值 / 快乐值档位奖励）走通用分享奖励协议。
    const shareOps: AutomationOp[] = ([
        { key: 'milk_tea_share', label: '奶茶热销中-首次分享', gate: (s: any) => s.canShare, action: 'share' },
        { key: 'milk_tea_share_daily', label: '奶茶热销中-领取每日快乐值', gate: (s: any) => s.canClaimDaily, action: 'daily' },
        { key: 'milk_tea_share_rewards', label: '奶茶热销中-领取快乐值奖励', gate: (s: any) => s.canClaimMilestones, action: 'milestones' },
    ] as Array<{ key: string, label: string, gate: (s: any) => boolean, action: string }>).map(({ key, label, gate, action }) => ({
        key, label, activityIds: WINDOW_IDS.milkTea,
        run: async () => {
            const state = await shareReward.getShareRewardActivity(MILK_SHARE_ID).catch(() => null);
            if (!state?.active || !gate(state)) return false;
            await shareReward.operateShareRewardActivity(MILK_SHARE_ID, action);
            return true;
        },
    }));
    return [...shopOps, ...shareOps];
}

async function claimableSolarTermId(): Promise<string | null> {
    const activityCenter = require('./activity-center');
    const terms = await activityCenter.getCurrentSolarTerms();
    const list = Array.isArray(terms?.terms) ? terms.terms : [];
    const claimable = list.find((term: any) => term && term.canClaim);
    return claimable ? String(claimable.id) : null;
}

function buildOps(): AutomationOp[] {
    const activityCenter = require('./activity-center');

    return [
        {
            key: 'star_passport_claim',
            label: '领取星旅通行证奖励',
            run: async () => {
                await activityCenter.claimBattlePassRewards();
                return true;
            },
        },
        {
            key: 'star_solar_claim',
            label: '领取节气奖励',
            run: async () => {
                const termId = await claimableSolarTermId();
                if (!termId) return false;
                await activityCenter.claimSolarTerm(termId);
                return true;
            },
        },
        {
            key: 'qingmei_seed_claim',
            label: '领取青莓每日种子',
            activityIds: WINDOW_IDS.qingmei,
            run: async () => {
                const state = await readRoundActivityState('qingmei', () => activityCenter.getCurrentQingMeiActivity());
                if (!isActivityOpen(state)) return false;
                await activityCenter.claimQingMeiDailySeed();
                return true;
            },
        },
        {
            key: 'qingmei_wine_brew',
            label: '青莓酿酒推进',
            activityIds: WINDOW_IDS.qingmei,
            run: async () => {
                const state = await readRoundActivityState('qingmei', () => activityCenter.getCurrentQingMeiActivity());
                if (!isActivityOpen(state)) return false;
                const settled = await activityCenter.settleQingMeiBrew().catch(() => null);
                if (settled) return true;
                const continued = await activityCenter.continueQingMeiBrew().catch(() => null);
                return !!continued;
            },
        },
        {
            key: 'qixi_bridge_build',
            label: '领取七夕鹊桥奖励',
            activityIds: WINDOW_IDS.qixi,
            run: async () => {
                const state = await readRoundActivityState('qixi', () => activityCenter.getCurrentQixiActivity());
                if (!isActivityOpen(state) || !state.actions?.bridge?.available) return false;
                await activityCenter.claimQixiBridgeRewards();
                return true;
            },
        },
        {
            key: 'qixi_sachet_gift',
            label: '赠送七夕香囊',
            activityIds: WINDOW_IDS.qixi,
            run: async (automation: any) => {
                const priority = Array.isArray(automation.qixi_friend_priority)
                    ? automation.qixi_friend_priority
                    : [];
                const gid = priority.find((value: any) => Number(value) > 0);
                if (!gid) return false;
                const state = await readRoundActivityState('qixi', () => activityCenter.getCurrentQixiActivity());
                if (!isActivityOpen(state) || !state.actions?.gift?.available) return false;
                await activityCenter.giftQixiSachet(gid);
                return true;
            },
        },
        {
            key: 'charity_flower_donate',
            label: '公益红花捐爱心',
            activityIds: WINDOW_IDS.charity,
            run: async () => {
                const state = await readRoundActivityState('charity', () => activityCenter.getCurrentCharityRedFlowerActivity());
                if (!isActivityOpen(state) || !state.actions?.donateLove?.available) return false;
                await activityCenter.donateCharityRedFlowerLove();
                return true;
            },
        },
        {
            // 快乐不独享：与奶茶子活动共用同一套分享奖励协议（老版 operateShareReward('share')）。
            key: 'share_reward_share',
            label: '分享奖励-分享',
            activityIds: WINDOW_IDS.shareReward,
            run: async () => {
                const shareReward = require('./share-reward-activity');
                const instances = require('../activity-data/share-reward-instances.json');
                let shared = false;
                for (const instance of instances) {
                    const state = await shareReward.getShareRewardActivity(instance.activityId).catch(() => null);
                    if (!state?.active || !state.canShare) continue;
                    await shareReward.operateShareRewardActivity(instance.activityId, 'share');
                    shared = true;
                }
                return shared;
            },
        },
        {
            key: 'share_reward_daily',
            label: '分享奖励-每日领取',
            activityIds: WINDOW_IDS.shareReward,
            run: async () => {
                const shareReward = require('./share-reward-activity');
                const instances = require('../activity-data/share-reward-instances.json');
                let claimed = false;
                for (const instance of instances) {
                    const state = await shareReward.getShareRewardActivity(instance.activityId).catch(() => null);
                    if (!state?.active || !state.canClaimDaily) continue;
                    await shareReward.operateShareRewardActivity(instance.activityId, 'daily');
                    claimed = true;
                }
                return claimed;
            },
        },
        {
            key: 'pet_diary_adopt',
            label: '萌宠日记-领养',
            activityIds: WINDOW_IDS.petDiary,
            run: async () => {
                if (!await petDiaryOpen()) return false;
                await activityCenter.operatePetDiary('initialize', {});
                return true;
            },
        },
        {
            key: 'pet_diary_feed',
            label: '萌宠日记-投喂',
            activityIds: WINDOW_IDS.petDiary,
            run: async () => {
                if (!await petDiaryOpen()) return false;
                await activityCenter.operatePetDiary('feed', {});
                return true;
            },
        },
        {
            key: 'pet_diary_draw',
            label: '萌宠日记-寻宝',
            activityIds: WINDOW_IDS.petDiary,
            run: async () => {
                if (!await petDiaryOpen()) return false;
                await activityCenter.operatePetDiary('draw', {});
                return true;
            },
        },
        {
            key: 'pet_diary_seed_claim',
            label: '萌宠日记-种子礼包',
            activityIds: WINDOW_IDS.petDiary,
            run: async () => {
                if (!await petDiaryOpen()) return false;
                await activityCenter.operatePetDiary('seeds', {});
                return true;
            },
        },
        {
            key: 'pet_diary_treasure_open',
            label: '萌宠日记-开启宝藏',
            activityIds: WINDOW_IDS.petDiary,
            run: async () => {
                if (!await petDiaryOpen()) return false;
                await activityCenter.operatePetDiary('openTreasure', {});
                return true;
            },
        },
        {
            key: 'rain_poem_bottle_buy',
            label: '雨落成诗-兑换采集瓶',
            activityIds: WINDOW_IDS.rainPoem,
            run: async () => {
                if (!await weatherActivityOpen()) return false;
                await activityCenter.exchangeWeatherCollectorBottle();
                return true;
            },
        },
        {
            key: 'rain_poem_summon_use',
            label: '雨落成诗-使用祈雨瓶',
            activityIds: WINDOW_IDS.rainPoem,
            run: async () => {
                if (!await weatherActivityOpen()) return false;
                await activityCenter.useWeatherSummonBottle();
                return true;
            },
        },
        {
            key: 'star_solar_quiz_claim',
            label: '节令答题自动领取',
            run: async () => {
                const solar = require('./solar-calendar');
                const state = await solar.getSolarCalendar();
                let answered = false;
                for (const event of state.events || []) {
                    if (!event.canAnswer || event.answerIndex == null) continue;
                    if ((event.wrongOptions || []).includes(event.answerIndex)) continue;
                    const result = await solar.operateSolarCalendar('answer', {
                        id: event.id,
                        optionIndex: event.answerIndex,
                        expectedQuestion: event.question,
                    });
                    answered = true;
                    log('活动', `活动自动化：节令答题${result?.correct ? '答对并领取附加奖励' : '答错'}：${event.name}`, { event: 'activity_automation' });
                }
                return answered;
            },
        },
        {
            key: 'share_reward_milestones',
            label: '分享奖励-里程碑领取',
            activityIds: WINDOW_IDS.shareReward,
            run: async () => {
                const shareReward = require('./share-reward-activity');
                const instances = require('../activity-data/share-reward-instances.json');
                let claimed = false;
                for (const instance of instances) {
                    const state = await shareReward.getShareRewardActivity(instance.activityId).catch(() => null);
                    if (!state?.active || !state.canClaimMilestones) continue;
                    await shareReward.operateShareRewardActivity(instance.activityId, 'milestones');
                    claimed = true;
                }
                return claimed;
            },
        },
        {
            // 点券限时礼包自动购买：开关 mall_coupon_gift_buy 由 UI 暴露（MILK_TEA_AUTOMATION_OPTIONS），
            // 之前只混进首页计数、没有对应执行体；这里补上真实购买逻辑（见 mall-coupon-gift.ts）。
            key: 'mall_coupon_gift_buy',
            label: '自动购买点券礼包',
            run: async () => {
                const bought = await require('./mall-coupon-gift').autoBuyCouponGifts(false);
                return bought > 0;
            },
        },
        {
            // 秋祈良愿-祈愿抽签：wish_sign_draw 开关 + wish_sign_choice 指定祈愿方向（默认取第一个）。
            key: 'wish_sign_draw',
            label: '秋祈良愿-祈愿抽签',
            run: async (automation: any) => {
                const autumn = require('./autumn-activities');
                const state = await autumn.getAutumnActivity('wish').catch(() => null);
                if (!state?.active || !state.canDraw) return false;
                const choices: any[] = Array.isArray(state.choices) ? state.choices : [];
                if (choices.length === 0) return false;
                const preferred = toNum(automation.wish_sign_choice);
                const choiceId = choices.some((v: any) => toNum(v.id) === preferred)
                    ? preferred
                    : toNum(choices[0].id);
                if (!Number.isInteger(choiceId)) return false;
                await autumn.operateAutumnActivity('wish', 'draw', { chooseId: choiceId });
                return true;
            },
        },
        {
            key: 'wish_sign_claim',
            label: '秋祈良愿-领取祈愿奖励',
            run: async () => {
                const autumn = require('./autumn-activities');
                const state = await autumn.getAutumnActivity('wish').catch(() => null);
                if (!state?.active || !state.canClaim) return false;
                await autumn.operateAutumnActivity('wish', 'claim', {});
                return true;
            },
        },
        ...buildMilkTeaOps(),
    ];
}

/**
 * 跑一轮活动自动化。返回本轮实际执行成功的操作名列表。
 */
async function runActivityAutomationOnce(): Promise<string[]> {
    if (ticking) return [];
    ticking = true;
    const executed: string[] = [];
    const now = Date.now();
    try {
        // 一轮只读一次组数据再分发：奶茶 9 个 op + 分享 3 个 op 在本轮内共享同一份
        // GetGroup / 背包 / 页面读；写操作成功后自动失效，下一个 op 重新读最新再决策。
        // 作用域是 AsyncLocalStorage，面板手动操作不在轮内，永远读实时数据。
        await withActivityRound(() => runActivityAutomationRound(executed, now));
    } finally {
        ticking = false;
    }
    return executed;
}

/** 轮次主体：必须在 withActivityRound 作用域内执行，读请求才会被合并分发。 */
async function runActivityAutomationRound(executed: string[], now: number): Promise<void> {
    const automation = getAutomationSnapshot();
    const ops = buildOps();
    // 活动窗口闸门：明确过期的活动连状态都不读、请求都不发（对齐老版「不进分支」）。
    const windowGate = await buildActivityWindowGate();
    let budget = MAX_OPS_PER_ROUND;

    for (const op of ops) {
        if (budget <= 0) break;
        if (!automation[op.key]) continue;
        if (!windowGate(op.activityIds)) {
            logFileOnly('活动', `活动自动化：${op.label} 所属活动不在开放区间，本轮跳过`, { event: 'activity_automation' });
            continue;
        }
        if (isCoolingDown(op, now)) continue;

        budget -= 1;
        lastRunAt.set(op.key, now);
        try {
            const did = await op.run(automation);
            if (did) {
                // 这一轮发生过写操作：本轮共享的组数据/背包快照作废，后面的 op 重新读最新状态。
                invalidateActivityRound();
                executed.push(op.label);
                log('活动', `活动自动化：${op.label} 执行完成`, { event: 'activity_automation' });
            } else {
                // 无可领取 / 未开放是常态；对齐老版：这类跳过只写日志文件，不在前端日志面板显示。
                logFileOnly('活动', `活动自动化：${op.label} 本轮无可领取或活动未开放`, { event: 'activity_automation' });
            }
        } catch (error: any) {
            // 对齐老版：老版是「先读活动状态 → 不满足就整段不进分支」，所以从不会出现
            // 「跳过（原因）」这类日志。这里把同类的跳过（限流让路 / 活动未开启 / 冷却未到）
            // 只写日志文件，不进前端面板；真正执行失败才可见，文案沿用老版的「失败: 原因」。
            const message = String(error?.message || error || '');
            if (isTransientGatewaySkip(error) || isActivityNotOpenMessage(message)) {
                logFileOnly('活动', `活动自动化：${op.label} 本轮跳过（${message}）`, { event: 'activity_automation' });
            } else {
                logWarn('活动', `活动自动化：${op.label} 失败: ${message}`, { event: 'activity_automation' });
            }
        }
    }

    // 本轮跑完按各活动的时间点重排精准唤醒（老版在这三个活动分支末尾各设一个一次性定时器）。
    try {
        await rescheduleActivityEventTimers(automation, windowGate);
    } catch (error: any) {
        logFileOnly('活动', `活动自动化：事件定时器重排失败（${String(error?.message || error || '')}）`, { event: 'activity_automation' });
    }

    // 只提醒一次：开关打开了但本版本没有对应协议实现的字段。
    const unsupported = [
        'star_record_claim',
        'milk_tea_auto_open',
        'qixi_dew_use',
        'rain_poem_weather_collect',
        'rain_poem_prank_use',
        'rain_poem_research_unlock',
        'charity_flower_reward_claim',
        'charity_flower_public_fund_claim',
        'charity_flower_share_claim',
        'pet_diary_story_claim',
        'pet_diary_solar_claim',
        'pet_diary_compensation_claim',
        'pet_diary_charm_equip',
        'pet_diary_battle',
    ];
    for (const key of unsupported) {
        if (!automation[key] || warnedKeys.has(key)) continue;
        warnedKeys.add(key);
        // key 写进消息正文：组合日志只保留 message 字段，放 meta 会丢。
        logWarn('活动', `活动自动化待接入：${key} 已开启，但当前版本尚未接入对应协议实现`, { event: 'activity_automation' });
    }
}

function startActivityAutomation(workerScheduler: any, intervalMs: number = 5 * 60 * 1000): void {
    stopActivityAutomation();
    workerSchedulerRef = workerScheduler || null;
    const tick = () => {
        const { runExclusiveAutomationTask } = require('./automation-lock');
        return runExclusiveAutomationTask('activity_automation', () => runActivityAutomationOnce())
            .catch((error: any) => {
                logWarn('活动', `活动自动化执行异常：${String(error?.message || error || '')}`, { event: 'activity_automation' });
            });
    };
    if (workerScheduler && typeof workerScheduler.setIntervalTask === 'function') {
        workerScheduler.setIntervalTask('activity_automation_interval', intervalMs, tick, { preventOverlap: true });
        // 对齐老版 star_activity_claim_initial：启动后 10 秒先跑一轮，不等第一个 5 分钟。
        workerScheduler.setTimeoutTask('activity_automation_initial', 10 * 1000, () => { void tick(); });
        timer = true;
        return;
    }
    timer = setInterval(() => runWithRequestClass('farm', tick), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    const initial = setTimeout(() => runWithRequestClass('farm', tick), 10 * 1000);
    if (initial && typeof initial.unref === 'function') initial.unref();
    // 句柄必须留着，否则 stop 之后这条 10 秒后的首跑仍会对旧账号动手。
    fallbackInitialTimer = initial;
}

function stopActivityAutomation(): void {
    if (timer && timer !== true && typeof clearInterval === 'function') {
        clearInterval(timer);
    }
    timer = null;
    if (fallbackInitialTimer != null) {
        try { clearTimeout(fallbackInitialTimer); } catch {}
        fallbackInitialTimer = null;
    }
    if (typeof workerSchedulerRef?.clear === 'function') {
        // activity_automation_interval 是主循环本身：漏清会让 stop 之后的每个周期
        // 仍然按旧账号的开关跑一轮活动，切号/停机都拦不住。
        workerSchedulerRef.clear('activity_automation_interval');
        workerSchedulerRef.clear('activity_automation_initial');
        workerSchedulerRef.clear('activity_automation_after_save');
    }
    // 三个事件唤醒也属于本循环，停机/切号时必须一起清，否则会对旧账号的活动下手。
    clearAllEventTimers();
}

/**
 * 收获后 2 秒补一次（对齐老版 farmHarvested 里的 rain_poem_after_harvest）。
 *
 * 只在开了「使用祈雨瓶」时才排：雷雨期间的收获进度决定了要不要续雨。
 */
function scheduleActivityAutomationAfterHarvest(): void {
    let automation: any = {};
    try {
        automation = getAutomationSnapshot();
    } catch {
        automation = {};
    }
    if (automation.rain_poem_summon_use !== true) {
        clearEventTimer('rain_poem_after_harvest');
        return;
    }
    scheduleEventTimer('rain_poem_after_harvest', 2000);
}

/**
 * 保存自动化配置后延迟跑一轮（对齐老版 star_activity_claim_after_save 的 2 秒节奏）。
 * 新开启的开关由 resetCooldownsForEnabledKeys 清掉冷却后，这一轮即可立即生效。
 */
function scheduleActivityAutomationAfterSave(workerScheduler: any, delayMs: number = 2000): void {
    if (workerScheduler && typeof workerScheduler.setTimeoutTask === 'function') {
        workerSchedulerRef = workerScheduler;
        workerScheduler.setTimeoutTask('activity_automation_after_save', delayMs, () => {
            const { runExclusiveAutomationTask } = require('./automation-lock');
            return runExclusiveAutomationTask('activity_automation', () => runActivityAutomationOnce())
                .catch((error: any) => {
                    logWarn('活动', `活动自动化执行异常：${String(error?.message || error || '')}`, { event: 'activity_automation' });
                });
        });
        return;
    }
    setTimeout(() => {
        runActivityAutomationOnce().catch(() => null);
    }, delayMs);
}

/** 新开启的开关立即生效：清除这些 key 的冷却记录。 */
function resetCooldownsForEnabledKeys(enabledKeys: string[]): void {
    for (const key of enabledKeys) lastRunAt.delete(key);
}

module.exports = {
    runActivityAutomationOnce,
    startActivityAutomation,
    stopActivityAutomation,
    scheduleActivityAutomationAfterSave,
    scheduleActivityAutomationAfterHarvest,
    resetCooldownsForEnabledKeys,
    buildOps,
    // 导出供协议状态回归测试直接校验三个事件唤醒的排定条件与延迟。
    rescheduleActivityEventTimers,
    // 奶茶兑换商店的种子购买优先级（活动种子 → 经验种子 → 金币种子）。
    pickSeedGoods,
    // 兑换商店化肥识别与选购，供回归测试直接校验。
    milkTeaFertilizerKind,
    pickFertilizerGoods,
};
