import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(new URL('../src/utils/credential-status.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
})
const module = { exports: {} }

new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
const { getCredentialStatus, getWxPreflightSummary } = module.exports

const HOUR = 3600_000
const MINUTE = 60_000
const GREEN = 'text-green-600 dark:text-green-400'
const AMBER = 'text-amber-600 dark:text-amber-400'
const RED = 'text-red-600 dark:text-red-400'
const GRAY = 'text-gray-500'
const NOW = 1_800_000_000_000

function account(patch = {}) {
  return { platform: 'wx', expires_at: NOW + 2 * HOUR, expires_in: 7200, ...patch }
}

test('有效期充足的凭证显示绿色，且不带待续期文案', () => {
  const status = getCredentialStatus(account(), NOW)
  assert.equal(status.color, GREEN)
  assert.match(status.text, /^访问凭证：剩余 2 小时 0 分 00 秒$/)
  assert.ok(!status.text.includes('待续期'))
})

test('剩余 10 分钟内才显示待续期（琥珀色）', () => {
  assert.equal(getCredentialStatus(account({ expires_at: NOW + 8 * MINUTE }), NOW).color, AMBER)
  assert.match(getCredentialStatus(account({ expires_at: NOW + 8 * MINUTE }), NOW).text, /待续期/)
  assert.equal(getCredentialStatus(account({ expires_at: NOW + 11 * MINUTE }), NOW).color, GREEN)
})

test('已过期的凭证显示红色', () => {
  const status = getCredentialStatus(account({ expires_at: NOW - 1000 }), NOW)
  assert.equal(status.color, RED)
  assert.equal(status.text, '访问凭证：已过期')
})

test('没有任何到期信息时显示灰色「未知」；刷新时间在未来则报时间异常', () => {
  assert.deepEqual(getCredentialStatus(account({ expires_at: 0, wxCredentialRefreshedAt: 0 }), NOW), {
    text: '访问凭证：到期时间未知',
    color: GRAY,
  })
  assert.equal(getCredentialStatus(account({ expires_at: 0, wxCredentialRefreshedAt: NOW + HOUR }), NOW).color, RED)
})

test('旧账号没有 expires_at 时用最近成功时间 + TTL 兜底', () => {
  const status = getCredentialStatus(account({ expires_at: 0, wxCredentialRefreshedAt: NOW - 10 * MINUTE }), NOW)
  assert.equal(status.color, GREEN)
  assert.match(status.text, /1 小时 50 分/)
})

test('秒级 expires_at 不会被误判成已过期', () => {
  const status = getCredentialStatus(account({ expires_at: Math.floor((NOW + HOUR) / 1000) }), NOW)
  assert.equal(status.color, GREEN)
})

test('重新扫码后：历史失败标记 + 旧到期时间不再让凭证变成待续期颜色', () => {
  // 后端仍残留旧错误、旧 expires_at 已临近过期，但最近一次成功时间就是刚才
  const status = getCredentialStatus(account({
    expires_at: NOW + 20 * MINUTE,
    wxCredentialRefreshedAt: NOW - 1000,
    wxCredentialLastAttemptAt: NOW - 1000,
    wxCredentialRefreshError: '微信授权续期失败：code=40001',
  }), NOW)
  assert.equal(status.color, GREEN, '重扫成功后的凭证必须是绿色')
  assert.ok(!status.text.includes('待续期'))
  assert.ok(!status.text.includes('上次续期失败'))
})

test('最近一次续期确实失败（晚于最近成功）才标琥珀色并说明原因', () => {
  const status = getCredentialStatus(account({
    wxCredentialRefreshedAt: NOW - 2 * HOUR,
    wxCredentialLastAttemptAt: NOW - 1000,
    wxCredentialRefreshError: 'invalid refresh token',
  }), NOW)
  assert.equal(status.color, AMBER)
  assert.match(status.text, /上次续期失败/)
})

test('自动续期账本按「能否免扫码恢复」显示，而不是「能否滚 token」', () => {
  const stats = { date: '2026-11-13', lastSuccessAt: NOW - 5 * MINUTE, successesToday: 2, failuresToday: 0 }

  // 只有 loginBuffer 的账号：滚不了 token，但掉线后会被自动换码重登并记账 ——
  // 这种情况下账本必须显示，否则用户会以为后端没在工作。
  const onlyBuffer = account({ wxPreflightSupported: false, wxCanRecover: true, wxPreflightStats: stats })
  const summary = getWxPreflightSummary(onlyBuffer, NOW)
  assert.ok(summary, '可免扫码恢复的账号必须能看到账本')
  assert.match(summary.text, /今日成功 2 次/)

  // 旧版服务没有 wxCanRecover 字段时回落到原判定，不能整段消失。
  const legacy = account({ wxPreflightSupported: true, wxPreflightStats: stats })
  assert.ok(getWxPreflightSummary(legacy, NOW))

  // 真的没有可恢复凭据：不显示。
  const none = account({ wxPreflightSupported: false, wxCanRecover: false, wxPreflightStats: stats })
  assert.equal(getWxPreflightSummary(none, NOW), null)
})
