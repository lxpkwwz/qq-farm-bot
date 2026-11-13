import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')

test('日志轮询与实时推送都有账号 / 序号守卫', () => {
  const status = read('stores/status.ts')
  assert.match(status, /const logsGuard = createRequestGuard\(\)/)
  assert.match(status, /const ticket = logsGuard\.next\(\)/, 'fetchLogs 取票必须在 await 之前')
  assert.match(status, /if \(logsGuard\.isStale\(ticket\)\)/, 'fetchLogs 回包要校验票据')
  assert.equal((status.match(/isRealtimeAccount\(body\)/g) || []).length, 2, 'log:new 与 logs:snapshot 都要守卫')
  assert.match(status, /logsGuard\.invalidate\(\)/, '切号要作废旧响应')
  assert.match(status, /logs\.value = \[\]/, '切号要清空上一个账号的日志')
  assert.match(status, /statusGuard/, '前几轮的 status 守卫仍在')
})

test('好友 / 缓存 / 访客记录 / 黑名单四个 fetch 全部加序号守卫', () => {
  const friend = read('stores/friend.ts')
  assert.match(friend, /const friendListGuard = createRequestGuard\(\)/)
  assert.equal((friend.match(/const ticket = friendListGuard\.next\(\)/g) || []).length, 4)
  assert.ok((friend.match(/friendListGuard\.isStale\(ticket\)/g) || []).length >= 4)
  assert.match(friend, /friendListGuard\.invalidate\(\)/, 'resetFriendLandState 要作废在途请求')
  assert.match(friend, /friends\.value = \[\]/)
  assert.match(friend, /blacklist\.value = \[\]/)
  assert.match(friend, /interactRecords\.value = \[\]/)
})

test('农场操作后的补刷不会把旧账号的土地写进新账号', () => {
  const farm = read('stores/farm.ts')
  assert.match(farm, /function accountWasSwitched\(/)
  assert.equal((farm.match(/if \(!accountWasSwitched\(accountId\)\)/g) || []).length, 2, 'operate 与 removePlant 都要判')
  assert.match(farm, /landGuard/, '前几轮 fetchLands 的序号守卫仍在')
  assert.match(farm, /if \(landGuard\.isStale\(ticket\)\)/)
})

test('活动操作取得独占版本，reset 清空在途 load', () => {
  const ac = read('stores/activity-center.ts')
  assert.match(ac, /pendingLoads\.clear\(\)/)
  assert.match(ac, /const version = \+\+requestVersion\.value/)
  assert.match(ac, /function isCurrent\(/, '账号归属校验仍在')
})

test('节令日历空数据不会算出 Infinity 边界，加载失败能自愈', () => {
  const cal = read('views/SolarCalendar.vue')
  assert.match(cal, /Number\.POSITIVE_INFINITY/)
  assert.match(cal, /Array\.isArray\(data\.value\?\.events\)/, 'events 缺失不能让 computed 抛错')
  assert.match(cal, /window\.setTimeout\(/)
  assert.match(cal, /revision === sequence && !data\.value/, '重试要带序号，切号 / 卸载后作废')
})

test('好友分页在数量下降与切号时都回到有效页', () => {
  const friends = read('views/Friends.vue')
  assert.match(friends, /watch\(totalPages, \(pages\) =>/)
  assert.match(friends, /currentPage\.value = Math\.min\(currentPage\.value, pages\)/)
  assert.ok((friends.match(/currentPage\.value = 1/g) || []).length >= 2)
})

test('前几轮前端修复仍在，没有被本轮改动冲掉', () => {
  const runtime = read('utils/account-runtime.ts')
  assert.match(runtime, /case 'relogin_waiting'/)
  assert.match(runtime, /case 'running'/)
  assert.match(read('utils/credential-status.ts'), /wxCanRecover/)
  assert.match(read('stores/panel-notifications.ts'), /const inflight = new Set<string>\(\)/)
})
