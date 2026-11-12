import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const store = readFileSync(new URL('../src/stores/account.ts', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../src/components/Sidebar.vue', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/components/settings/AccountManagementPanel.vue', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../../core/src/controllers/admin/account-routes.ts', import.meta.url), 'utf8')
const service = readFileSync(new URL('../../core/src/services/code-watch.ts', import.meta.url), 'utf8')

test('账号 store 暴露 Code 健康快照与自动补 Code 接口', () => {
  assert.match(store, /export interface CodeHealthItem/)
  assert.match(store, /const codeHealth = ref<CodeHealthItem\[\]>\(\[\]\)/)
  assert.match(store, /async function fetchCodeHealth\(\)/)
  assert.match(store, /api\.get\('\/api\/accounts\/code-health'\)/)
  assert.match(store, /async function autoFixCode\(id: string\)/)
  assert.match(store, /api\.post\(`\/api\/accounts\/\$\{id\}\/auto-fix-code`\)/)
  assert.match(store, /await fetchAccounts\(\)[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*await fetchCodeHealth\(\)/)
})

test('侧栏 10 秒轮询同时刷新账号与 Code 健康快照，实现全局自动监听', () => {
  assert.match(sidebar, /accountStore\.fetchCodeHealth\(\)/)
  const pollBlock = sidebar.slice(sidebar.indexOf('useIntervalFn(() => {'))
  assert.match(pollBlock, /accountStore\.fetchAccounts\(\)/)
  assert.match(pollBlock, /accountStore\.fetchCodeHealth\(\)/)
  assert.match(pollBlock, /\}\s*, 10000\)/)
  assert.match(sidebar, /onMounted\(\(\) => \{[\s\S]{0,200}?accountStore\.fetchCodeHealth\(\)/)
})

test('账号管理页 watch 新出现的 Code 异常，自动补码并给出手动补码入口', () => {
  assert.match(panel, /const codeAlerts = computed/)
  assert.match(panel, /watch\(codeAlerts, \(list\) => \{/)
  assert.match(panel.slice(panel.indexOf('watch(codeAlerts,')), /\}, \{ immediate: true \}\)/)
  assert.match(panel, /AUTO_FIX_COOLDOWN_MS = 10 \* 60_000/, '同一状态 10 分钟内不重复打续期接口')
  assert.match(panel, /void tryAutoFix\(item\)/, '可自动修复的异常直接自动补 Code')
  assert.match(panel, /item\.needsManual[\s\S]*?notify\(/, '不可自动修复时提示手动补 Code')
  assert.match(panel, /autoFixDisabled\.value\.has\(item\.accountId\)/, '失败后停止自动重试')
  assert.match(panel, /function openRefillCodeModal\(item: CodeHealthItem\)/)
  assert.match(panel, /code: '',/, '补 Code 弹窗清空旧 Code')
  assert.match(panel, /role="region"[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*aria-label="Code 自动监听"/)
  assert.match(panel, /立即补 Code/)
  assert.match(panel, /已开启 · 每 10 秒检查/)
})

test('后端注册 Code 健康快照与自动补 Code 路由，并接上局内通知', () => {
  assert.match(routes, /app\.get\('\/api\/accounts\/code-health'/)
  assert.match(routes, /app\.post\('\/api\/accounts\/:id\/auto-fix-code'/)
  assert.match(routes, /require\('\.\.\/\.\.\/services\/code-watch'\)/)
  assert.match(routes, /require\('\.\.\/\.\.\/services\/panel-notification'\)/)
  assert.match(routes, /ctx\.provider\.getAccountLogs \? ctx\.provider\.getAccountLogs\(200\)/)
})

test('Code 判定服务覆盖微信到期与 QQ 掉线两类信号', () => {
  assert.match(service, /WARNING_WINDOW_MS = 10 \* 60_000/)
  assert.match(service, /OFFLINE_LOG_ACTIONS = new Set\(\[[\s\S]*?'disconnect_stop'[\s\S]*?'auto_code_refresh_failed'[\s\S]*?\]\)/)
  assert.match(service, /ensureFreshGameCode\(id\)/, '微信走免扫码换码')
  assert.match(service, /tryRefreshQqGameCode\(id\)/, 'QQ 走尽力重签')
  assert.match(service, /result\.needsManual = true/, '失败统一标记需手动补码')
})
