import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import test from 'node:test'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const dashboard = read('../src/views/Dashboard.vue')
const stats = read('../../core/src/services/stats.ts')
const runtimeState = read('../../core/src/runtime/runtime-state.ts')
const worker = read('../../core/src/core/worker.ts')

// 今日统计这四张卡片所在的 grid，用来精确限定「只改今日模块」的检查范围。
// 从 grid 容器的 class 起切，才能把「沿用两列网格」也一起断言进去。
const gridStart = dashboard.indexOf('<div class="grid grid-cols-2 mb-2 gap-2 2xl:gap-3" role="region" aria-label="今日金币')
const gridEnd = dashboard.indexOf('<div v-if="!operationGroups.active.length"', gridStart)
const grid = dashboard.slice(gridStart, gridEnd)

const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('今日统计按 金币 → 经验 → 金豆 → 点券 排列，四张卡片同在一个 grid', () => {
  assert.ok(gridStart > 0 && gridEnd > gridStart, '要取到今日统计的四卡 grid')
  const gold = grid.indexOf('alt="金币"')
  // 经验卡没有 png 素材，用原有 carbon 图标定位；文字另外断言仍在。
  const exp = grid.indexOf('i-carbon-star-filled')
  const bean = grid.indexOf('alt="金豆"')
  const coupon = grid.indexOf('alt="点券"')
  assert.ok(gold > 0 && exp > 0 && bean > 0 && coupon > 0, '四个图标/文字都要在 grid 内')
  assert.match(grid, /经验/, '经验卡文字保持不变')
  assert.ok(bean > exp, '金豆在金币和经验之后')
  assert.ok(coupon > bean, '金豆在前、点券在后')
  assert.match(grid, /grid grid-cols-2/, '沿用原来的两列网格，尺寸不单独定制')
  assert.match(grid, /aria-label="今日金币、经验、金豆与点券增量"/, '无障碍标签同步补齐')
})

test('金豆/点券卡片与金币/经验卡片完全同款：容器、图标尺寸、文字、数字、悬停、暗色', () => {
  const cardClass = 'flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30'
  assert.equal((grid.match(new RegExp(escapeRe(cardClass), 'g')) || []).length, 4, '四张卡片容器 class 必须一字不差')
  // 金币/金豆/点券都是项目内 png 素材，三者图标尺寸一字不差；经验沿用原有
  // carbon 图标（文字排版仍与其他三张一致），不为了「统一」去动已有卡片。
  const iconClass = 'h-5 w-5 object-contain 2xl:h-6 2xl:w-6'
  assert.equal((grid.match(new RegExp(escapeRe(iconClass), 'g')) || []).length, 3, '三张货币卡片图标尺寸一致')
  for (const icon of ['gold.png', 'gold-bean.png', 'coupon.png'])
    assert.match(grid, new RegExp(`<img src="/game-config/resource-icons/${escapeRe(icon)}"[^>]*${escapeRe(iconClass)}`), `${icon} 的 img 结构与金币同款`)
  assert.match(grid, /i-carbon-star-filled text-base text-sky-500 2xl:text-lg/, '经验卡原有图标保持不变')
  assert.equal((grid.match(/text-xs text-gray-500 2xl:text-sm/g) || []).length, 4, '标签文字排版一致')
  assert.equal((grid.match(/text-sm font-bold 2xl:text-base/g) || []).length, 4, '数字排版一致')
  assert.equal((grid.match(/aria-hidden="true"/g) || []).length, 4, '图标都不重复读屏')
})

test('图标用项目内已有的资源素材，不新增外部文件', () => {
  for (const [name, icon] of [['金币', 'gold.png'], ['金豆', 'gold-bean.png'], ['点券', 'coupon.png']]) {
    const path = new URL(`../public/game-config/resource-icons/${icon}`, import.meta.url)
    assert.ok(existsSync(path), `${name} 图标必须来自项目内已有素材 ${icon}`)
    assert.match(grid, new RegExp(`src="/game-config/resource-icons/${escapeRe(icon)}"`), `${name} 要引用该素材`)
  }
  assert.match(grid, /alt="金豆"/)
  assert.match(grid, /alt="点券"/)
  assert.doesNotMatch(grid, /https?:\/\//, '不得引入外链图标')
})

test('四项今日数值都直接读后端同源字段，金豆不再由前端自己算', () => {
  assert.match(dashboard, /const todayGoldBeanGained = computed\(\(\) => Number\(status\.value\?\.sessionGoldBeanGained\) \|\| 0\)/)
  assert.match(dashboard, /const todayCouponGained = computed\(\(\) => Number\(status\.value\?\.sessionCouponGained\) \|\| 0\)/)
  assert.match(dashboard, /const todayGoldGained = computed\(\(\) => Number\(status\.value\?\.sessionGoldGained\) \|\| 0\)/, '金币原逻辑保持不动')
  assert.match(dashboard, /const todayExpGained = computed\(\(\) => Math\.max\(0, Number\(status\.value\?\.sessionExpGained\) \|\| 0\)\)/, '经验仍保持非负')
  assert.doesNotMatch(dashboard, /todayGoldBeanGained = computed\(\(\) => Math\.max\(0,/, '金豆不能夹断负数')
  assert.doesNotMatch(dashboard, /todayCouponGained = computed\(\(\) => Math\.max\(0,/, '点券不能夹断负数')
  assert.match(grid, /\{\{ todayGoldBeanGained \}\}/)
  assert.match(grid, /\{\{ todayCouponGained \}\}/)
  // 浏览器本地基线整套移除：不再依赖 localStorage / 本地日期 / watch。
  for (const legacy of ['TODAY_BEAN_BASELINE_KEY', 'resolveGoldBeanDelta', 'beanBaselineMemory', 'localDayKey', 'dashboard:todayGoldBeanBaseline'])
    assert.doesNotMatch(dashboard, new RegExp(escapeRe(legacy)), `前端不应再有 ${legacy}`)
  assert.doesNotMatch(dashboard, /localStorage/, '不再写浏览器本地基线，跨浏览器/清缓存不再影响数值')
  assert.doesNotMatch(dashboard, /status\.value\?\.status\?\.goldBean/, '不再从余额自己推算净值')
})

test('后端下发 sessionGoldBeanGained，且与金币/点券同为当日净值、可为负', () => {
  assert.match(stats, /sessionGoldBeanGained: session\.goldBeanGained/, 'getStats 要把金豆增量下发到 status')
  assert.match(stats, /session\.goldBeanGained = initialState\.goldBean === null\s*\? 0\s*: currentGoldBean - \(initialState\.goldBean as number\)/, '净值 = 当前余额 - 当日基线；基线未就绪时显示 0 而不是虚高')
  assert.match(stats, /session\.goldGained = currentGold - \(initialState\.gold as number\)/, '金币口径保持不变')
  assert.match(stats, /session\.couponGained = currentCoupon - \(initialState\.coupon as number\)/, '点券口径保持不变')
  assert.match(stats, /goldBean: currentGoldBean/, '余额仍照常下发')
  assert.doesNotMatch(stats, /Math\.max\(0,\s*session\.goldBeanGained/, '后端不做归零夹断')
  assert.match(runtimeState, /sessionGoldBeanGained: 0/, '未登录默认 status 也要带这个字段')
})

test('金豆基线在后端由跨天/登录/持久化三条链路统一接管', () => {
  assert.match(stats, /initialState\.goldBean = null/, '跨天时基线留空')
  assert.match(stats, /if \(initialState\.goldBean === null && currentGoldBean > 0\)\s*initialState\.goldBean = currentGoldBean/, '只用有效余额初始化基线，未同步的占位 0 不能钉成今日起点')
  assert.match(stats, /session\.goldBeanGained = 0/, '登录与跨天重置都要清增量')
  assert.match(stats, /const restoredGoldBean = restoreInitialBaseline\(savedInitial\.goldBean\)/, '同日重启恢复基线')
  assert.match(stats, /function restoreInitialBaseline\(raw: any\): number \| null/, 'null/undefined 恢复判定集中在一处')
  assert.match(stats, /if \(raw === null \|\| raw === undefined\) return null;/, '旧存档缺字段时不能把 null 当 0 恢复')
  assert.match(stats, /function initStats\(gold: number, exp: number, coupon: number = 0, goldBean: number \| null = null\)/, '登录基线可显式传入金豆余额或 null')
  assert.match(stats, /initialState\.goldBean = b !== null && Number\.isFinite\(b\) && b >= 0 \? b : null/, '传 null 时基线保持空，传 0（背包确认过的合法余额）才算基线')
  assert.match(worker, /goldBeanReady \? Number\(latest\.goldBean \|\| 0\) : null/, '背包同步失败时不能把占位 0 当基线传给统计模块')
  assert.match(worker, /goldBeanReady = true/, '背包同步成功才允许用登录余额作基线')
})

test('金豆/点券为负数时用与金币同一个负向色 token', () => {
  assert.match(grid, /:class="\{ 'is-down': todayGoldBeanGained < 0 \}"/)
  assert.match(grid, /:class="\{ 'is-down': todayCouponGained < 0 \}"/)
  assert.match(grid, /:class="\{ 'is-down': todayGoldGained < 0 \}"/, '金币原判定保持不动')
  assert.match(dashboard, /\.ov-today-value\.is-down \{\s*color: var\(--ui-danger\);\s*\}/)
  assert.match(dashboard, /\.ov-today-gold\.is-down \{\s*color: var\(--ui-danger\);\s*\}/, '金币负向色基准')
  assert.equal((grid.match(/ov-today-value/g) || []).length, 2, '金豆与点券共用一个负向色类')
})

test('空态判定把金豆/点券算进去，有净值时不会误显示「等待第一份收获」', () => {
  assert.match(dashboard, /!operationGroups\.active\.length && todayGoldGained === 0 && todayExpGained === 0 && todayGoldBeanGained === 0 && todayCouponGained === 0/)
})

test('只改今日统计模块：资产卡不引用今日数值，后端不新增资产卡字段', () => {
  const assetStart = dashboard.indexOf('<!-- 资产 -->')
  const assetEnd = dashboard.indexOf('<!-- 库存', assetStart)
  const assetCards = dashboard.slice(assetStart, assetEnd)
  assert.equal((assetCards.match(/class="ov-tile__delta"/g) || []).length, 2)
  assert.doesNotMatch(assetCards, /todayGoldBeanGained|todayCouponGained/, '资产卡不引用今日统计的数值')
  assert.doesNotMatch(stats, /runGoldBeanGained/, '不新增资产卡「本次运行」金豆增量')
})
