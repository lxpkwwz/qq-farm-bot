import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

/**
 * 把 src 下的 TS 模块转译后直接跑起来，供「用真实 store 跑行为」的测试复用。
 * 返回 CommonJS 的 exports，可直接塞进被测代码的 require 别名表。
 */
export function loadTsModule(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
  return module.exports
}

/** 复用的请求守卫模块：纯函数、无自带依赖，转译一次即可。 */
export const requestGuardModule = loadTsModule('../../src/utils/request-guard.ts')
