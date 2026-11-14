import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const source = read('../src/utils/credential-status.ts')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
})
const module = { exports: {} }

new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
const { getWxPreflightSummary } = module.exports

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 3600_000
const GREEN = 'text-green-600 dark:text-green-400'
const AMBER = 'text-amber-600 dark:text-amber-400'
const RED = 'text-red-600 dark:text-red-400'
const GRAY = 'text-gray-500'

function wx(stats, patch = {}) {
  return { platform: 'wx', wxPreflightSupported: true, wxPreflightStats: stats, ...patch }
}

function stats(patch = {}) {
  return {
    date: '2027-01-15',
    lastSuccessAt: NOW - 5 * MINUTE,
    lastFailureAt: 0,
    successesToday: 8,
    failuresToday: 0,
    ...patch,
  }
}

test('正常账号：时间、次数、颜色都跟随最近一次成功，只显示成功次数', () => {
  const result = getWxPreflightSummary(wx(stats()), NOW)
  assert.equal(result.text, '上次自动续期：5 分钟前 · 今日成功 8 次')
  assert.equal(result.color, GREEN)
  assert.doesNotMatch(result.text, /今日失败/)
  assert.equal(result.detail, undefined)
  assert.match(result.hint, /只统计后端自动发起/)
  assert.match(result.hint, /手动续期不计入/)
  assert.match(result.hint, /容器重启不丢失/)
  assert.match(result.hint, /最近一次成功/)
})

test('相对时间跟随最近一次那条记录，覆盖刚刚 / 分钟 / 小时 / 天', () => {
  const textAt = diff => getWxPreflightSummary(wx(stats({ lastSuccessAt: NOW - diff })), NOW).text
  assert.match(textAt(10_000), /刚刚/)
  assert.match(textAt(90 * MINUTE), /1 小时前/)
  assert.match(textAt(26 * HOUR), /1 天前/)
  assert.match(textAt(-HOUR), /刚刚/)

  // 失败比成功更晚：最近一次是失败 → 时间必须取失败时刻，而不是成功时刻。
  const failed = getWxPreflightSummary(wx(stats({
    lastSuccessAt: NOW - 3 * HOUR,
    lastFailureAt: NOW - 10 * MINUTE,
    failuresToday: 3,
    successesToday: 2,
  })), NOW)
  assert.match(failed.text, /10 分钟前/)
  assert.doesNotMatch(failed.text, /3 小时前/)
  assert.match(failed.text, /今日失败 3 次/)
  assert.doesNotMatch(failed.text, /今日成功/)
  assert.equal(failed.color, RED)
  assert.match(failed.hint, /最近一次失败/)
})

test('今日有失败但最近一次成功：绿色且只显示成功次数，不再显示失败次数', () => {
  const recovered = getWxPreflightSummary(wx(stats({ failuresToday: 2, lastFailureAt: NOW - 30 * MINUTE })), NOW)
  assert.equal(recovered.color, GREEN)
  assert.match(recovered.text, /今日成功 8 次/)
  assert.doesNotMatch(recovered.text, /今日失败/)
  assert.equal(recovered.text, '上次自动续期：5 分钟前 · 今日成功 8 次')
  assert.match(recovered.hint, /最近一次成功/)
})

test('最近一次就是失败：红色且只显示失败次数，时间与 hint 都指向失败', () => {
  const stillFailing = getWxPreflightSummary(wx(stats({
    failuresToday: 2,
    lastFailureAt: NOW - MINUTE,
    successesToday: 3,
  })), NOW)
  assert.equal(stillFailing.color, RED)
  assert.match(stillFailing.text, /1 分钟前/)
  assert.match(stillFailing.text, /今日失败 2 次/)
  assert.doesNotMatch(stillFailing.text, /今日成功/)
  assert.match(stillFailing.hint, /最近一次失败/)
})

test('颜色只以最近一次结果为准：超过 3 小时不再变琥珀，也不再因今日有失败染黄', () => {
  // 最近一次成功，哪怕 4 小时前，也是绿色。
  assert.equal(getWxPreflightSummary(wx(stats({ lastSuccessAt: NOW - 2 * HOUR })), NOW).color, GREEN)
  assert.equal(getWxPreflightSummary(wx(stats({ lastSuccessAt: NOW - 4 * HOUR })), NOW).color, GREEN)
  // 最近一次失败，无论多久都是红色，不再出现琥珀。
  const oldFailure = getWxPreflightSummary(wx(stats({
    lastSuccessAt: NOW - 5 * HOUR,
    lastFailureAt: NOW - 4 * HOUR,
    failuresToday: 1,
  })), NOW)
  assert.equal(oldFailure.color, RED)
  assert.notEqual(oldFailure.color, AMBER)
})

test('没有任何记录：灰色「暂无记录」，也只显示一个计数，不编造时间', () => {
  const empty = getWxPreflightSummary(wx(stats({ lastSuccessAt: 0, lastFailureAt: 0, successesToday: 0 })), NOW)
  assert.match(empty.text, /暂无记录/)
  assert.match(empty.text, /今日成功 0 次/)
  assert.doesNotMatch(empty.text, /今日失败/)
  assert.equal(empty.color, GRAY)
  assert.doesNotMatch(empty.hint, /最近一次/)

  // 从没成功过但最近一次是失败：红色 + 只显示失败次数 + 时间取失败时刻。
  const failed = getWxPreflightSummary(wx(stats({
    lastSuccessAt: 0,
    lastFailureAt: NOW,
    failuresToday: 1,
    successesToday: 0,
  })), NOW)
  assert.equal(failed.color, RED)
  assert.match(failed.text, /今日失败 1 次/)
  assert.doesNotMatch(failed.text, /今日成功/)
  assert.match(failed.text, /刚刚/)
})

test('任意账本形态下：两个计数永不同时出现，颜色只取红/绿/灰且与计数同源', () => {
  const shapes = [
    stats(),
    stats({ failuresToday: 2, lastFailureAt: NOW - 30 * MINUTE }),
    stats({ failuresToday: 2, lastFailureAt: NOW - MINUTE }),
    stats({ lastSuccessAt: 0, lastFailureAt: 0, successesToday: 0 }),
    stats({ lastSuccessAt: 0, lastFailureAt: NOW, failuresToday: 1, successesToday: 0 }),
    { lastSuccessAt: 'oops', successesToday: -9, failuresToday: Number.NaN },
  ]
  for (const shape of shapes) {
    const r = getWxPreflightSummary(wx(shape), NOW)
    assert.ok(r)
    const hasSuccess = r.text.includes('今日成功')
    const hasFailure = r.text.includes('今日失败')
    assert.ok(!(hasSuccess && hasFailure), `两个计数同时出现: ${r.text}`)
    assert.ok([GREEN, RED, GRAY].includes(r.color), `意外颜色: ${r.color}`)
    assert.equal(r.color === RED, hasFailure, `颜色与计数不一致: ${r.text} / ${r.color}`)
  }
})

test('源码闸门：整行以最近一次为准，不得回退成固定成功时间 / 琥珀色 / 并列两个计数', () => {
  assert.match(source, /lastFailureAt > 0 && lastFailureAt > lastSuccessAt/, '判定必须比较两条时间戳')
  assert.match(source, /const lastAt = lastFailed \? lastFailureAt : lastSuccessAt/, '时间必须跟随最近一次')
  assert.match(source, /formatAgo\(lastAt, now\)/, '相对时间必须取 lastAt')
  assert.match(source, /lastFailed \? COLOR_RED : COLOR_GREEN/, '颜色只允许红/绿（无记录时灰）')
  assert.doesNotMatch(source, /PREFLIGHT_STALE_MS/, '不得再用 3 小时 stale 改颜色')
  assert.doesNotMatch(source, /formatAgo\(lastSuccessAt, now\)/, '不得固定用成功时间')
})

test('旧版服务 / QQ / 不支持的账号 / 脏数据一律不渲染，不误报「没在续期」', () => {
  assert.equal(getWxPreflightSummary({ platform: 'wx', wxPreflightSupported: true }, NOW), null)
  assert.equal(getWxPreflightSummary({ platform: 'qq', wxPreflightSupported: true, wxPreflightStats: stats() }, NOW), null)
  assert.equal(getWxPreflightSummary(wx(stats(), { wxPreflightSupported: false }), NOW), null)
  assert.equal(getWxPreflightSummary(wx(stats(), { wxPreflightSupported: undefined }), NOW), null)
  assert.equal(getWxPreflightSummary(null, NOW), null)
  const dirty = getWxPreflightSummary(wx({ lastSuccessAt: 'oops', successesToday: -9, failuresToday: Number.NaN }), NOW)
  assert.match(dirty.text, /暂无记录 · 今日成功 0 次/)
  assert.doesNotMatch(dirty.text, /今日失败/)
})

test('秒级时间戳兼容（老数据可能由外部写成秒）', () => {
  const ok = getWxPreflightSummary(wx(stats({ lastSuccessAt: (NOW - 2 * HOUR) / 1000 })), NOW)
  assert.match(ok.text, /2 小时前/)
  const failed = getWxPreflightSummary(wx(stats({
    lastSuccessAt: (NOW - 3 * HOUR) / 1000,
    lastFailureAt: (NOW - HOUR) / 1000,
    failuresToday: 1,
  })), NOW)
  assert.match(failed.text, /1 小时前/)
  assert.equal(failed.color, RED)
})

test('账号卡片确实渲染这行，两端显示同一份文案', () => {
  const panel = read('../src/components/settings/AccountManagementPanel.vue')
  assert.match(panel, /import \{ getCredentialStatus, getWxPreflightBadge, getWxPreflightSummary \}/)
  assert.match(panel, /function wxPreflightSummary\(acc: any\)/)
  assert.match(panel, /getWxPreflightSummary\(acc, now\.value\.getTime\(\)\)/)
  assert.match(panel, /v-if="wxPreflightSummary\(acc\)"/)
  assert.match(panel, /wxPreflightSummary\(acc\)\?\.text/)
  assert.match(panel, /:title="wxPreflightSummary\(acc\)\?\.hint"/)
  assert.match(panel, /:class="wxPreflightSummary\(acc\)\?\.color"/)
  // 次数不能再被 hidden sm:inline 藏起来，否则手机端看不到续期到底有没有生效。
  assert.doesNotMatch(panel, /wxPreflightSummary\(acc\)\?\.detail/)
  assert.doesNotMatch(panel, /hidden[^"]*sm:inline[^"]*">· \{\{ wxPreflightSummary/)
})

test('前端类型与后端投影接线：账本只有时间戳与计数', () => {
  const store = read('../src/stores/account.ts')
  assert.match(store, /wxPreflightStats\?:/)
  assert.match(store, /lastSuccessAt\?: number/)
  assert.match(store, /failuresToday\?: number/)
  assert.match(store, /无任何凭证内容/)

  const visibility = read('../../core/src/services/account-visibility.ts')
  assert.match(visibility, /safe\.wxPreflightStats/)
  assert.match(visibility, /emptyPublicStats/)
  assert.match(visibility, /QQ 账号不走微信续期机制/)

  const ledger = read('../../core/src/services/preflight-stats.ts')
  assert.match(ledger, /不写任何 token \/ code/)
  assert.match(ledger, /writeJsonFileAtomic|writeJson/)
  assert.match(ledger, /UTC\+8 自然日/)
})

test('前端不读取任何长效凭证明文', () => {
  const panel = read('../src/components/settings/AccountManagementPanel.vue')
  const util = read('../src/utils/credential-status.ts')
  for (const file of [panel, util]) {
    assert.doesNotMatch(file, /acc\.refreshtoken|acc\.loginBuffer|acc\.accesstoken/)
  }
})
