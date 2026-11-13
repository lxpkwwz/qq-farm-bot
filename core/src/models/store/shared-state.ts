import type { AccountConfig, AutomationConfig, BagSeedFallbackStrategy, CapitalModeConfig, FertilizerLandType, GlobalConfig, IntervalConfig, LoginSettings, OfflineReminder, PlantingStrategy, QuietHoursConfig } from '../../types/config';
export {};

const { DEFAULT_TIME_ZONE, normalizeTimeZone, resolveClientVersion } = require('../../config/config');
const { getDataFile, ensureDataDir } = require('../../config/runtime-paths');
const { createConfigStorage } = require('./config-storage');
const { storageError } = require('../../services/json-db');
const { parseHourOfDay } = require('../../utils/hour-of-day');

const STORE_FILE: string = getDataFile('store.json');
const ACCOUNTS_FILE: string = getDataFile('accounts.json');
const configStorage = createConfigStorage(STORE_FILE);
const KNOWN_FRIEND_GIDS_DIR: string = getDataFile('known_friend_gids');

const ALLOWED_PLANTING_STRATEGIES: PlantingStrategy[] = ['preferred', 'level', 'max_exp', 'max_fert_exp', 'max_profit', 'max_fert_profit', 'bag_priority'];
const ALLOWED_BAG_SEED_FALLBACK_STRATEGIES: BagSeedFallbackStrategy[] = ALLOWED_PLANTING_STRATEGIES.filter((s): s is BagSeedFallbackStrategy => s !== 'bag_priority');
const PUSHOO_CHANNELS: Set<string> = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher', 'meow',
]);

const DEFAULT_FERTILIZER_LAND_TYPES: FertilizerLandType[] = ['purple-gold', 'gold', 'black', 'red', 'normal'];
const ALL_FERTILIZER_LAND_TYPES: FertilizerLandType[] = ['blue-crystal', ...DEFAULT_FERTILIZER_LAND_TYPES];
const FERTILIZER_LAND_TYPE_SET: Set<string> = new Set(ALL_FERTILIZER_LAND_TYPES);
const INTERVAL_MAX_SEC: number = 86400;
const DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC: number = 300;
const DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC: number = 60;
let systemConfigMigrated: boolean = false;
let accountFallbackConfig: AccountConfig;

const DEFAULT_OFFLINE_REMINDER: OfflineReminder = {
    channel: 'webhook',
    endpoint: '',
    token: '',
    secret: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
};

const DEFAULT_LOGIN_SETTINGS: LoginSettings = {
    wechatQrLogin: true,
    qqQrLogin: false,
    napCatEndpoint: '',
    napCatSignature: '',
};

/**
 * 收敛成「有限整数」。
 * `Number(x) || fallback` 会把 Infinity 当成合法值放行（JSON 里的 `1e400` 解析出来就是
 * Infinity），这类值进到等于比较 / 位运算里不会报错，只会静默失效。
 */
function toFiniteInt(input: unknown, fallback: unknown, minFallback: number = 0): number {
    const value = Number(input);
    if (Number.isFinite(value)) return Math.max(minFallback, Math.trunc(value));
    const fb = Number(fallback);
    return Number.isFinite(fb) ? Math.max(minFallback, Math.trunc(fb)) : minFallback;
}

const DEFAULT_CAPITAL_MODE: CapitalModeConfig = { enabled: false, dogId: 0, leadSeconds: 10 };

function normalizeCapitalMode(value: unknown, fallback: CapitalModeConfig = DEFAULT_CAPITAL_MODE): CapitalModeConfig {
    const input = (value && typeof value === 'object') ? value as Record<string, any> : {};
    const base = (fallback && typeof fallback === 'object') ? fallback : DEFAULT_CAPITAL_MODE;
    return {
        enabled: input.enabled !== undefined ? input.enabled === true : base.enabled === true,
        // `Number(x) || 0` 会原样放行 Infinity（JSON 里写 1e400 就是 Infinity），
        // 之后 `dog.id === dogId` 永远不成立，资本模式静默变成「从不派狗」。
        dogId: toFiniteInt(input.dogId ?? input.selectedDogId, base.dogId, 0),
        leadSeconds: Math.max(5, Math.min(300, toFiniteInt(input.leadSeconds ?? input.secondsBeforeMature, base.leadSeconds, 10))),
    };
}

const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
    automation: {
        farm: true,
        farm_harvest_tiangong: true,
        farm_push: true,
        land_upgrade: true,
        friend: true,
        friend_auto_accept: true,
        friend_help_exp_limit: true,
        friend_steal: true,
        friend_help: true,
        friend_bad: true,
        friend_help_protect_dog_ignore_exp_limit: true,
        task: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop_auto_buy: false,
        mystery_shop_allow_gold: true,
        mystery_shop_allow_coupon: false,
        mystery_shop_allow_gold_bean: false,
        mystery_shop_allow_diamond: false,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
        sell: true,
        fertilizer: 'smart',
        fertilizer_multi_season: true,
        fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES],
        fertilizer_smart_seconds: 300,
        skip_own_weed_bug: true,
        show_manual_fertilizer: true,

        // ---- 宠物（自动喂狗粮，默认开启） ----
        pet_feed_dog_food: true,
        pet_feed_dog_food_auto_buy: true,

        // ---- 收藏图鉴（每天检查一次；自动领奖/补种默认关闭，一键购买跳过背包已有种子默认开启） ----
        illustrated_auto_claim_rewards: false,
        illustrated_auto_buy_missing_seeds: false,
        illustrated_buy_skip_bag: true,

        // ---- 活动自动化（旧版功能模块「日常与活动」，默认关闭） ----
        task_after_farm: false,
        fertilizer_2x2_ripen: false,
        friend_golden_bug: false,
        golden_bug_clear: true,
        mall_coupon_gift_buy: false,

        star_passport_claim: false,
        star_solar_claim: false,
        star_solar_quiz_claim: false,
        star_record_claim: false,
        qingmei_seed_claim: false,
        qingmei_wine_brew: false,
        qixi_dew_use: false,
        qixi_bridge_build: false,
        qixi_sachet_gift: false,
        qixi_friend_priority: [],
        rain_poem_bottle_buy: false,
        rain_poem_weather_collect: false,
        rain_poem_summon_use: false,
        rain_poem_prank_use: false,
        rain_poem_research_unlock: false,
        charity_flower_share_claim: false,
        charity_flower_donate: false,
        charity_flower_reward_claim: false,
        charity_flower_public_fund_claim: false,
        wish_sign_draw: false,
        wish_sign_choice: 1,
        wish_sign_claim: false,
        share_reward_share: false,
        share_reward_daily: false,
        share_reward_milestones: false,
        pet_diary_adopt: false,
        pet_diary_feed: false,
        pet_diary_draw: false,
        pet_diary_story_claim: false,
        pet_diary_seed_claim: false,
        pet_diary_solar_claim: false,
        pet_diary_treasure_open: false,
        pet_diary_compensation_claim: false,
        pet_diary_charm_equip: false,
        pet_diary_battle: false,
        milk_tea_share: false,
        milk_tea_share_daily: false,
        milk_tea_share_rewards: false,
        milk_tea_fund_rewards: false,
        milk_tea_cashier: false,
        milk_tea_wages: false,
        milk_tea_upgrade: false,
        milk_tea_craft: false,
        milk_tea_boost: false,
        milk_tea_interact: false,
        milk_tea_interaction_type: 1,
        milk_tea_hire: false,
        milk_tea_hire_duration: 1,
        milk_tea_hire_talent: 0,
        milk_tea_hire_primary_talent: 0,
        milk_tea_hire_backup_talent: 0,
        milk_tea_seed_buy: false,
        // 「同时购买金币果/经验蘑菇种子」默认不买，且只有主开关开启时才生效。
        milk_tea_seed_buy_coin: false,
        milk_tea_seed_buy_exp: false,
        // 化肥购买相互独立，默认关闭。
        milk_tea_fertilizer_buy_normal: false,
        milk_tea_fertilizer_buy_organic: false,
        milk_tea_auto_open: false,
        milk_tea_work_interaction_type: 1,
        milk_tea_seed_policy: {},
        milk_tea_hire_policy: {},
    },
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    capitalMode: { ...DEFAULT_CAPITAL_MODE },
    // 农场巡查 20-25 秒、好友任务 30-35 秒。2-5 秒一轮会把网关打满（每次轮询都要
    // AllLands + 一批操作请求），这里回到更早的 20-25 秒方案；好友任务保持 30-35 秒。
    intervals: {
        farm: 20,
        farmMin: 20,
        farmMax: 25,
        friendMin: 30,
        friendMax: 35,
        helpMin: 30,
        helpMax: 35,
        stealMin: 30,
        stealMax: 35,
    },
    friendQuietHours: {
        enabled: false,
        start: '01:00',
        end: '07:30',
        continueFarm: true,
    },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
    friendBlacklist: [],
    plantBlacklist: [
        20002,
        20003,
        20059,
        20065,
        20064,
        20060,
        20061,
    ],
    stealDelaySeconds: 1,
    plantOrderRandom: true,
    plantDelaySeconds: 2,
    fertilizerBuyOrganicCount: 1,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 1,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 60,
    emailClaimHour: 10,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
    bagSeedPriority: [],
    bagSeedMultiLandReservationEnabled: false,
    bagSeedLandTypes: {},
    bagSeedFallbackStrategy: 'level',
    prioritize2x2Crops: true,
    autoAcceptFriendMinLevel: 0,
    autoAcceptRequireOwnLevel: false,
    autoAcceptHarvestStealEnabled: true,
    autoAcceptHarvestStealHarvest: 8,
    autoAcceptHarvestStealSteal: 1,
};

const ALLOWED_AUTOMATION_KEYS: Set<string> = new Set(Object.keys(DEFAULT_ACCOUNT_CONFIG.automation));

// 活动自动化里不是布尔的字段：数值、好友优先列表、奶茶策略对象。
// 归一化时必须保留原类型，否则会被 !!v 压成 true/false。
const AUTOMATION_NUMBER_KEYS: Set<string> = new Set([
    'wish_sign_choice',
    'milk_tea_interaction_type',
    'milk_tea_work_interaction_type',
    'milk_tea_hire_duration',
    'milk_tea_hire_talent',
    'milk_tea_hire_primary_talent',
    'milk_tea_hire_backup_talent',
]);

const AUTOMATION_OBJECT_KEYS: Set<string> = new Set([
    'milk_tea_seed_policy',
    'milk_tea_hire_policy',
]);

// ============ Normalization Helpers ============

function normalizeKnownFriendGids(input: unknown, fallback: number[] = []): number[] {
    const source: unknown[] = Array.isArray(input) ? input : fallback;
    const normalized: number[] = [];
    for (const item of source) {
        const value = Number.parseInt(item as string, 10);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

function normalizeKnownFriendGidSyncCooldownSec(input: unknown, fallback: number = DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(30, Math.min(INTERVAL_MAX_SEC, base));
}

function normalizeFriendsListCacheTtlSec(input: unknown, fallback: number = DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(10, Math.min(INTERVAL_MAX_SEC, base));
}

function normalizeEmailClaimHour(input: unknown, fallback: number = DEFAULT_ACCOUNT_CONFIG.emailClaimHour): number {
    return parseHourOfDay(input) ?? parseHourOfDay(fallback) ?? DEFAULT_ACCOUNT_CONFIG.emailClaimHour;
}

function normalizeAutoAcceptFriendMinLevel(input: unknown, fallback: number = 0): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(200, base));
}

function normalizeAutoAcceptHarvestStealHarvest(input: unknown, fallback: number = 8): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(9999, base));
}

function normalizeAutoAcceptHarvestStealSteal(input: unknown, fallback: number = 1): number {
    const value = Number.parseInt(input as string, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(1, Math.min(9999, base));
}

function normalizeBagSeedPriority(input: unknown): number[] {
    if (!Array.isArray(input)) return [];
    const normalized: number[] = [];
    for (const item of input) {
        const value = Number.parseInt(item as string, 10);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

/**
 * seedId -> 允许的土地类型。缺 key、空数组、全类型三者等价于不限制，统一省略该 key。
 */
function normalizeBagSeedLandTypes(input: unknown): Record<string, FertilizerLandType[]> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const normalized: Record<string, FertilizerLandType[]> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        const seedId = Number.parseInt(key, 10);
        if (!Number.isFinite(seedId) || seedId <= 0) continue;
        if (!Array.isArray(value)) continue;
        const types: FertilizerLandType[] = [];
        for (const item of value) {
            const type = String(item || '').trim().toLowerCase();
            if (!FERTILIZER_LAND_TYPE_SET.has(type)) continue;
            if (types.includes(type as FertilizerLandType)) continue;
            types.push(type as FertilizerLandType);
        }
        if (types.length === 0 || types.length === ALL_FERTILIZER_LAND_TYPES.length) continue;
        normalized[String(seedId)] = types;
    }
    return normalized;
}

function normalizeBagSeedFallbackStrategy(input: unknown, fallback: BagSeedFallbackStrategy = 'level'): BagSeedFallbackStrategy {
    const strategy = String(input || '').trim();
    if (ALLOWED_BAG_SEED_FALLBACK_STRATEGIES.includes(strategy as BagSeedFallbackStrategy)) return strategy as BagSeedFallbackStrategy;
    return fallback;
}

function normalizeFertilizerLandTypes(input: unknown, fallback: FertilizerLandType[] = DEFAULT_FERTILIZER_LAND_TYPES): FertilizerLandType[] {
    const source: unknown[] = Array.isArray(input) ? input : fallback;
    const normalized: FertilizerLandType[] = [];
    for (const item of source) {
        const value = String(item || '').trim().toLowerCase();
        if (!FERTILIZER_LAND_TYPE_SET.has(value)) continue;
        if (normalized.includes(value as FertilizerLandType)) continue;
        normalized.push(value as FertilizerLandType);
    }
    return normalized;
}

function normalizeTimeString(v: unknown, fallback: string): string {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return fallback;
    const hh = Math.max(0, Math.min(23, Number.parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, Number.parseInt(m[2], 10)));
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * 历史版本落盘过的「没改过」默认组，统一迁移到当前默认（农场 20-25 秒 / 好友 30-35 秒）。
 * - 组 A（b108a3d ~ 289c8d6 的对齐老版方案）：农场 2-5 秒 + 好友 30-35 秒
 * - 组 B（更早的 20-25 秒全组）：农场 20-25 秒 + 好友 20-25 秒
 * 只有整组完全命中才算「用户没改过」；任意一项被改过就原样保留，不覆盖手动配置。
 */
function isStockDefaultIntervals(src: Partial<IntervalConfig>): boolean {
    const actual = src as Record<string, unknown>;
    const eq = (key: string, want: number): boolean => Number.parseInt(actual[key] as string, 10) === want;
    const groupA = eq('farmMin', 2) && eq('farmMax', 5)
        && eq('friendMin', 30) && eq('friendMax', 35)
        && eq('helpMin', 30) && eq('helpMax', 35)
        && eq('stealMin', 30) && eq('stealMax', 35);
    const groupB = eq('farmMin', 20) && eq('farmMax', 25)
        && eq('friendMin', 20) && eq('friendMax', 25)
        && eq('helpMin', 20) && eq('helpMax', 25)
        && eq('stealMin', 20) && eq('stealMax', 25);
    return groupA || groupB;
}

function normalizeIntervals(intervals: Partial<IntervalConfig> | undefined): IntervalConfig {
    const src = (intervals && typeof intervals === 'object') ? intervals : {} as Partial<IntervalConfig>;
    // 旧的默认组合（2-5 秒方案、更早的 20-25 秒全组）一次性收敛到当前默认：
    // 农场 20-25 秒、好友/帮助/偷菜 30-35 秒。
    if (isStockDefaultIntervals(src)) {
        return { farm: 20, farmMin: 20, farmMax: 25, friendMin: 30, friendMax: 35, helpMin: 30, helpMax: 35, stealMin: 30, stealMax: 35 };
    }
    // 上界必须夹到 INTERVAL_MAX_SEC：面板只写了 min="1" 没有 max，`1e15` 这类值会一路
    // 变成 `*1000` 之后交给 setTimeout 的毫秒数，超过 32 位上限时 Node 会折成 1ms。
    const toSec = (v: unknown, d: number): number =>
        Math.max(1, Math.min(INTERVAL_MAX_SEC, Number.parseInt(v as string, 10) || d));
    const farm = toSec(src.farm, 20);

    let farmMin = toSec(src.farmMin, 20);
    let farmMax = toSec(src.farmMax, 25);
    if (farmMin > farmMax) [farmMin, farmMax] = [farmMax, farmMin];

    let helpMin = toSec(src.helpMin, 30);
    let helpMax = toSec(src.helpMax, 35);
    if (helpMin > helpMax) [helpMin, helpMax] = [helpMax, helpMin];

    let stealMin = toSec(src.stealMin, 30);
    let stealMax = toSec(src.stealMax, 35);
    if (stealMin > stealMax) [stealMin, stealMax] = [stealMax, stealMin];

    // 新配置使用统一好友任务间隔；旧账号自动取帮助/偷菜两组间隔中较快的一组。
    let friendMin = toSec(src.friendMin, Math.min(helpMin, stealMin));
    let friendMax = toSec(src.friendMax, Math.min(helpMax, stealMax));
    if (friendMin > friendMax) [friendMin, friendMax] = [friendMax, friendMin];

    return {
        ...src,
        farm,
        farmMin,
        farmMax,
        friendMin,
        friendMax,
        helpMin,
        helpMax,
        stealMin,
        stealMax,
    } as IntervalConfig;
}

function cloneAccountConfig(base: Partial<AccountConfig> = DEFAULT_ACCOUNT_CONFIG): AccountConfig {
    const srcAutomation = (base && base.automation && typeof base.automation === 'object')
        ? base.automation
        : {} as Partial<AutomationConfig>;
    const automation: AutomationConfig = { ...DEFAULT_ACCOUNT_CONFIG.automation };
    for (const key of Object.keys(automation) as Array<keyof AutomationConfig>) {
        if (key === 'fertilizer_land_types') {
            automation[key] = normalizeFertilizerLandTypes(srcAutomation[key], DEFAULT_FERTILIZER_LAND_TYPES);
            continue;
        }
        if (srcAutomation[key] !== undefined) (automation as any)[key] = (srcAutomation as any)[key];
    }

    const rawBlacklist: number[] = Array.isArray(base.friendBlacklist) ? base.friendBlacklist : [];

    const knownFriendGids = normalizeKnownFriendGids(base.knownFriendGids);
    const knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(base.knownFriendGidSyncCooldownSec);
    const friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(base.friendsListCacheTtlSec);

    const rawPlantBlacklist: number[] = Array.isArray(base.plantBlacklist) ? base.plantBlacklist : [];

    return {
        ...DEFAULT_ACCOUNT_CONFIG,
        ...base,
        automation,
        intervals: { ...(base.intervals || DEFAULT_ACCOUNT_CONFIG.intervals) },
        friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours, ...(base.friendQuietHours || {}) },
        knownFriendGids,
        knownFriendGidSyncCooldownSec,
        friendsListCacheTtlSec,
        friendBlacklist: rawBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        plantingStrategy: ALLOWED_PLANTING_STRATEGIES.includes(String(base.plantingStrategy || '') as PlantingStrategy)
            ? String(base.plantingStrategy) as PlantingStrategy
            : DEFAULT_ACCOUNT_CONFIG.plantingStrategy,
        capitalMode: normalizeCapitalMode(base.capitalMode),
        preferredSeedId: Math.max(0, Number.parseInt(String(base.preferredSeedId), 10) || 0),
        plantBlacklist: rawPlantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        stealDelaySeconds: Math.max(0, Math.min(300, Number(base.stealDelaySeconds) || 0)),
        plantOrderRandom: !!(base.plantOrderRandom),
        plantDelaySeconds: Math.max(0, Math.min(60, Number(base.plantDelaySeconds) || 0)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(10000, Number(base.fertilizerBuyOrganicCount) || 0)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(990, Number(base.fertilizerBuyOrganicThresholdHours) || 0)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(10000, Number(base.fertilizerBuyNormalCount) || 0)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(990, Number(base.fertilizerBuyNormalThresholdHours) || 0)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(base.fertilizerBuyCheckIntervalMinutes) || 30)),
        emailClaimHour: normalizeEmailClaimHour(base.emailClaimHour, DEFAULT_ACCOUNT_CONFIG.emailClaimHour),
        goldenBugKeepCount: Math.max(0, Math.min(10000, Math.floor(Number(base.goldenBugKeepCount) || 0))),
        goldenBugRoundLimit: Math.max(1, Math.min(100, Math.floor(Number(base.goldenBugRoundLimit) || DEFAULT_ACCOUNT_CONFIG.goldenBugRoundLimit))),
        bagSeedPriority: normalizeBagSeedPriority(base.bagSeedPriority),
        bagSeedMultiLandReservationEnabled: base.bagSeedMultiLandReservationEnabled !== undefined
            ? !!base.bagSeedMultiLandReservationEnabled
            : DEFAULT_ACCOUNT_CONFIG.bagSeedMultiLandReservationEnabled,
        bagSeedLandTypes: normalizeBagSeedLandTypes(base.bagSeedLandTypes),
        bagSeedFallbackStrategy: normalizeBagSeedFallbackStrategy(base.bagSeedFallbackStrategy),
        prioritize2x2Crops: base.prioritize2x2Crops !== undefined
            ? !!base.prioritize2x2Crops
            : DEFAULT_ACCOUNT_CONFIG.prioritize2x2Crops,
        autoAcceptFriendMinLevel: normalizeAutoAcceptFriendMinLevel(base.autoAcceptFriendMinLevel, DEFAULT_ACCOUNT_CONFIG.autoAcceptFriendMinLevel),
        autoAcceptRequireOwnLevel: !!base.autoAcceptRequireOwnLevel,
        autoAcceptHarvestStealEnabled: base.autoAcceptHarvestStealEnabled !== undefined
            ? !!base.autoAcceptHarvestStealEnabled
            : DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealEnabled,
        autoAcceptHarvestStealHarvest: normalizeAutoAcceptHarvestStealHarvest(base.autoAcceptHarvestStealHarvest, DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealHarvest),
        autoAcceptHarvestStealSteal: normalizeAutoAcceptHarvestStealSteal(base.autoAcceptHarvestStealSteal, DEFAULT_ACCOUNT_CONFIG.autoAcceptHarvestStealSteal),
    };
}

function normalizeAccountConfig(input: unknown, fallback: AccountConfig = accountFallbackConfig): AccountConfig {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const cfg = cloneAccountConfig(fallback || DEFAULT_ACCOUNT_CONFIG);

    if (src.automation && typeof src.automation === 'object') {
        for (const [k, v] of Object.entries(src.automation)) {
            if (!ALLOWED_AUTOMATION_KEYS.has(k)) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'smart', 'none'];
                (cfg.automation as any)[k] = allowed.includes(v as string) ? v : cfg.automation[k as keyof AutomationConfig];
            } else if (k === 'fertilizer_land_types') {
                cfg.automation.fertilizer_land_types = normalizeFertilizerLandTypes(v, cfg.automation.fertilizer_land_types);
            } else if (k === 'fertilizer_smart_seconds') {
                cfg.automation.fertilizer_smart_seconds = Math.max(30, Math.min(3600, Number(v) || 300));
            } else if (AUTOMATION_NUMBER_KEYS.has(k)) {
                const n = Number(v);
                if (Number.isFinite(n)) (cfg.automation as any)[k] = Math.max(0, Math.floor(n));
            } else if (k === 'qixi_friend_priority') {
                (cfg.automation as any)[k] = Array.isArray(v)
                    ? v.map(item => Number(item)).filter(item => Number.isFinite(item) && item > 0).slice(0, 50)
                    : cfg.automation.qixi_friend_priority;
            } else if (AUTOMATION_OBJECT_KEYS.has(k)) {
                if (v && typeof v === 'object' && !Array.isArray(v)) (cfg.automation as any)[k] = { ...v };
            } else {
                (cfg.automation as any)[k] = !!v;
            }
        }
    }

    if (src.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(src.plantingStrategy)) {
        cfg.plantingStrategy = src.plantingStrategy;
    }

    if (src.preferredSeedId !== undefined && src.preferredSeedId !== null) {
        cfg.preferredSeedId = Math.max(0, Number.parseInt(src.preferredSeedId, 10) || 0);
    }

    if (src.capitalMode && typeof src.capitalMode === 'object') {
        cfg.capitalMode = normalizeCapitalMode(src.capitalMode, cfg.capitalMode);
    }

    if (src.intervals && typeof src.intervals === 'object') {
        for (const [type, sec] of Object.entries(src.intervals)) {
            if (cfg.intervals[type] === undefined) continue;
            cfg.intervals[type] = Math.max(1, Number.parseInt(sec as string, 10) || cfg.intervals[type] || 1);
        }
        cfg.intervals = normalizeIntervals(cfg.intervals);
    } else {
        cfg.intervals = normalizeIntervals(cfg.intervals);
    }

    if (src.friendQuietHours && typeof src.friendQuietHours === 'object') {
        const old: Partial<QuietHoursConfig> = cfg.friendQuietHours || {};
        cfg.friendQuietHours = {
            enabled: src.friendQuietHours.enabled !== undefined ? !!src.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(src.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(src.friendQuietHours.end, old.end || '07:00'),
            continueFarm: src.friendQuietHours.continueFarm !== undefined
                ? !!src.friendQuietHours.continueFarm
                : (old.continueFarm !== undefined ? !!old.continueFarm : true),
        };
    }

    if (Array.isArray(src.friendBlacklist)) {
        cfg.friendBlacklist = src.friendBlacklist.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    }

    if (src.knownFriendGids !== undefined) {
        cfg.knownFriendGids = normalizeKnownFriendGids(src.knownFriendGids, cfg.knownFriendGids);
    }

    if (src.knownFriendGidSyncCooldownSec !== undefined) {
        cfg.knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(
            src.knownFriendGidSyncCooldownSec,
            cfg.knownFriendGidSyncCooldownSec,
        );
    }

    if (src.friendsListCacheTtlSec !== undefined) {
        cfg.friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(
            src.friendsListCacheTtlSec,
            cfg.friendsListCacheTtlSec,
        );
    }

    if (Array.isArray(src.plantBlacklist)) {
        cfg.plantBlacklist = src.plantBlacklist.map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    }

    if (src.stealDelaySeconds !== undefined && src.stealDelaySeconds !== null) {
        cfg.stealDelaySeconds = Math.max(0, Math.min(300, Number(src.stealDelaySeconds) || 0));
    }

    if (src.plantOrderRandom !== undefined && src.plantOrderRandom !== null) {
        cfg.plantOrderRandom = !!src.plantOrderRandom;
    }

    if (src.plantDelaySeconds !== undefined && src.plantDelaySeconds !== null) {
        cfg.plantDelaySeconds = Math.max(0, Math.min(60, Number(src.plantDelaySeconds) || 0));
    }

    if (src.fertilizerBuyOrganicCount !== undefined && src.fertilizerBuyOrganicCount !== null) {
        cfg.fertilizerBuyOrganicCount = Math.max(0, Math.min(10000, Number(src.fertilizerBuyOrganicCount) || 0));
    }

    if (src.fertilizerBuyOrganicThresholdHours !== undefined && src.fertilizerBuyOrganicThresholdHours !== null) {
        cfg.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(990, Number(src.fertilizerBuyOrganicThresholdHours) || 0));
    }

    if (src.fertilizerBuyNormalCount !== undefined && src.fertilizerBuyNormalCount !== null) {
        cfg.fertilizerBuyNormalCount = Math.max(0, Math.min(10000, Number(src.fertilizerBuyNormalCount) || 0));
    }

    if (src.fertilizerBuyNormalThresholdHours !== undefined && src.fertilizerBuyNormalThresholdHours !== null) {
        cfg.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(990, Number(src.fertilizerBuyNormalThresholdHours) || 0));
    }

    if (src.fertilizerBuyCheckIntervalMinutes !== undefined && src.fertilizerBuyCheckIntervalMinutes !== null) {
        cfg.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(src.fertilizerBuyCheckIntervalMinutes) || 30));
    }

    if (src.emailClaimHour !== undefined && src.emailClaimHour !== null) {
        cfg.emailClaimHour = normalizeEmailClaimHour(src.emailClaimHour, cfg.emailClaimHour);
    }

    if (src.goldenBugKeepCount !== undefined && src.goldenBugKeepCount !== null) {
        cfg.goldenBugKeepCount = Math.max(0, Math.min(10000, Math.floor(Number(src.goldenBugKeepCount) || 0)));
    }

    if (src.goldenBugRoundLimit !== undefined && src.goldenBugRoundLimit !== null) {
        cfg.goldenBugRoundLimit = Math.max(1, Math.min(100, Math.floor(Number(src.goldenBugRoundLimit) || DEFAULT_ACCOUNT_CONFIG.goldenBugRoundLimit)));
    }

    if (src.bagSeedPriority !== undefined && src.bagSeedPriority !== null) {
        cfg.bagSeedPriority = normalizeBagSeedPriority(src.bagSeedPriority);
    }

    if (src.bagSeedMultiLandReservationEnabled !== undefined && src.bagSeedMultiLandReservationEnabled !== null) {
        cfg.bagSeedMultiLandReservationEnabled = !!src.bagSeedMultiLandReservationEnabled;
    }

    if (src.bagSeedLandTypes !== undefined && src.bagSeedLandTypes !== null) {
        cfg.bagSeedLandTypes = normalizeBagSeedLandTypes(src.bagSeedLandTypes);
    }

    if (src.bagSeedFallbackStrategy !== undefined && src.bagSeedFallbackStrategy !== null) {
        cfg.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(src.bagSeedFallbackStrategy, cfg.bagSeedFallbackStrategy);
    }

    if (src.prioritize2x2Crops !== undefined && src.prioritize2x2Crops !== null) {
        cfg.prioritize2x2Crops = !!src.prioritize2x2Crops;
    }

    if (src.autoAcceptFriendMinLevel !== undefined && src.autoAcceptFriendMinLevel !== null) {
        cfg.autoAcceptFriendMinLevel = normalizeAutoAcceptFriendMinLevel(src.autoAcceptFriendMinLevel, cfg.autoAcceptFriendMinLevel);
    }

    if (src.autoAcceptRequireOwnLevel !== undefined && src.autoAcceptRequireOwnLevel !== null) {
        cfg.autoAcceptRequireOwnLevel = !!src.autoAcceptRequireOwnLevel;
    }

    if (src.autoAcceptHarvestStealEnabled !== undefined && src.autoAcceptHarvestStealEnabled !== null) {
        cfg.autoAcceptHarvestStealEnabled = !!src.autoAcceptHarvestStealEnabled;
    }

    if (src.autoAcceptHarvestStealHarvest !== undefined && src.autoAcceptHarvestStealHarvest !== null) {
        cfg.autoAcceptHarvestStealHarvest = normalizeAutoAcceptHarvestStealHarvest(src.autoAcceptHarvestStealHarvest, cfg.autoAcceptHarvestStealHarvest);
    }

    if (src.autoAcceptHarvestStealSteal !== undefined && src.autoAcceptHarvestStealSteal !== null) {
        cfg.autoAcceptHarvestStealSteal = normalizeAutoAcceptHarvestStealSteal(src.autoAcceptHarvestStealSteal, cfg.autoAcceptHarvestStealSteal);
    }

    return cfg;
}

// ============ Global Config (mutable shared state) ============

accountFallbackConfig = {
    ...DEFAULT_ACCOUNT_CONFIG,
    automation: { ...DEFAULT_ACCOUNT_CONFIG.automation, fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES] },
    intervals: { ...DEFAULT_ACCOUNT_CONFIG.intervals },
    friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
};

const globalConfig: GlobalConfig = {
    accountConfigs: {},
    defaultAccountConfig: cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG),
    ui: {
        theme: 'light',
    },
    loginSettings: { ...DEFAULT_LOGIN_SETTINGS },
    offlineReminder: { ...DEFAULT_OFFLINE_REMINDER },
    systemConfig: null,
};

function resolveAccountId(accountId: unknown): string {
    const direct = (accountId !== undefined && accountId !== null) ? String(accountId).trim() : '';
    if (direct) return direct;
    const envId = String((process as any).env.FARM_ACCOUNT_ID || '').trim();
    return envId;
}

function loadGlobalConfig(): void {
    try {
        ensureDataDir();
        const data: any = configStorage.load({ migrate: !process.env.FARM_ACCOUNT_ID });
        if (data && typeof data === 'object') {
            accountFallbackConfig = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

            const cfgMap = (data.accountConfigs && typeof data.accountConfigs === 'object')
                ? data.accountConfigs
                : {};
            globalConfig.accountConfigs = Object.create(null);
            for (const [id, cfg] of Object.entries(cfgMap)) {
                const sid = String(id || '').trim();
                if (!sid) continue;
                globalConfig.accountConfigs[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
            }
            globalConfig.ui = { ...globalConfig.ui, ...(data.ui || {}) };
            const theme = String(globalConfig.ui.theme || '').toLowerCase();
            globalConfig.ui.theme = theme === 'light' ? 'light' : 'dark';

            // offlineReminder normalization done in global-config
            if (data.offlineReminder && typeof data.offlineReminder === 'object') {
                globalConfig.offlineReminder = data.offlineReminder;
            }

            if (data.loginSettings && typeof data.loginSettings === 'object') {
                globalConfig.loginSettings = {
                    wechatQrLogin: typeof data.loginSettings.wechatQrLogin === 'boolean'
                        ? data.loginSettings.wechatQrLogin
                        : DEFAULT_LOGIN_SETTINGS.wechatQrLogin,
                    qqQrLogin: typeof data.loginSettings.qqQrLogin === 'boolean'
                        ? data.loginSettings.qqQrLogin
                        : DEFAULT_LOGIN_SETTINGS.qqQrLogin,
                    napCatEndpoint: typeof data.loginSettings.napCatEndpoint === 'string'
                        ? data.loginSettings.napCatEndpoint.trim()
                        : DEFAULT_LOGIN_SETTINGS.napCatEndpoint,
                    napCatSignature: typeof data.loginSettings.napCatSignature === 'string'
                        ? data.loginSettings.napCatSignature.trim()
                        : DEFAULT_LOGIN_SETTINGS.napCatSignature,
                };
            }

            if (data.systemConfig && typeof data.systemConfig === 'object') {
                const srcDevice = (data.systemConfig.deviceInfo && typeof data.systemConfig.deviceInfo === 'object')
                    ? data.systemConfig.deviceInfo : {};
                const deviceOs = String(srcDevice.os || data.systemConfig.os || 'Windows').trim();
                const savedTopVersion = String(data.systemConfig.clientVersion || '').trim();
                const savedDeviceVersion = String(srcDevice.clientVersion || '').trim();
                const savedVersion = savedDeviceVersion || savedTopVersion;
                const savedVersionUpdatedAt = Number(data.systemConfig.clientVersionUpdatedAt);
                const {
                    clientVersion: deviceClientVersion,
                    clientVersionUpdatedAt: deviceClientVersionUpdatedAt,
                } = resolveClientVersion(savedVersion, savedVersionUpdatedAt);
                const wxVersion = resolveClientVersion(data.systemConfig.wxClientVersion, data.systemConfig.wxClientVersionUpdatedAt, 'wx');
                const normalizedSystemConfig = {
                    serverUrl: String(data.systemConfig.serverUrl || '').trim(),
                    clientVersion: deviceClientVersion,
                    clientVersionUpdatedAt: deviceClientVersionUpdatedAt,
                    wxClientVersion: wxVersion.clientVersion,
                    wxClientVersionUpdatedAt: wxVersion.clientVersionUpdatedAt,
                    platform: String(data.systemConfig.platform || 'qq').trim(),
                    os: deviceOs,
                    timeZone: normalizeTimeZone(data.systemConfig.timeZone || DEFAULT_TIME_ZONE),
                    // 旧 store.json 没有该字段：默认开启服务启动自动登录。
                    autoStartAccounts: data.systemConfig.autoStartAccounts !== false,
                    autoCodeRefresh: data.systemConfig.autoCodeRefresh,
                    deviceInfo: {
                        os: deviceOs,
                        clientVersion: deviceClientVersion,
                        sysSoftware: String(srcDevice.sysSoftware || 'Windows').trim(),
                        network: String(srcDevice.network || 'wifi').trim(),
                        memory: String(srcDevice.memory || '16384').trim(),
                        deviceId: String(srcDevice.deviceId || 'DESKTOP-PC<WPC>').trim(),
                        userAgent: String(srcDevice.userAgent || '').trim(),
                    },
                };
                systemConfigMigrated = savedTopVersion !== deviceClientVersion
                    || savedDeviceVersion !== deviceClientVersion
                    || Number(data.systemConfig.clientVersionUpdatedAt) !== deviceClientVersionUpdatedAt
                    || data.systemConfig.wxClientVersion !== wxVersion.clientVersion
                    || Number(data.systemConfig.wxClientVersionUpdatedAt) !== wxVersion.clientVersionUpdatedAt
                    || data.systemConfig.timeZone !== normalizedSystemConfig.timeZone;
                globalConfig.systemConfig = normalizedSystemConfig;
            }
        }
    } catch (e: any) {
        console.error('加载配置失败:', e.message);
        throw storageError('读取', STORE_FILE, e);
    }
}

module.exports = {
    // File paths
    STORE_FILE,
    configStorage,
    ACCOUNTS_FILE,
    KNOWN_FRIEND_GIDS_DIR,
    // Constants
    ALLOWED_PLANTING_STRATEGIES,
    ALLOWED_BAG_SEED_FALLBACK_STRATEGIES,
    PUSHOO_CHANNELS,
    DEFAULT_FERTILIZER_LAND_TYPES,
    FERTILIZER_LAND_TYPE_SET,
    INTERVAL_MAX_SEC,
    DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
    DEFAULT_OFFLINE_REMINDER,
    DEFAULT_LOGIN_SETTINGS,
    DEFAULT_ACCOUNT_CONFIG,
    ALLOWED_AUTOMATION_KEYS,
    // Mutable shared state (by reference)
    globalConfig,
    get accountFallbackConfig() { return accountFallbackConfig; },
    set accountFallbackConfig(v: AccountConfig) { accountFallbackConfig = v; },
    get systemConfigMigrated() { return systemConfigMigrated; },
    set systemConfigMigrated(v: boolean) { systemConfigMigrated = !!v; },
    // Helpers
    normalizeKnownFriendGids,
    normalizeKnownFriendGidSyncCooldownSec,
    normalizeFriendsListCacheTtlSec,
    normalizeEmailClaimHour,
    normalizeBagSeedPriority,
    normalizeBagSeedLandTypes,
    normalizeBagSeedFallbackStrategy,
    normalizeFertilizerLandTypes,
    normalizeTimeString,
    normalizeIntervals,
    normalizeAutoAcceptFriendMinLevel,
    normalizeAutoAcceptHarvestStealHarvest,
    normalizeAutoAcceptHarvestStealSteal,
    normalizeCapitalMode,
    DEFAULT_CAPITAL_MODE,
    normalizeAccountConfig,
    cloneAccountConfig,
    resolveAccountId,
    loadGlobalConfig,
};
