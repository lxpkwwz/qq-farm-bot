import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(new URL('../src/utils/account-runtime.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', outputText)(require, mod, mod.exports)
const { getAccountRuntimeStatus, isAccountActive } = mod.exports

const NOW = 1_800_000_000_000

test('六个状态各有自己的文案，未知状态回落到运行中/已停止', () => {
  const cases = {
    logging_in: /登录中/,
    relogin_waiting: /掉线重登/,
    running: /^运行中$/,
    offline: /^已掉线$/,
    stopping: /^停止中$/,
    stopped: /^已停止$/,
  }
  for (const [state, pattern] of Object.entries(cases)) {
    assert.match(getAccountRuntimeStatus({ runtimeState: state, running: true }, NOW).text, pattern, `${state} 文案不对`)
  }
  // 旧版服务不下发 runtimeState：保持原样，别让老账号显示空白
  assert.equal(getAccountRuntimeStatus({ running: true }, NOW).text, '运行中')
  assert.equal(getAccountRuntimeStatus({ running: false }, NOW).text, '已停止')
  assert.equal(getAccountRuntimeStatus({}, NOW).text, '已停止')
})

test('后端明确下发的 running 不会被 running=false 带偏', () => {
  // worker 刚被摘掉、状态还没收尾的一瞬，不能因为 running=false 就说「已停止」
  assert.equal(getAccountRuntimeStatus({ runtimeState: 'running', running: false }, NOW).text, '运行中')
})

test('等待重登按 reloginAt 倒计时，过期后显示即将登录', () => {
  const deadline = NOW + 45_000
  assert.equal(
    getAccountRuntimeStatus({ runtimeState: 'relogin_waiting', reloginAt: deadline }, NOW).text,
    '掉线重登，剩余 45 秒',
  )
  assert.equal(
    getAccountRuntimeStatus({ runtimeState: 'relogin_waiting', reloginAt: deadline }, deadline).text,
    '掉线重登，即将登录',
  )
  // reloginAt 缺失或非法时不能算出 NaN 秒
  assert.equal(getAccountRuntimeStatus({ runtimeState: 'relogin_waiting' }, NOW).text, '掉线重登，即将登录')
  assert.equal(getAccountRuntimeStatus({ runtimeState: 'relogin_waiting', reloginAt: null }, NOW).text, '掉线重登，即将登录')
})

test('忙态只有登录中与停止中，等待重登不算忙', () => {
  assert.equal(getAccountRuntimeStatus({ runtimeState: 'logging_in' }, NOW).busy, true)
  assert.equal(getAccountRuntimeStatus({ runtimeState: 'stopping' }, NOW).busy, true)
  // 等待重登期间界面要照常轮询刷新倒计时，不能一直挂转圈
  assert.equal(getAccountRuntimeStatus({ runtimeState: 'relogin_waiting', reloginAt: NOW + 10_000 }, NOW).busy, false)
  assert.equal(getAccountRuntimeStatus({ runtimeState: 'running' }, NOW).busy, false)
})

test('isAccountActive 把「登录中 / 等待重登」算作在册，停止按钮才是对的', () => {
  assert.equal(isAccountActive({ running: true }), true)
  assert.equal(isAccountActive({ runtimeState: 'logging_in', running: false }), true)
  // 关键：等待重登时账号没有子进程，但点「启动」会顶掉自动重登，必须显示「停止」
  assert.equal(isAccountActive({ runtimeState: 'relogin_waiting', running: false }), true)
  assert.equal(isAccountActive({ runtimeState: 'offline', running: false }), false)
  assert.equal(isAccountActive({ runtimeState: 'stopped', running: false }), false)
  assert.equal(isAccountActive({ runtimeState: 'stopping', running: true }), true)
})

test('面板据此置灰停止按钮、渲染状态点，且源码里真的有这个状态机', () => {
  const panel = readFileSync(new URL('../src/components/settings/AccountManagementPanel.vue', import.meta.url), 'utf8')
  assert.match(panel, /:disabled="acc\.runtimeState === 'stopping'"/, '停止中要禁用按钮，避免连点')
  assert.match(panel, /runtimeState\(acc\)\.busy/, '忙态用转圈')
  assert.match(panel, /runtimeState\(acc\)\.text/, '状态文案要渲染出来')
  assert.match(panel, /runtimeState\(acc\)\.color/, '状态圆点颜色要跟着状态走')
  // 一键清理「已停止账号」不能把正在等待重登的账号一起清掉
  assert.match(panel, /const stoppedAccounts = computed\(\(\) => accounts\.value\.filter\(\(acc: any\) => !isAccountActive\(acc\)\)\)/)
  // 状态文件本身不该依赖任何东西，这样才可以在测试里直接跑
  assert.doesNotMatch(source, /^import /m)
})
