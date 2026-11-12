import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { parseHourOfDay } from '@/utils/hour-of-day'
import { normalizeNotificationTemplates } from '@/utils/notification-template'

export interface MilkTeaSeedPolicy {
  targetSeedIds: number[]
  targetStock: number
  coinReserve: string
  coinDailyLimit: string
  ticketReserve: string
  ticketDailyLimit: string
}

export interface MilkTeaHirePolicy {
  durationId: number
  ticketDailyLimit: string
  ticketReserve: string
}

export interface AutomationConfig {
  farm?: boolean
  farm_harvest_tiangong?: boolean
  farm_push?: boolean
  land_upgrade?: boolean
  friend?: boolean
  friend_auto_accept?: boolean
  task?: boolean
  task_after_farm?: boolean
  sell?: boolean
  fertilizer?: string
  fertilizer_multi_season?: boolean
  fertilizer_2x2_ripen?: boolean
  fertilizer_land_types?: string[]
  fertilizer_smart_seconds?: number
  illustrated_auto_claim_rewards?: boolean
  illustrated_auto_buy_missing_seeds?: boolean
  illustrated_buy_skip_bag?: boolean
  friend_steal?: boolean
  friend_help?: boolean
  friend_bad?: boolean
  friend_help_exp_limit?: boolean
  friend_help_protect_dog_ignore_exp_limit?: boolean
  friend_golden_bug?: boolean
  golden_bug_clear?: boolean
  fertilizer_gift?: boolean
  fertilizer_buy_organic?: boolean
  fertilizer_buy_normal?: boolean
  mall_coupon_gift_buy?: boolean
  mystery_shop_auto_buy?: boolean
  mystery_shop_allow_gold?: boolean
  mystery_shop_allow_coupon?: boolean
  mystery_shop_allow_gold_bean?: boolean
  mystery_shop_allow_diamond?: boolean
  mystery_shop_arrival_notify?: boolean
  mystery_shop_purchase_notify?: boolean
  skip_own_weed_bug?: boolean
  show_manual_fertilizer?: boolean
  // 宠物（自动喂狗粮）
  pet_feed_dog_food?: boolean
  pet_feed_dog_food_auto_buy?: boolean
  // 观星 / 星砂集市 / 节气
  star_passport_claim?: boolean
  star_solar_claim?: boolean
  star_solar_quiz_claim?: boolean
  star_record_claim?: boolean
  // 青莓酒馆
  qingmei_seed_claim?: boolean
  qingmei_wine_brew?: boolean
  // 七夕
  qixi_dew_use?: boolean
  qixi_bridge_build?: boolean
  qixi_sachet_gift?: boolean
  qixi_friend_priority?: number[]
  // 雨落成诗
  rain_poem_bottle_buy?: boolean
  rain_poem_weather_collect?: boolean
  rain_poem_summon_use?: boolean
  rain_poem_prank_use?: boolean
  rain_poem_research_unlock?: boolean
  // 公益红花
  charity_flower_share_claim?: boolean
  charity_flower_donate?: boolean
  charity_flower_reward_claim?: boolean
  charity_flower_public_fund_claim?: boolean
  // 许愿签
  wish_sign_draw?: boolean
  wish_sign_choice?: number
  wish_sign_claim?: boolean
  // 分享奖励
  share_reward_share?: boolean
  share_reward_daily?: boolean
  share_reward_milestones?: boolean
  // 萌宠成长日记
  pet_diary_adopt?: boolean
  pet_diary_feed?: boolean
  pet_diary_draw?: boolean
  pet_diary_story_claim?: boolean
  pet_diary_seed_claim?: boolean
  pet_diary_solar_claim?: boolean
  pet_diary_treasure_open?: boolean
  pet_diary_compensation_claim?: boolean
  pet_diary_charm_equip?: boolean
  pet_diary_battle?: boolean
  // 奶茶店
  milk_tea_share?: boolean
  milk_tea_share_daily?: boolean
  milk_tea_share_rewards?: boolean
  milk_tea_fund_rewards?: boolean
  milk_tea_cashier?: boolean
  milk_tea_wages?: boolean
  milk_tea_upgrade?: boolean
  milk_tea_craft?: boolean
  milk_tea_boost?: boolean
  milk_tea_interact?: boolean
  milk_tea_interaction_type?: number
  milk_tea_hire?: boolean
  milk_tea_hire_duration?: number
  milk_tea_hire_talent?: number
  milk_tea_hire_primary_talent?: number
  milk_tea_hire_backup_talent?: number
  milk_tea_seed_buy?: boolean
  milk_tea_seed_buy_coin?: boolean
  milk_tea_seed_buy_exp?: boolean
  milk_tea_fertilizer_buy_normal?: boolean
  milk_tea_fertilizer_buy_organic?: boolean
  milk_tea_auto_open?: boolean
  milk_tea_work_interaction_type?: number
  milk_tea_seed_policy?: MilkTeaSeedPolicy
  milk_tea_hire_policy?: MilkTeaHirePolicy
}

export interface IntervalsConfig {
  farm?: number
  friend?: number
  farmMin?: number
  farmMax?: number
  friendMin?: number
  friendMax?: number
  helpMin?: number
  helpMax?: number
  stealMin?: number
  stealMax?: number
}

export interface FriendQuietHoursConfig {
  enabled?: boolean
  start?: string
  end?: string
  continueFarm?: boolean
}

export interface OfflineConfig {
  templates?: import('@/utils/notification-template').NotificationTemplates
  events?: Record<'account_offline' | 'friend_crop_forecast' | 'friend_crop_mature', string[]>
  smtpEnabled?: boolean
  barkEnabled?: boolean
  barkAccountKeys?: Record<string, string>
  barkLevels?: Record<import('@/utils/notification-template').NotificationEvent, string>
  barkTestKey?: string
  reloginUrlMode?: string
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  smtpPass?: string
  senderName?: string
  recipientEmail?: string
  emailContent?: string
  channel: string
  endpoint: string
  token: string
  secret?: string
  title: string
  msg: string
  offlineDeleteSec: number
}

export interface AutoCodeRefreshConfig {
  offlineEnabled: boolean
  offlineDelaySeconds: number
}

export interface FriendMonitorConfig {
  enabled: boolean
  friendGids: number[]
  barkKeys: Record<string, string>
  intervalMinSec: number
  intervalMaxSec: number
  leadSeconds: number
  forecastEnabled: boolean
  matureEnabled: boolean
  protectFriends: boolean
}

export function createDefaultFriendMonitor(): FriendMonitorConfig {
  return { enabled: false, friendGids: [], barkKeys: {}, intervalMinSec: 180, intervalMaxSec: 300, leadSeconds: 120, forecastEnabled: true, matureEnabled: true, protectFriends: true }
}

export interface UIConfig {
  theme?: string
}

export interface SettingsState {
  plantingStrategy: string
  preferredSeedId: number
  bagSeedPriority: number[]
  bagSeedMultiLandReservationEnabled: boolean
  bagSeedLandTypes: Record<string, string[]>
  bagSeedFallbackStrategy: string
  /** 优先种植 2×2 作物：开启后选种时多格作物排在单格前面。 */
  prioritize2x2Crops: boolean
  intervals: IntervalsConfig
  friendQuietHours: FriendQuietHoursConfig
  automation: AutomationConfig
  autoCodeRefresh: AutoCodeRefreshConfig
  friendMonitor: FriendMonitorConfig
  ui: UIConfig
  offlineReminder: OfflineConfig
  stealDelaySeconds: number
  plantOrderRandom: boolean
  plantDelaySeconds: number
  fertilizerBuyOrganicCount: number
  fertilizerBuyOrganicThresholdHours: number
  fertilizerBuyNormalCount: number
  fertilizerBuyNormalThresholdHours: number
  fertilizerBuyCheckIntervalMinutes: number
  emailClaimHour: number
  goldenBugKeepCount: number
  goldenBugRoundLimit: number
  autoAcceptFriendMinLevel: number
  autoAcceptRequireOwnLevel: boolean
  autoAcceptHarvestStealEnabled: boolean
  autoAcceptHarvestStealHarvest: number
  autoAcceptHarvestStealSteal: number
}

type SaveableSettingsKey
  = | 'plantingStrategy'
    | 'preferredSeedId'
    | 'bagSeedPriority'
    | 'bagSeedMultiLandReservationEnabled'
    | 'bagSeedLandTypes'
    | 'bagSeedFallbackStrategy'
    | 'prioritize2x2Crops'
    | 'intervals'
    | 'friendQuietHours'
    | 'automation'
    | 'stealDelaySeconds'
    | 'plantOrderRandom'
    | 'plantDelaySeconds'
    | 'fertilizerBuyOrganicCount'
    | 'fertilizerBuyOrganicThresholdHours'
    | 'fertilizerBuyNormalCount'
    | 'fertilizerBuyNormalThresholdHours'
    | 'fertilizerBuyCheckIntervalMinutes'
    | 'emailClaimHour'
    | 'goldenBugKeepCount'
    | 'goldenBugRoundLimit'
    | 'autoAcceptFriendMinLevel'
    | 'autoAcceptRequireOwnLevel'
    | 'autoAcceptHarvestStealEnabled'
    | 'autoAcceptHarvestStealHarvest'
    | 'autoAcceptHarvestStealSteal'

export type SettingsSavePayload = Partial<Pick<SettingsState, SaveableSettingsKey>>

const SAVEABLE_SETTINGS_KEYS: SaveableSettingsKey[] = [
  'plantingStrategy',
  'preferredSeedId',
  'bagSeedPriority',
  'bagSeedMultiLandReservationEnabled',
  'bagSeedLandTypes',
  'bagSeedFallbackStrategy',
  'prioritize2x2Crops',
  'intervals',
  'friendQuietHours',
  'automation',
  'stealDelaySeconds',
  'plantOrderRandom',
  'plantDelaySeconds',
  'fertilizerBuyOrganicCount',
  'fertilizerBuyOrganicThresholdHours',
  'fertilizerBuyNormalCount',
  'fertilizerBuyNormalThresholdHours',
  'fertilizerBuyCheckIntervalMinutes',
  'emailClaimHour',
  'goldenBugKeepCount',
  'goldenBugRoundLimit',
  'autoAcceptFriendMinLevel',
  'autoAcceptRequireOwnLevel',
  'autoAcceptHarvestStealEnabled',
  'autoAcceptHarvestStealHarvest',
  'autoAcceptHarvestStealSteal',
]

export function createDefaultOfflineReminder(): OfflineConfig {
  return {
    templates: normalizeNotificationTemplates(),
    events: {
      account_offline: ['smtp', 'bark'],
      friend_crop_forecast: ['smtp', 'bark'],
      friend_crop_mature: ['smtp', 'bark'],
    },
    channel: 'webhook',
    smtpEnabled: false,
    barkEnabled: false,
    barkAccountKeys: {},
    barkLevels: {
      account_offline: 'timeSensitive',
      friend_crop_forecast: 'timeSensitive',
      friend_crop_mature: 'critical',
    },
    reloginUrlMode: 'none',
    endpoint: '',
    token: '',
    secret: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
    smtpHost: '',
    smtpPort: 465,
    smtpUser: '',
    smtpPass: '',
    senderName: '',
    recipientEmail: '',
    emailContent: '',
  }
}

function normalizeOfflineReminder(input: Partial<OfflineConfig> | null | undefined): OfflineConfig {
  const base = createDefaultOfflineReminder()
  return {
    ...base,
    ...(input || {}),
    events: { ...base.events, ...input?.events } as OfflineConfig['events'],
    templates: normalizeNotificationTemplates(input?.templates),
    barkAccountKeys: { ...input?.barkAccountKeys },
    barkLevels: { ...base.barkLevels, ...input?.barkLevels } as OfflineConfig['barkLevels'],
  }
}

function createDefaultSettings(): SettingsState {
  return {
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    bagSeedPriority: [],
    bagSeedMultiLandReservationEnabled: false,
    bagSeedLandTypes: {},
    bagSeedFallbackStrategy: 'level',
    prioritize2x2Crops: true,
    intervals: {},
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', continueFarm: true },
    automation: {},
    autoCodeRefresh: { offlineEnabled: true, offlineDelaySeconds: 60 },
    friendMonitor: createDefaultFriendMonitor(),
    ui: {},
    offlineReminder: createDefaultOfflineReminder(),
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    fertilizerBuyOrganicCount: 10,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 10,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 30,
    emailClaimHour: 10,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
    autoAcceptFriendMinLevel: 0,
    autoAcceptRequireOwnLevel: false,
    autoAcceptHarvestStealEnabled: true,
    autoAcceptHarvestStealHarvest: 8,
    autoAcceptHarvestStealSteal: 1,
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null)
    return value
  return JSON.parse(JSON.stringify(value))
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>(createDefaultSettings())
  const loading = ref(false)
  const loadedAccountId = ref('')
  let pendingRequests = 0
  let fetchRevision = 0
  let latestRequestedAccountId = ''

  function beginRequest() {
    pendingRequests++
    loading.value = true
  }

  function endRequest() {
    pendingRequests = Math.max(0, pendingRequests - 1)
    loading.value = pendingRequests > 0
  }

  function applyFetchedSettings(data: any) {
    const defaults = createDefaultSettings()
    settings.value = {
      plantingStrategy: data.strategy || defaults.plantingStrategy,
      preferredSeedId: data.preferredSeed || defaults.preferredSeedId,
      bagSeedPriority: cloneValue(data.bagSeedPriority ?? defaults.bagSeedPriority),
      bagSeedMultiLandReservationEnabled: data.bagSeedMultiLandReservationEnabled ?? defaults.bagSeedMultiLandReservationEnabled,
      bagSeedLandTypes: cloneValue(data.bagSeedLandTypes ?? defaults.bagSeedLandTypes),
      bagSeedFallbackStrategy: data.bagSeedFallbackStrategy ?? defaults.bagSeedFallbackStrategy,
      prioritize2x2Crops: !!data.prioritize2x2Crops,
      intervals: cloneValue(data.intervals || defaults.intervals),
      friendQuietHours: {
        ...defaults.friendQuietHours,
        ...(cloneValue(data.friendQuietHours) || {}),
      },
      automation: cloneValue(data.automation || defaults.automation),
      autoCodeRefresh: { ...defaults.autoCodeRefresh, ...(cloneValue(data.autoCodeRefresh) || {}) },
      friendMonitor: { ...defaults.friendMonitor, ...(cloneValue(data.friendMonitor) || {}) },
      ui: cloneValue(data.ui || defaults.ui),
      offlineReminder: normalizeOfflineReminder(cloneValue(data.offlineReminder)),
      stealDelaySeconds: data.stealDelaySeconds ?? defaults.stealDelaySeconds,
      plantOrderRandom: data.plantOrderRandom ?? defaults.plantOrderRandom,
      plantDelaySeconds: data.plantDelaySeconds ?? defaults.plantDelaySeconds,
      fertilizerBuyOrganicCount: data.fertilizerBuyOrganicCount ?? defaults.fertilizerBuyOrganicCount,
      fertilizerBuyOrganicThresholdHours: data.fertilizerBuyOrganicThresholdHours ?? defaults.fertilizerBuyOrganicThresholdHours,
      fertilizerBuyNormalCount: data.fertilizerBuyNormalCount ?? defaults.fertilizerBuyNormalCount,
      fertilizerBuyNormalThresholdHours: data.fertilizerBuyNormalThresholdHours ?? defaults.fertilizerBuyNormalThresholdHours,
      fertilizerBuyCheckIntervalMinutes: data.fertilizerBuyCheckIntervalMinutes ?? defaults.fertilizerBuyCheckIntervalMinutes,
      emailClaimHour: data.emailClaimHour ?? defaults.emailClaimHour,
      goldenBugKeepCount: data.goldenBugKeepCount ?? defaults.goldenBugKeepCount,
      goldenBugRoundLimit: data.goldenBugRoundLimit ?? defaults.goldenBugRoundLimit,
      autoAcceptFriendMinLevel: data.autoAcceptFriendMinLevel ?? defaults.autoAcceptFriendMinLevel,
      autoAcceptRequireOwnLevel: data.autoAcceptRequireOwnLevel ?? defaults.autoAcceptRequireOwnLevel,
      autoAcceptHarvestStealEnabled: data.autoAcceptHarvestStealEnabled ?? defaults.autoAcceptHarvestStealEnabled,
      autoAcceptHarvestStealHarvest: data.autoAcceptHarvestStealHarvest ?? defaults.autoAcceptHarvestStealHarvest,
      autoAcceptHarvestStealSteal: data.autoAcceptHarvestStealSteal ?? defaults.autoAcceptHarvestStealSteal,
    }
  }

  function applySavedSettings(payload: SettingsSavePayload, data: any) {
    const normalized = data && typeof data === 'object' ? data : {}
    for (const key of SAVEABLE_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, key))
        (settings.value as any)[key] = cloneValue(payload[key])
      if (Object.prototype.hasOwnProperty.call(normalized, key))
        (settings.value as any)[key] = cloneValue(normalized[key])
    }

    if (normalized.strategy !== undefined)
      settings.value.plantingStrategy = normalized.strategy || 'max_exp'
    if (normalized.preferredSeed !== undefined)
      settings.value.preferredSeedId = normalized.preferredSeed || 0
  }

  async function fetchSettings(accountId: string) {
    if (!accountId)
      return false
    const requestRevision = ++fetchRevision
    latestRequestedAccountId = accountId
    loadedAccountId.value = ''
    beginRequest()
    try {
      const { data } = await api.get('/api/settings', {
        headers: { 'x-account-id': accountId },
      })
      if (requestRevision !== fetchRevision)
        return false
      if (data && data.ok && data.data) {
        applyFetchedSettings(data.data)
        loadedAccountId.value = accountId
        return true
      }
      return false
    }
    finally {
      endRequest()
    }
  }

  async function saveSettings(accountId: string, newSettings: SettingsSavePayload) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }

    const payload: SettingsSavePayload = {}
    for (const key of SAVEABLE_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(newSettings, key))
        (payload as any)[key] = cloneValue(newSettings[key])
    }

    // 后端对 emailClaimHour 有硬校验（非 0–23 整数直接抛 INVALID_CONFIG，整份快照都不生效）。
    // 设置页保存前已经拦过一次，这里兜住其它调用点：非法值就地剔除，别连累同一批的其它设置。
    const hasEmailClaimHour = Object.prototype.hasOwnProperty.call(payload, 'emailClaimHour')
    const emailClaimHour = parseHourOfDay((payload as any).emailClaimHour)
    if (hasEmailClaimHour) {
      if (emailClaimHour === null)
        delete (payload as any).emailClaimHour
      else
        (payload as any).emailClaimHour = emailClaimHour
    }

    if (Object.keys(payload).length === 0) {
      return {
        ok: false,
        error: hasEmailClaimHour ? '自动邮箱领取时间需为 0–23 的整数（时）' : '没有需要保存的设置',
      }
    }

    beginRequest()
    try {
      const { data } = await api.post('/api/settings/save', payload, {
        headers: { 'x-account-id': accountId },
        timeout: 15000,
      })
      if (!data?.ok) {
        if (data?.saved && (!latestRequestedAccountId || latestRequestedAccountId === accountId)) {
          loadedAccountId.value = accountId
          applySavedSettings(payload, data.data)
        }
        return {
          ok: false,
          saved: !!data?.saved,
          unconfirmed: !!data?.unconfirmed,
          data: data?.data,
          error: getApiErrorMessage(data, '保存失败'),
        }
      }

      if (!latestRequestedAccountId || latestRequestedAccountId === accountId) {
        loadedAccountId.value = accountId
        applySavedSettings(payload, data.data)
      }
      return { ok: true, data: data.data }
    }
    catch (error: any) {
      return { ok: false, error: getApiErrorMessage(error, '保存失败') }
    }
    finally {
      endRequest()
    }
  }

  async function saveOfflineConfig(config: OfflineConfig) {
    beginRequest()
    try {
      const { data } = await api.post('/api/settings/offline-reminder', config)
      if (data && data.ok) {
        settings.value.offlineReminder = cloneValue(config)
        return { ok: true }
      }
      return { ok: false, error: '保存失败' }
    }
    catch (error: any) {
      return { ok: false, error: getApiErrorMessage(error, '保存失败') }
    }
    finally {
      endRequest()
    }
  }

  return { settings, loading, loadedAccountId, fetchSettings, saveSettings, saveOfflineConfig }
})
