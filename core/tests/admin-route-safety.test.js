/**
 * 管理接口的崩溃防护。
 *
 * 背景（实测出来的，不是推测）：`/api/friend-blacklist` 曾经在 provider 返回非数组时
 * 抛 `TypeError: friendsList is not iterable`，而那段代码在 try 之外，Express 4 不捕获
 * async 拒绝 —— 拒绝变成 unhandledRejection，Node 直接结束进程，**所有账号一起掉线**。
 * 一个 HTTP 请求就能打死整个服务。
 *
 * 两层防护，这组测试把它们钉住：
 *   1. 路由注册阶段统一包一层（guardAsyncRoutes），把同步抛错与 Promise 拒绝都转成
 *      next(err)，再由 JSON 错误中间件返回 500 —— 请求失败，但进程活着；
 *   2. 进程入口装 unhandledRejection 兜底，漏网的拒绝只记日志不退出。
 *
 * 行为验证靠手工冒烟脚本（tests/manual/api-smoke.js），这里只锁结构不被改回去。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('路由注册统一包一层异步守卫，并注册 JSON 错误出口', () => {
    const index = read('src/controllers/admin/index.ts');

    assert.match(index, /function guardAsyncRoutes\(app: any\)/, '必须有统一的异步守卫');
    assert.match(index, /guardAsyncRoutes\(app\);/, '守卫必须在创建 app 之后立即生效');
    // 必须显式包成 `(error) => next(error)`：直接把 next 传给 catch 会被 lint 判成
    // 「拒绝处理器不是函数」，而且语义上也不清晰。
    assert.match(index, /Promise\.resolve\(result\)\.catch\(\(error: any\) => \{/, 'Promise 拒绝要转成 next(err)');
    assert.match(index, /next\(error\);/, '拒绝要交给 next，而不是吞掉');
    assert.match(index, /res\.status\(500\)\.json\(\{ ok: false, error: String\(err\?\.message/, '必须有 JSON 500 出口');

    // 守卫必须先于所有路由挂载，否则后注册的路由漏保护。
    const guardAt = index.indexOf('guardAsyncRoutes(app);');
    const firstMountAt = index.indexOf('mountAuthRoutes(app, ctx);');
    assert.ok(guardAt > 0 && firstMountAt > guardAt, '守卫必须早于第一个路由挂载');

    // 错误中间件必须在 SPA 兜底之后（Express 按注册顺序匹配）。
    const spaAt = index.indexOf("app.get('*'");
    const errorAt = index.indexOf('admin route crashed');
    assert.ok(spaAt > 0 && errorAt > spaAt, '错误中间件要在所有普通中间件之后');
});

test('客户端错误不能一律回 500', () => {
    const index = read('src/controllers/admin/index.ts');

    // express.json() 解析失败时抛的是 SyntaxError 且带 status=400。
    // 如果中间件无视 err.status 直接回 500，用户随手拼错一个 JSON 就会看到
    // 「服务端内部错误」——实测扫全部路由时正是这条把 400 变成了 500。
    assert.match(index, /Number\(err\?\.status \?\? err\?\.statusCode\)/, '要读错误自带的 status');
    assert.match(index, /rawStatus >= 400 && rawStatus < 500/, '4xx 要按客户端错误处理');
    assert.match(index, /res\.status\(clientStatus\)\.json/, '客户端错误要回原始状态码');
    assert.match(index, /请求体不是合法 JSON/, '解析失败要有明确提示');
    // 真正的服务端异常仍然必须 500，并且记 error 级日志
    assert.match(index, /adminLogger\.error\('admin route crashed'/, '服务端异常仍按 500 记 error');
});

test('好友黑名单不再对 provider 返回值直接 for...of', () => {
    const routes = read('src/controllers/admin/friend-routes.ts');

    assert.match(routes, /Array\.isArray\(raw\) \? raw : \[\]/, 'provider 返回值必须显式判数组');
    assert.doesNotMatch(
        routes,
        /await ctx\.provider\.getFriends\([^)]*\) \|\| \[\]/,
        '`await x || []` 只兜 null/undefined，对象会让后面的 for...of 抛错并打死进程',
    );
    // 两个使用点都要走辅助函数
    assert.equal((routes.match(/await readFriendsForDisplay\(ctx, id, res\)/g) || []).length, 2);
});

test('进程入口装了未处理拒绝兜底，且未捕获异常会记日志后退出', () => {
    const client = read('client.ts');

    assert.match(client, /process\.on\('unhandledRejection'/, '漏网的拒绝不能让进程退出');
    assert.match(client, /process\.on\('uncaughtException'/, '同步异常至少要留下可查的堆栈');
    assert.match(client, /process\.exit\(1\);/, '未知状态不应继续运行');

    // unhandledRejection 分支里不能有 exit —— 那是这套兜底存在的意义
    const block = client.slice(
        client.indexOf("process.on('unhandledRejection'"),
        client.indexOf("process.on('uncaughtException'"),
    );
    assert.doesNotMatch(block, /process\.exit/, '未处理拒绝只记日志，不退出进程');
});

test('冒烟脚本不写真实数据目录', () => {
    const preload = read('tests/manual/smoke-preload.js');
    assert.match(preload, /getDataDir: \(\) => tmpDir/, '数据目录必须重定向到临时目录');
    assert.match(preload, /getDataFile: name => path\.join\(tmpDir, name\)/);
    assert.match(preload, /getShareFilePath: \(\) => path\.join\(tmpDir, 'share\.txt'\)/);
});
