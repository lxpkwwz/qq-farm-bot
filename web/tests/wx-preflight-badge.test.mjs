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
const { getWxPreflightBadge } = module.exports

const SUPPORTED = 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400'
const UNSUPPORTED = 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
const UNKNOWN = 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'

function wx(patch = {}) {
  return { platform: 'wx', ...patch }
}

test('具备 wxid + refreshtoken 的微信账号显示绿色「支持」', () => {
  assert.deepEqual(getWxPreflightBadge(wx({ wxPreflightSupported: true })), {
    text: '支持',
    hint: '关掉网页也会自动续期',
    badgeClass: SUPPORTED,
  })
})

test('扫码时没有回传 refreshtoken 的账号显示琥珀色「不支持」并提示重扫', () => {
  const badge = getWxPreflightBadge(wx({ wxPreflightSupported: false }))
  assert.equal(badge.text, '不支持')
  assert.equal(badge.badgeClass, UNSUPPORTED)
  assert.match(badge.hint, /重新扫码/)
})

test('字段缺失（旧版后端 / 尚未更新服务）显示「未知」，不误报不支持', () => {
  const badge = getWxPreflightBadge(wx())
  assert.equal(badge.text, '未知')
  assert.equal(badge.badgeClass, UNKNOWN)
  assert.match(badge.hint, /更新服务/)
  assert.equal(getWxPreflightBadge(wx({ wxPreflightSupported: 'true' })).text, '未知')
})

test('QQ 账号与空对象不渲染这个微信专属标记', () => {
  assert.equal(getWxPreflightBadge({ platform: 'qq', wxPreflightSupported: true }), null)
  assert.equal(getWxPreflightBadge({}), null)
  assert.equal(getWxPreflightBadge(null), null)
})

test('账号卡片确实渲染了标记，且只在微信账号上出现', () => {
  const panel = read('../src/components/settings/AccountManagementPanel.vue')
  assert.match(panel, /import \{ getCredentialStatus, getWxPreflightBadge, getWxPreflightSummary \}/)
  assert.match(panel, /v-if="wxPreflightBadge\(acc\)"/)
  assert.match(panel, /免扫码续期：\{\{ wxPreflightBadge\(acc\)\?\.text \}\}/)
  assert.match(panel, /:class="wxPreflightBadge\(acc\)\?\.badgeClass"/)
  assert.match(panel, /v-if="acc\.platform === 'wx'" class="mt-3 break-words text-xs tabular-nums"/)
})

test('账号类型与后端投影接线：只暴露布尔标记，不下发凭证明文', () => {
  const store = read('../src/stores/account.ts')
  assert.match(store, /wxPreflightSupported\?: boolean/)
  assert.match(store, /接口不下发凭证明文/)

  const routes = read('../../core/src/controllers/admin/account-routes.ts')
  assert.match(routes, /toPublicAccountsData\(data, hasWxCredential, getPreflightStatsSnapshot\(\), canRecoverAccount\)/)

  const visibility = read('../../core/src/services/account-visibility.ts')
  assert.match(visibility, /\['refreshtoken', 'accesstoken', 'loginBuffer'\]/)
  assert.match(visibility, /safe\.wxPreflightSupported/)
  // 「能滚 token」和「掉线能免扫码恢复」是两个口径，必须都下发，
  // 否则只有 loginBuffer 的账号会明明在自动重登、却被判成「不支持」隐藏账本。
  assert.match(visibility, /safe\.wxCanRecover = !!canRecover\(account\)/)
  assert.match(visibility, /delete safe\[key\]/)
  assert.match(visibility, /只作用于 HTTP 响应副本/)
})

test('前端不读取任何长效凭证明文', () => {
  const panel = read('../src/components/settings/AccountManagementPanel.vue')
  assert.doesNotMatch(panel, /acc\.refreshtoken|acc\.loginBuffer|acc\.accesstoken/)
})
