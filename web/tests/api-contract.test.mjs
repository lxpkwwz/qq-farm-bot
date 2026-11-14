import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 前后端接口契约闸门。
 *
 * 为什么单独一组：真实服务扫描只从「后端源码」取路由，mock 单测也不碰前端，
 * 于是「前端调了一个后端不存在的路径 / 用错 HTTP 方法」这类 404 从来没被验证过。
 * 这里把两侧源码直接对账：前端 web/src 里每个 /api/ 字面量与每个带方法的调用，
 * 都必须在后端 core/src/controllers/admin 里找到形状相同的注册路由。
 *
 * 能证明：路径段数、静态段、动态段（:id / ${...}）与 HTTP 方法对齐。
 * 不能证明：请求体字段名与类型一致（body 常由变量拼出，静态提不出来）、
 *           运行时返回结构、账号在线时的真实协议行为。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(ROOT, '..')
const ADMIN_DIR = join(REPO, 'core/src/controllers/admin')
const WEB_SRC = join(ROOT, 'src')

function collectSources(dir, suffixes, root = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // 递归时基准目录必须保持是最初的 root，否则子目录里的文件会丢掉层级
      out.push(...collectSources(full, suffixes, root))
      continue
    }
    if (suffixes.some(suffix => entry.name.endsWith(suffix)))
      out.push({ rel: relative(root, full).replace(/\\/g, '/'), source: readFileSync(full, 'utf8') })
  }
  return out
}

const BACKEND_SOURCES = collectSources(ADMIN_DIR, ['.ts'])
const FRONTEND_SOURCES = collectSources(WEB_SRC, ['.ts', '.vue'])
const FRONTEND_TEXT = FRONTEND_SOURCES.map(file => file.source).join('\n')

// ---------- 后端：两种注册写法都要收 ----------
const APP_ROUTE = /\b(?:app|router)\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g
const MOUNT_ROUTE = /mount(Get|Post|Put|Delete)\(\s*'([^']+)'/g

function collectBackends() {
  const routes = []
  for (const { rel, source } of BACKEND_SOURCES) {
    for (const match of source.matchAll(APP_ROUTE)) {
      const route = match[2]
      // '*' 是 SPA 深链接回落，'/' 是首页，都不是 API 路由
      if (route === '*' || route === '/')
        continue
      routes.push({ method: match[1].toUpperCase(), route, file: rel })
    }
    for (const match of source.matchAll(MOUNT_ROUTE))
      routes.push({ method: match[1].toUpperCase(), route: match[2], file: rel })
  }
  return routes
}

// ---------- 前端：/api/ 字面量 + 带方法的调用 ----------
const LITERAL = /(['"`])(\/api\/[^'"`\s]*)\1/g
const CALL = /\b(?:api|axios)\.(get|post|put|patch|delete)\(\s*(['"`])(\/api\/[^'"`\s]*)\2/g

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function collectFrontends() {
  const literals = new Map()
  const calls = []
  for (const { rel, source } of FRONTEND_SOURCES) {
    for (const match of source.matchAll(LITERAL)) {
      const route = match[2]
      if (!literals.has(route))
        literals.set(route, [])
      literals.get(route).push(`${rel}:${lineOf(source, match.index)}`)
    }
    for (const match of source.matchAll(CALL)) {
      calls.push({
        method: match[1].toUpperCase(),
        route: match[3],
        where: `${rel}:${lineOf(source, match.index)}`,
      })
    }
  }
  return { literals, calls }
}

function segments(route) {
  return route.split('?')[0].split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':') || seg.includes('${') || seg === '*')
      return ':'
    return seg
  })
}

function matches(front, back) {
  const a = segments(front)
  const b = segments(back)
  return a.length === b.length && a.every((seg, i) => seg === ':' || b[i] === ':' || seg === b[i])
}

/** 动态拼接路径去掉 ${...} 后的静态前缀，用来防止「整段路径根本不存在」被通配蒙混过去。 */
function staticPrefix(route) {
  const head = route.slice(0, route.indexOf('${'))
  return head.split('?')[0].split('/').filter(Boolean)
}

function hasPrefix(route, prefix) {
  const segs = segments(route)
  return segs.length >= prefix.length
    && prefix.every((seg, i) => seg === ':' || segs[i] === ':' || seg === segs[i])
}

/** 源码里 URL 由变量拼出、正则抓不到完整字面量的两处活动页调用，显式登记并双向核对。 */
const VARIABLE_ROUTE_MARKERS = [
  '/api/activities/share-reward/${',
  '/api/activities/autumn/${',
]
const VARIABLE_ROUTE_SHAPES = [
  '/api/activities/share-reward/:activityId',
  '/api/activities/share-reward/:activityId/:action',
  '/api/activities/autumn/:key',
  '/api/activities/autumn/:key/:action',
]

const BACKENDS = collectBackends()
const { literals, calls } = collectFrontends()

test('闸门自身有效：两侧源码都被真实扫描到', () => {
  assert.ok(BACKENDS.length >= 150, `后端只提到 ${BACKENDS.length} 条路由，提取可能失效`)
  assert.ok(literals.size >= 100, `前端只提到 ${literals.size} 个 /api/ 字面量，提取可能失效`)
  assert.ok(calls.length >= 120, `带方法调用只提到 ${calls.length} 个，提取可能失效`)
  // 三种注册方式都要能被识别，避免正则只认一种却「空集全绿」
  for (const route of ['/api/accounts', '/api/auth/validate', '/api/activities/share-reward/:activityId'])
    assert.ok(BACKENDS.some(b => b.route === route), `后端路由 ${route} 必须能被提取到`)
  assert.ok(
    BACKENDS.some(b => b.file.includes('activity-center')),
    'mountGet 注册的路由必须能被提取到（活动中心用的是第二种写法）',
  )
})

test('前端每个 /api/ 路径字面量都能匹配到后端注册路由', () => {
  const missing = []
  for (const [route, where] of literals) {
    if (!BACKENDS.some(b => matches(route, b.route)))
      missing.push(`${route} ← ${where.join(', ')}`)
  }
  assert.deepEqual(missing, [], `这些前端路径后端没有对应路由（会 404）：\n${missing.join('\n')}`)
})

test('动态拼接路径的静态前缀也落在真实后端路由上', () => {
  const dynamic = [...literals.keys()].filter(route => route.includes('${'))
  assert.ok(dynamic.length >= 15, `动态拼接路径只提到 ${dynamic.length} 个，提取可能失效`)
  for (const route of dynamic) {
    const prefix = staticPrefix(route)
    assert.ok(
      BACKENDS.some(b => hasPrefix(b.route, prefix)),
      `${route} 的静态前缀 ${prefix.join('/')} 在后端找不到`,
    )
  }
})

test('带方法的调用：HTTP 方法与路径形状同时匹配后端', () => {
  const missing = calls
    .filter(call => !BACKENDS.some(b => b.method === call.method && matches(call.route, b.route)))
    .map(call => `${call.method} ${call.route} ← ${call.where}`)
  assert.deepEqual(missing, [], `方法或路径对不上后端：\n${missing.join('\n')}`)
})

test('变量拼接的 URL 形状已登记、源码仍在、且后端存在', () => {
  for (const marker of VARIABLE_ROUTE_MARKERS)
    assert.ok(FRONTEND_TEXT.includes(marker), `源码里已找不到 ${marker}，白名单该更新了`)
  for (const shape of VARIABLE_ROUTE_SHAPES)
    assert.ok(BACKENDS.some(b => matches(shape, b.route)), `后端缺少 ${shape} 对应路由`)
})
