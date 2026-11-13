import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(join(ROOT, 'src/utils/request-guard.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', outputText)(require, mod, mod.exports)
const { createRequestGuard, normalizeAccount } = mod.exports

// ============ 行为：取票 / 校验 / 作废 / 账号绑定 ============

test('只有最新一张票有效：先发的请求晚回来会被判过期', () => {
  const guard = createRequestGuard()
  const first = guard.next()
  const second = guard.next()
  assert.equal(guard.isStale(first), true, '旧票必须过期')
  assert.equal(guard.isStale(second), false)
})

test('invalidate 作废全部在途请求', () => {
  const guard = createRequestGuard()
  const ticket = guard.next()
  assert.equal(guard.isStale(ticket), false)
  guard.invalidate()
  assert.equal(guard.isStale(ticket), true, '切号 / 重置后旧响应不能再落地')
})

test('snapshot 不递增，用于「由外部事件作废」的场景', () => {
  const guard = createRequestGuard()
  const token = guard.snapshot()
  assert.equal(guard.isStale(token), false)
  assert.equal(guard.isStale(guard.snapshot()), false, '连续 snapshot 之间不该互相作废')
  guard.invalidate()
  assert.equal(guard.isStale(token), true)
})

test('绑定账号后，切号让旧票立即过期', () => {
  let account = '1001'
  const guard = createRequestGuard({ accountId: () => account })
  const ticket = guard.next()
  assert.equal(guard.isStale(ticket), false)
  account = '1002'
  assert.equal(guard.isStale(ticket), true, '账号已切走，旧回包不能写进新账号面板')
})

test('next(account) 用显式账号做快照，允许请求目标与当前账号不同', () => {
  const guard = createRequestGuard({ accountId: () => '1001' })
  const ticket = guard.next('1002')
  assert.equal(guard.isStale(ticket), true, '目标账号与当前账号不一致就该判过期')
  assert.equal(guard.isStale(guard.next('1001')), false)
})

test('未绑定账号时只看票号，账号变化不影响', () => {
  const guard = createRequestGuard()
  const ticket = guard.next()
  assert.equal(guard.isStale(ticket), false)
})

test('空票按过期处理，未取票就落地会走保守分支', () => {
  const guard = createRequestGuard()
  assert.equal(guard.isStale(undefined), true)
  assert.equal(guard.isStale(null), true)
})

test('账号归一化去空白，避免字符串 / 数字混用导致误判', () => {
  assert.equal(normalizeAccount(' 1001 '), '1001')
  assert.equal(normalizeAccount(1001), '1001')
  assert.equal(normalizeAccount(null), '')
})

// ============ 仓库闸门：不许再手写计数器 ============

function collectSources(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSources(full, acc)
    }
    else if (/\.(?:ts|vue)$/.test(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

const files = collectSources(join(ROOT, 'src'))

test('src 里不允许再出现手写序号计数器', () => {
  const offenders = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const hits = text.match(/let [A-Za-z_$]*(?:Seq|Sequence|Revision|generation|Version) = 0/g)
    if (hits)
      offenders.push(`${file.replace(ROOT, '')}: ${hits.join(', ')}`)
  }
  assert.deepEqual(offenders, [], '请改用 createRequestGuard()，不要各写一份计数器')
})

test('所有已知的并发拉取点都接了统一守卫', () => {
  const expected = [
    'stores/account.ts',
    'stores/farm.ts',
    'stores/friend.ts',
    'stores/pet.ts',
    'stores/pet-diary.ts',
    'stores/setting.ts',
    'stores/status.ts',
    'composables/settings/usePlantingStrategy.ts',
    'components/FarmPanel.vue',
    'components/IllustratedPanel.vue',
    'components/activity/MilkTeaActivityPanel.vue',
  ]
  for (const rel of expected) {
    const text = readFileSync(join(ROOT, 'src', rel), 'utf8')
    assert.match(text, /createRequestGuard\(/, `${rel} 还没接统一守卫`)
  }
})

test('守卫必须“先取票再 await”，不能等回包才取票', () => {
  // 只做弱校验：文件里出现 next() 就应当同时出现 isStale()，否则票取了不用
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!/\.next\(/.test(text))
      continue
    assert.match(text, /\.isStale\(/, `${file.replace(ROOT, '')} 取了票却没有校验`)
  }
})
