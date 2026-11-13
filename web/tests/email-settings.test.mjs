import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import test from 'node:test'
import { requestGuardModule } from './helpers/ts-modules.mjs'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia } = require('pinia')
const ts = require('typescript')

test('邮箱时刻可读取和保存，午夜与旧配置默认值正确，账号切换不串值', async (t) => {
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const accounts = { a: { emailClaimHour: 0 }, b: { emailClaimHour: 17 }, legacy: {} }
  const posts = []
  let release
  const api = {
    get: async (_url, options) => ({ data: { ok: true, data: accounts[options.headers['x-account-id']] } }),
    post: async (url, body, options) => {
      posts.push({ url, body, accountId: options.headers['x-account-id'] })
      if (release === null)
        await new Promise(resolve => release = resolve)
      return { data: { ok: true, data: body } }
    },
  }
  const source = readFileSync(new URL('../src/stores/setting.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  // store 里也用同一份 hour-of-day 做兜底归一，mock 成真实实现而不是空模块。
  const hourSource = readFileSync(new URL('../src/utils/hour-of-day.ts', import.meta.url), 'utf8')
  const hourModule = { exports: {} }

  new Function('exports', ts.transpileModule(hourSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(hourModule.exports)
  const module = { exports: {} }

  new Function('require', 'module', 'exports', outputText)((id) => {
    if (id === '@/api')
      return { __esModule: true, default: api, getApiErrorMessage: value => value.error }
    if (id === '@/utils/request-guard')
      return requestGuardModule
    // 本仓库的设置 store 还依赖通知模板归一化；这里给恒等实现，测试不校验该字段。
    if (id === '@/utils/notification-template')
      return { normalizeNotificationTemplates: value => value ?? {} }
    if (id === '@/utils/hour-of-day')
      return hourModule.exports
    // 其余路径别名与本用例无关，返回空模块即可，避免 Node 解析不了 `@/`。
    if (id.startsWith('@/'))
      return {}
    return require(id)
  }, module, module.exports)
  const store = module.exports.useSettingStore(pinia)

  await store.fetchSettings('a')
  assert.equal(store.settings.emailClaimHour, 0)
  assert.equal((await store.saveSettings('a', { emailClaimHour: 23 })).ok, true)
  assert.equal(store.settings.emailClaimHour, 23)
  assert.deepEqual(posts[0], { url: '/api/settings/save', body: { emailClaimHour: 23 }, accountId: 'a' })

  release = null
  const pending = store.saveSettings('a', { emailClaimHour: 1 })
  await store.fetchSettings('b')
  assert.equal(store.settings.emailClaimHour, 17)
  release()
  await pending
  assert.equal(store.settings.emailClaimHour, 17, '旧账号保存响应不覆盖新账号')
  await store.fetchSettings('legacy')
  assert.equal(store.settings.emailClaimHour, 10)
})

test('非法邮箱时刻被就地剔除，同一批的其它设置照常保存', async (t) => {
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const posts = []
  const api = {
    get: async () => ({ data: { ok: true, data: {} } }),
    post: async (url, body, options) => {
      posts.push({ url, body, accountId: options.headers['x-account-id'] })
      return { data: { ok: true, data: body } }
    },
  }
  const source = readFileSync(new URL('../src/stores/setting.ts', import.meta.url), 'utf8')
  const hourSource = readFileSync(new URL('../src/utils/hour-of-day.ts', import.meta.url), 'utf8')
  const hourModule = { exports: {} }

  new Function('exports', ts.transpileModule(hourSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(hourModule.exports)
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const module = { exports: {} }

  new Function('require', 'module', 'exports', outputText)((id) => {
    if (id === '@/api')
      return { __esModule: true, default: api, getApiErrorMessage: value => value.error }
    if (id === '@/utils/request-guard')
      return requestGuardModule
    if (id === '@/utils/notification-template')
      return { normalizeNotificationTemplates: value => value ?? {} }
    if (id === '@/utils/hour-of-day')
      return hourModule.exports
    if (id.startsWith('@/'))
      return {}
    return require(id)
  }, module, module.exports)
  const store = module.exports.useSettingStore(pinia)

  // 空串是把输入框清空后的草稿；后端 assertEmailClaimHour 会抛 INVALID_CONFIG，
  // 整份快照一起被拒，所以这里必须只丢掉这个字段。
  const partial = await store.saveSettings('a', { emailClaimHour: '', intervals: { farm: 300 } })
  assert.equal(partial.ok, true)
  assert.deepEqual(posts[0].body, { intervals: { farm: 300 } })

  // 字符串数字仍按数字发出去，别把 '10' 这种合法草稿也丢掉。
  await store.saveSettings('a', { emailClaimHour: '10' })
  assert.equal(posts[1].body.emailClaimHour, 10)

  // 只带一个非法字段时不去打接口，直接给出能看懂的错误。
  const rejected = await store.saveSettings('a', { emailClaimHour: 25 })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /0–23/)
  assert.equal(posts.length, 2, '非法值不应发出请求')
})

test('设置页在发请求前拦住非法邮箱时刻，不把整批设置一起送死', () => {
  const view = readFileSync(new URL('../src/views/Settings.vue', import.meta.url), 'utf8')
  assert.match(view, /import \{ parseHourOfDay \} from '@\/utils\/hour-of-day'/)

  const guardAt = view.indexOf('const emailClaimHour = parseHourOfDay(')
  const requestAt = view.indexOf('settingStore.saveSettings(accountId, payload)')
  assert.ok(guardAt > 0, '保存流程里没找到邮箱时刻校验')
  assert.ok(requestAt > guardAt, '校验必须排在发请求之前')

  // 拦住时要给用户能看懂的原因，并且把合法草稿归一成数字再发。
  assert.match(view, /showAlert\('「自动邮箱领取」时间需填写 0–23 的整数（时）[^']*', 'danger'\)/)
  assert.match(view, /payload\.emailClaimHour = emailClaimHour/)
})
