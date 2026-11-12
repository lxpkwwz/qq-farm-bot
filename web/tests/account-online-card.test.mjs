import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const card = read('../src/components/settings/AccountKeepAliveCard.vue')
const baseCard = read('../src/components/settings/AccountSettingsCard.vue')
const config = read('../../core/src/config/config.ts')
const keepAlive = read('../../core/src/services/wx-keepalive.ts')

test('定时重登开关与配置字段全部下线', () => {
  assert.doesNotMatch(card, /定时重登|intervalMinutes|draft\.enabled|config\.value\.enabled/)
  assert.doesNotMatch(config, /enabled: src\.enabled|intervalMinutes: Number\.isFinite/)
  assert.doesNotMatch(config, /autoCodeRefresh: \{ enabled:/)
  assert.match(config, /autoCodeRefresh: \{ offlineEnabled: true, offlineDelaySeconds: 60 \}/, '掉线重登默认开启（只在掉线后才动作）')
  assert.match(config, /旧 store\.json 里的 enabled \/ intervalMinutes 会被直接丢弃/)
})

test('后端不再有按间隔重启账号的定时重登链路', () => {
  assert.doesNotMatch(keepAlive, /定时重登|intervalMinutes|'timer'|"timer"|lastRefreshAt|if \(!config\.enabled\)/)
  assert.match(keepAlive, /void runCodePreflight\(Date\.now\(\)\)\.catch/, '到期前预防续期保持常开')
  assert.match(keepAlive, /if \(!config\.offlineEnabled\) return;/, '掉线重登依然受独立开关控制')
})

test('卡片改名并保留设计风格一致的标题与说明', () => {
  assert.match(card, />\s*账号登录与重连\s*</)
  assert.match(card, /title="账号登录与重连"/)
  assert.match(card, /description="所有账号共享 · 启动登录、掉线恢复与到期续期"/)
  assert.match(card, /服务启动自动登录、掉线自动重登与微信授权到期前续期/)
  assert.doesNotMatch(card, /账号保活/)
})

test('服务启动自动登录已并入卡片内部，不再是卡片下方独立条', () => {
  assert.match(card, /<template #extra>/)
  const extra = card.slice(card.indexOf('<template #extra>'))
  assert.match(extra, /服务启动自动登录/)
  assert.match(extra, /@update:model-value="saveAutoStart"/)
  assert.match(extra, /掉线自动重登/)
  assert.match(extra, /@update:model-value="toggleOffline"/)
  // 原来卡片下方的独立灰底条已删除
  assert.doesNotMatch(card, /border border-gray-200 rounded-lg bg-gray-50\/70 p-3/)
  assert.match(card, /hide-switch/, '卡片内已有具名开关，隐藏右上角含义不清的总开关')
  assert.match(baseCard, /<slot name="extra" \/>/)
  assert.match(baseCard, /v-if="!hideSwitch"/)
})

test('状态标签覆盖三项能力，且到期前续期标注为常开', () => {
  assert.match(card, /服务启动自动登录 已开启/)
  assert.match(card, /掉线后 \$\{config\.value\.offlineDelaySeconds\} 秒重登/)
  assert.match(card, /微信授权到期前自动续期 常开/)
})

test('PC 端具名开关统一落在说明文字下方，手机端保持原并排布局', () => {
  const extra = card.slice(card.indexOf('<template #extra>'), card.indexOf('</AccountSettingsCard>'))
  const rows = extra.match(/<div[^>]*class="[^"]*border-t[^"]*"[^>]*>/g) || []
  assert.equal(rows.length, 2, '卡片内仍是两行具名设置，不新增/删减少项')
  for (const row of rows) {
    assert.match(row, /flex flex-wrap items-center justify-between/, '手机端维持原来的并排基线')
    assert.match(row, /md:flex-col md:items-start/, 'PC 端改为纵向，开关落到文字下方')
    assert.doesNotMatch(row, /md:flex-row/, 'PC 端不得把开关拉回右侧')
  }
  const offlineRow = extra.slice(extra.indexOf('掉线自动重登'))
  const textEnd = offlineRow.indexOf('</p>')
  const offlineSwitch = offlineRow.indexOf('@update:model-value="toggleOffline"')
  assert.ok(textEnd > -1 && offlineSwitch > textEnd, '掉线自动重登开关排在标题与说明文字之后')
})
