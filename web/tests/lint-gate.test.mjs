import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(resolve(ROOT, file), 'utf8')

// ============ 防复发门禁：同一类缺陷不再靠「下一轮扫描」发现 ============

test('eslint 必须启用类型感知的「未处理 Promise」规则族', () => {
  const config = read('eslint.config.js')
  assert.match(config, /tsconfigPath:\s*'\.\/tsconfig\.app\.json'/, '没有 tsconfigPath 时类型感知规则不会生效')
  assert.match(config, /'ts\/no-floating-promises':\s*'error'/)
  assert.match(config, /'ts\/no-misused-promises':\s*\['error',\s*\{[^}]*checksConditionals:\s*false/)
  assert.match(config, /'ts\/await-thenable':\s*'error'/)
})

test('lint 脚本必须把警告也当失败', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.scripts.lint, /--max-warnings=0/)
})

test('周期任务必须自己兜住 async tick，不能指望 useIntervalFn 接管拒绝', () => {
  const source = read('src/composables/useFarmAutoRefresh.ts')
  assert.match(source, /const safeTick = /)
  assert.match(source, /Promise\.resolve\(result\)\.catch\(/)
  assert.match(source, /useIntervalFn\(safeTick,/)
})

test('有意不等待的加载调用必须显式 void，避免读者误以为是漏写 await', () => {
  const source = read('src/composables/settings/usePlantingStrategy.ts')
  assert.doesNotMatch(source, /^\s{4}ensurePlantConfigLoaded\(\)$/m, 'ensurePlantConfigLoaded 需要显式 void 并说明原因')
  assert.doesNotMatch(source, /^\s{6}fetchBagSeeds\(id\)$/m, 'fetchBagSeeds 需要显式 void')
  assert.doesNotMatch(source, /^\s{6}fetchSeedOptions\(id\)$/m, 'fetchSeedOptions 需要显式 void')
})
