/**
 * 资产数字格式化（自老版 utils/number-format.ts 移植）：
 * 金币 / 点券 / 金豆达到万、亿级别时自动缩写为「万」「亿」。
 */
const WAN_UNIT = '万'
const YI_UNIT = '亿'
const WAN_THRESHOLD = 10000
const YI_THRESHOLD = 100000000

function toFiniteNumber(value: unknown) {
  const amount = Number(value ?? 0)
  return Number.isFinite(amount) ? amount : 0
}

function formatCompactAmount(value: unknown) {
  const amount = toFiniteNumber(value)
  const absAmount = Math.abs(amount)
  if (absAmount >= YI_THRESHOLD)
    return `${(amount / YI_THRESHOLD).toFixed(2)}${YI_UNIT}`
  if (absAmount >= WAN_THRESHOLD) {
    // 四舍五入到两位小数后可能正好是 10000.00 万（例如 99,999,999），
    // 直接输出会变成「10000.00万」——看着像坏了。这种情况进位成「亿」。
    const wan = Number((amount / WAN_THRESHOLD).toFixed(2))
    if (Math.abs(wan) >= 10000)
      return `${(amount / YI_THRESHOLD).toFixed(2)}${YI_UNIT}`
    return `${wan.toFixed(2)}${WAN_UNIT}`
  }
  return amount.toLocaleString('zh-CN')
}

export function formatGoldAmount(value: unknown) {
  return formatCompactAmount(value)
}

export function formatCouponAmount(value: unknown) {
  return formatCompactAmount(value)
}

export function formatGoldBeanAmount(value: unknown) {
  return formatCompactAmount(value)
}
