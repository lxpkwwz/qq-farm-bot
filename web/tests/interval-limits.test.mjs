/**
 * 间隔上限的前后端一致性闸门。
 *
 * 背景：core 会把超过上限的巡查 / 好友间隔夹掉，而面板原来只写了 `min="1"` 没有上限，
 * 用户填 20000 秒（把毫秒当秒填）也能保存成功——服务端夹到 86400 后，界面上看到的
 * 就不是自己填的值，而且农场实际上会停摆几小时，全程没有任何提示。
 *
 * 这里锁三件事：
 *   1. 前端上限常量与 core 的 INTERVAL_MAX_SEC 相同；
 *   2. 两处间隔表单的输入框都带上下限，不再裸奔；
 *   3. 表单 setter 自己也夹一次（输入框的 max 拦不住粘贴 / 程序赋值）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

function matchOrFail(source, pattern, message) {
  const hit = source.match(pattern)
  assert.ok(hit, message)
  return hit
}

test('前端间隔上限必须等于 core 的 INTERVAL_MAX_SEC', () => {
  const webLimit = Number(
    matchOrFail(read('web/src/utils/interval-limits.ts'), /INTERVAL_MAX_SECONDS = (\d+)/, '前端缺少 INTERVAL_MAX_SECONDS')[1],
  )
  const coreLimit = Number(
    matchOrFail(
      read('core/src/models/store/shared-state.ts'),
      /const INTERVAL_MAX_SEC: number = (\d+);/,
      'core 缺少 INTERVAL_MAX_SEC',
    )[1],
  )
  assert.equal(webLimit, coreLimit, `前端上限 ${webLimit} 与 core 的 ${coreLimit} 不一致`)
  assert.equal(webLimit, 86400)
})

test('两处间隔表单的输入框都必须带上下限', () => {
  for (const file of [
    'web/src/components/settings/StrategySettingsPanel.vue',
    'web/src/components/settings/StrategyTimingPanel.vue',
  ]) {
    const source = read(file)
    const upperBounds = source.match(/:max="INTERVAL_MAX_SECONDS"/g) || []
    const lowerBounds = source.match(/:min="INTERVAL_INPUT_MIN"/g) || []
    assert.equal(upperBounds.length, 4, `${file} 有 4 个间隔输入框，应各带一个 max，实际 ${upperBounds.length}`)
    assert.equal(lowerBounds.length, 4, `${file} 有 4 个间隔输入框，应各带一个 min，实际 ${lowerBounds.length}`)
    assert.doesNotMatch(source, /type="number"\s+min="1"/, `${file} 仍有只写 min 的裸输入框`)
  }
})

test('表单 setter 也必须夹一次，不能只靠输入框的 max', () => {
  const source = read('web/src/components/settings/StrategyTimingPanel.vue')
  assert.match(
    source,
    /Math\.min\(INTERVAL_MAX_SECONDS,\s*Math\.max\(INTERVAL_INPUT_MIN,/,
    'intervalModel 应在写入前夹到 [1, INTERVAL_MAX_SECONDS]',
  )
})
