/**
 * 账号管理页「访问凭证」状态判定。
 *
 * 拆成纯函数是为了能单测，也避免 .vue 里的时间单位/历史失败标记把刚重新
 * 扫码登录的账号误染成「待续期」的琥珀色。
 */

const COLOR_GREEN = 'text-green-600 dark:text-green-400'
const COLOR_AMBER = 'text-amber-600 dark:text-amber-400'
const COLOR_RED = 'text-red-600 dark:text-red-400'
const COLOR_GRAY = 'text-gray-500'

/** 后端在到期前 5 分钟才滚令牌，界面提前 10 分钟提示即可（与 core 的 code-watch 对齐）。 */
const WARNING_WINDOW_MS = 10 * 60_000
const DEFAULT_TTL_SECONDS = 7200

export interface CredentialStatus {
  text: string
  color: string
}

export interface WxPreflightBadge {
  text: string
  hint: string
  badgeClass: string
}

/** 后端持久化账本快照：只有时间戳与次数，没有任何凭证内容。 */
export interface WxPreflightStats {
  date?: string
  lastSuccessAt?: number
  lastFailureAt?: number
  successesToday?: number
  failuresToday?: number
}

export interface WxPreflightSummary {
  /** 手机端与 PC 端共用的完整文案：上次续期 + 今日成功 + 今日失败。 */
  text: string
  color: string
  hint: string
}

const BADGE_SUPPORTED = 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400'
const BADGE_UNSUPPORTED = 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
const BADGE_UNKNOWN = 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'

/**
 * 账号卡片「免扫码续期」标记。
 *
 * 判定完全由后端给的布尔字段决定（wxid + refreshtoken 齐备），前端不接触
 * 任何凭证明文。字段缺失说明服务还是旧版本，给「未知」而不是误报「不支持」。
 * QQ 账号不适用这套微信续期机制，返回 null 不渲染。
 */
export function getWxPreflightBadge(acc: any): WxPreflightBadge | null {
  if (String(acc?.platform || '') !== 'wx')
    return null
  if (acc.wxPreflightSupported === true)
    return { text: '支持', hint: '关掉网页也会自动续期', badgeClass: BADGE_SUPPORTED }
  if (acc.wxPreflightSupported === false)
    return { text: '不支持', hint: '缺刷新凭证，到期需重新扫码', badgeClass: BADGE_UNSUPPORTED }
  return { text: '未知', hint: '更新服务后可查看', badgeClass: BADGE_UNKNOWN }
}

/** 凭证约 2 小时到期、到期前 45 分钟续期，超过 3 小时没有成功记录就值得提醒。 */
const PREFLIGHT_STALE_MS = 3 * 3600_000

/** 毫秒时间戳（兼容老数据可能写成的秒级），无效值返回 0。 */
function normalizeTimestamp(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0)
    return 0
  return n < 1e11 ? n * 1000 : n
}

function formatAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  if (diff < 60_000)
    return '刚刚'
  if (diff < 3600_000)
    return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 24 * 3600_000)
    return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / (24 * 3600_000))} 天前`
}

/**
 * 账号卡片「上次自动续期 · 今日成功 N 次 · 今日失败 M 次」。
 *
 * 手机端与 PC 端显示同一份文案——成功次数同样说明「后端真的在续」，不能只给
 * PC 看，否则手机上看不出续期有没有生效。
 * 数据来自后端持久化的自动续期账本（preflight-stats.json），字段缺失说明服务
 * 还是旧版本，返回 null 不渲染，避免把「还没更新」误报成「没在续期」。
 * 只统计后端自动发起的到期前续期与掉线重登，手动点按钮不计入。
 */
export function getWxPreflightSummary(acc: any, now: number = Date.now()): WxPreflightSummary | null {
  if (String(acc?.platform || '') !== 'wx')
    return null
  // 账本记的是「自动续期 / 掉线后自动重登」的结果。只有 loginBuffer 的账号滚不了
  // token（wxPreflightSupported=false），但掉线换 Code 照样会自动做并写进账本，
  // 所以门禁要看 wxCanRecover。字段缺失说明服务还是旧版本，回落到旧判定。
  const canRecord = acc.wxCanRecover === undefined
    ? acc.wxPreflightSupported === true
    : acc.wxCanRecover === true
  if (!canRecord)
    return null
  const stats = acc.wxPreflightStats
  if (!stats || typeof stats !== 'object')
    return null

  const lastSuccessAt = normalizeTimestamp(stats.lastSuccessAt)
  const lastFailureAt = normalizeTimestamp(stats.lastFailureAt)
  const successesToday = Math.max(0, Number(stats.successesToday) || 0)
  const failuresToday = Math.max(0, Number(stats.failuresToday) || 0)
  const hintBase = '只统计后端自动发起的到期前续期与掉线重登，手动续期不计入；按北京时间自然日计数，容器重启不丢失。'
  const hint = lastSuccessAt
    ? `${hintBase} 最近一次成功：${new Date(lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}`
    : hintBase

  const successText = `今日成功 ${successesToday} 次`
  if (!lastSuccessAt) {
    return {
      text: `上次自动续期：暂无记录 · ${successText} · 今日失败 ${failuresToday} 次`,
      color: failuresToday > 0 ? COLOR_RED : COLOR_GRAY,
      hint,
    }
  }

  const when = formatAgo(lastSuccessAt, now)
  const text = `上次自动续期：${when} · ${successText} · 今日失败 ${failuresToday} 次`
  const color = failuresToday > 0 && lastFailureAt > lastSuccessAt
    ? COLOR_RED
    : failuresToday > 0 || now - lastSuccessAt > PREFLIGHT_STALE_MS
      ? COLOR_AMBER
      : COLOR_GREEN
  return { text, color, hint }
}

/** 兼容秒级 / 毫秒级到期时间戳；老数据可能由外部写成秒。 */
function normalizeExpiry(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    return 0
  return value < 1e11 ? value * 1000 : value
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor(seconds / 60) % 60
  const s = seconds % 60
  return `${h} 小时 ${m} 分 ${String(s).padStart(2, '0')} 秒`
}

export function getCredentialStatus(acc: any, now: number = Date.now()): CredentialStatus {
  const rawExpiresAt = Number(acc?.expires_at)
  const refreshedAt = Number(acc?.wxCredentialRefreshedAt) || 0
  const lastAttemptAt = Number(acc?.wxCredentialLastAttemptAt) || 0
  const ttlSeconds = Number(acc?.expires_in) > 0 ? Number(acc.expires_in) : DEFAULT_TTL_SECONDS

  let expiresAt = normalizeExpiry(rawExpiresAt)
  if (!expiresAt) {
    if (!refreshedAt)
      return { text: '访问凭证：到期时间未知', color: COLOR_GRAY }
    if (refreshedAt > now)
      return { text: '访问凭证：时间异常', color: COLOR_RED }
    // 旧账号没有 expires_at：用最近一次成功续期时间 + TTL 兜底。
    expiresAt = refreshedAt + ttlSeconds * 1000
  }
  else if (refreshedAt > 0 && refreshedAt <= now) {
    // 重新扫码 / 换 Code 后若仍留着旧的（已过期或即将过期）到期时间，
    // 以最近一次成功时间重新起算，避免刚登录就显示黄色或红色。
    expiresAt = Math.max(expiresAt, refreshedAt + ttlSeconds * 1000)
  }

  // 失败标记只在「最近一次失败晚于最近一次成功」时才生效。
  // 历史错误不应让一次已经成功的新扫码继续显示待续期颜色。
  const hasError = !!String(acc?.wxCredentialRefreshError || '').trim()
  const warning = hasError && lastAttemptAt > refreshedAt

  const remaining = expiresAt - now
  const seconds = Math.max(0, Math.ceil(remaining / 1000))
  const nearExpiry = remaining > 0 && remaining <= WARNING_WINDOW_MS

  return {
    text: remaining <= 0
      ? '访问凭证：已过期'
      : `访问凭证：剩余 ${formatDuration(seconds)}${nearExpiry ? ' · 待续期' : ''}${warning ? ' · 上次续期失败' : ''}`,
    color: remaining <= 0
      ? COLOR_RED
      : warning || nearExpiry
        ? COLOR_AMBER
        : COLOR_GREEN,
  }
}
