import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import test from 'node:test'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const layout = read('../src/layouts/DefaultLayout.vue')
const store = read('../src/stores/panel-notifications.ts')

test('右上角不再显示红点通知：顶栏不挂消息铃铛', () => {
  assert.doesNotMatch(layout, /PanelNotificationBell/)
  assert.doesNotMatch(layout, /panel-bell-badge/, '未读红点角标已去除')
  assert.doesNotMatch(layout, /i-carbon-notification/, '铃铛图标已去除')
  assert.equal(existsSync(new URL('../src/components/PanelNotificationBell.vue', import.meta.url)), false, '铃铛组件已移除')
})

test('局内消息数据层保留（接口仍可用，只是不再有顶栏入口）', () => {
  assert.match(store, /api\.get\('\/api\/panel-notifications'/)
  assert.match(store, /headers: \{ 'x-account-id': id \}/)
  assert.match(store, /skipErrorToast: true/, '通知读失败不弹全局错误')
  assert.match(store, /panel_notifications_read_at/)
  assert.match(store, /unreadCount = computed\(/, '未读数由本地已读时间算出')
  assert.match(store, /readAt\(id\)/)
  assert.match(store, /localStorage\.setItem\(`\$\{READ_KEY\}:\$\{id\}`/, '已读时间按账号隔离')
  assert.match(store, /accountId\.value !== id\)[^\S\n]*\n[^\S\n]*return/, '切账号后的旧响应不覆盖')
  assert.match(store, /catch \{[\s\S]*?读失败时保留上一批/, '读失败时降级')
})

test('切账号瞬间先清空上一个账号的消息，不会被在途请求挡住', () => {
  assert.match(store, /if \(accountId\.value !== id\) \{[\s\S]*?items\.value = \[\]/, '切号先清列表，否则显示的是别人的通知')
  // 在途去重必须按账号，全局 loading 会因为上一个账号未完成而直接放弃新账号的请求
  assert.match(store, /const inflight = new Set<string>\(\)/, '按账号记录在途请求')
  assert.match(store, /if \(inflight\.has\(id\)\)[^\S\n]*\n[^\S\n]*return/)
  assert.doesNotMatch(store, /if \(loading\.value\)[^\S\n]*\n[^\S\n]*return/, '全局 loading 会让切号后的首次拉取被吞掉')
})
