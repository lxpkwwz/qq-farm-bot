import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')

test('好友土地请求序号按好友维度隔离，不再用全局共享计数器', () => {
  const src = read('../src/stores/friend.ts')
  assert.doesNotMatch(src, /friendLandRequestSequence/, '全局计数器已移除')
  assert.match(src, /friendLandRequestSeq = new Map/, '改为按 key 的序号表')
})

test('账号列表请求失败不清空已有账号与当前选中', () => {
  const src = read('../src/stores/account.ts')
  const idx = src.indexOf('获取账号失败')
  assert.ok(idx > 0, '找到 fetchAccounts 的失败分支')
  const seg = src.slice(idx, idx + 700)
  assert.doesNotMatch(seg, /accounts\.value = \[\]/, '网络失败不应清空账号列表')
  assert.doesNotMatch(seg, /currentAccountId\.value = ''/, '网络失败不应清空当前账号')
})

test('活动倒计时对未知 state 有兜底文案', () => {
  const src = read('../src/utils/dashboard-activity-check.ts')
  assert.match(src, /labels\[check\.state\] \?\? '等待调度'/)
  assert.match(src, /Record<string, string>/)
})
