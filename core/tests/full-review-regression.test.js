const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.resolve(ROOT, file), 'utf8');
const plugin = () => read('../napcat/plugins/qq-miniapp-openauth/index.mjs');

// ============ 第四轮：进程致命 / 账号卡死 ============

test('登录回包的 async callback 必须经统一包装，否则 Node 20 未处理拒绝会带走 worker', () => {
    const network = read('src/utils/network.ts');
    assert.match(network, /function invokePendingCallback\(/);
    assert.match(network, /Promise\.resolve\(result\)\.catch\(/);
    assert.doesNotMatch(network, /pending\.callback\(/, '还有直接调用 pending.callback 的地方');
    assert.equal((network.match(/invokePendingCallback\(pending\.callback/g) || []).length, 5, '五个调用点都要走包装');
});

test('请求超时只接受有限正数，Infinity / 负数不能在入队瞬间就判超时', () => {
    const network = read('src/utils/network.ts');
    assert.match(network, /Number\.isFinite\(rawTimeoutMs\) && rawTimeoutMs > 0/);
    assert.doesNotMatch(network, /Math\.max\(1, Number\(options\.timeoutMs\) \|\| 20000\)/);
});

test('畸形登录回包要走断线收尾，不能停在 phase=login 干等 20 秒', () => {
    const network = read('src/utils/network.ts');
    assert.match(network, /登录回包解码失败/);
    assert.match(network, /finalizeConnection\(context, \{ source: 'login_failed', reason: '登录响应缺少账号信息' \}\);/);
});

test('场景登录只有超时类错误降级，协议级回包不完整仍按登录失败收尾', () => {
    const network = read('src/utils/network.ts');
    assert.match(network, /场景登录请求超时（不影响在线状态）/);
    assert.match(network, /只有「请求超时」是可重试的瞬时故障/);
    assert.match(network, /农场场景登录回包不完整/);
    assert.match(network, /source: 'login_init_failed'/, '外层致命 catch 不能被动过');
});

test('worker 的 api_call 必须挂 catch，回包序列化失败要降级而不是挂死面板', () => {
    const worker = read('src/core/worker.ts');
    assert.match(worker, /void handleApiCall\(msg\)\.catch\(/);
    assert.match(worker, /function sendApiResponse\(/);
    assert.match(worker, /sendApiResponse\(id, result, error\);/);
    assert.match(worker, /WorkerApiResponseError/);
});

test('startBot 初始化阶段失败必须回滚 isRunning，否则之后所有 start 被静默吞掉', () => {
    const worker = read('src/core/worker.ts');
    assert.match(worker, /catch \(startError: any\)/);
    assert.match(worker, /isRunning = false;\n {16}shutdownStarted = false;/);
});

// ============ 第四轮：协议层资源释放 ============

test('mmtls 连接超时定时器与 socket 必须成对释放', () => {
    const proto = read('src/services/wx-login/native-protocol.ts');
    assert.match(proto, /clearTimeout\(connectTimer\)/);
    assert.match(proto, /clearTimeout\(waitTimer\)/);
    assert.match(proto, /if \(c\) c\.close\(\)/, '长链握手失败要关掉已建立的连接');
    assert.match(proto, /\} finally \{\n {8}c\.close\(\);/, '短链 c.send 失败也要关连接');
});

// ============ 第四轮：路由与持久化 ============

test('管理员口令必须先写盘后改内存，损坏文件要留档而不是静默重建默认口令', () => {
    const store = read('src/models/admin-store.ts');
    assert.match(store, /writeJsonFileAtomic\(ADMIN_FILE/);
    assert.match(store, /function persistAdmin\(/);
    assert.match(store, /\.corrupt-/);
    assert.doesNotMatch(store, /current\.password = security\.hashPassword\(newPassword\)/);
    assert.doesNotMatch(store, /fs\.writeFileSync\(ADMIN_FILE/);
});

test('微信长效凭据写盘失败不能回报 ok:true，且任务句柄仍要释放', () => {
    const routes = read('src/controllers/admin/wx-login-routes.ts');
    assert.match(routes, /credentialSaveError/);
    assert.match(routes, /res\.status\(500\)\.json\(\{ ok: false, error: `凭据保存失败/);
    assert.doesNotMatch(routes, /账号不存在或暂不可写时忽略/);
    const destroyAt = routes.indexOf('            destroy(task);');
    const guardAt = routes.indexOf('            if (credentialSaveError)');
    assert.ok(destroyAt >= 0 && guardAt > destroyAt, 'destroy(task) 必须在提前 return 之前');
});

test('删除好友被游戏侧拒绝时不能写本地黑名单并回报成功', () => {
    const routes = read('src/controllers/admin/friend-routes.ts');
    assert.match(routes, /data && data\.ok === false/);
    assert.match(routes, /Number\.isInteger\(gid\) \|\| gid <= 0/);
    assert.match(routes, /handleApiError\(res, e\)/);
});

test('种子黑名单与化肥数量不再放行负数 / Infinity', () => {
    const routes = read('src/controllers/admin/farm-routes.ts');
    assert.equal((routes.match(/Number\.isInteger\(seedId\) \|\| seedId <= 0/g) || []).length, 2);
    // v3.25.3 起统一走 utils/input-guards：原来的 Number.isFinite 手写判断换成带区间的 readInt，
    // 两种写法都拦 Infinity，这里锁的是「化肥数量必须过区间校验」而不是某一种写法。
    assert.match(routes, /readInt\(req\.body\?\.count \?\? 0, \{ field: 'count', min: 0, max: 10000 \}\)/);
    assert.match(routes, /organicThresholdHours: readInt\(/);
});

test('farm 路由不再把请求体裸传给 worker', () => {
    const routes = read('src/controllers/admin/farm-routes.ts');
    // 这些点在 v3.25.3 之前是 `ctx.provider.xxx(id, req.body?.landId)` 这种裸传，
    // 服务端拿不到校验点，`1e400` 会变成 Infinity 一路编进 int64。
    for (const field of ['landId', 'itemId', 'landIds']) {
        assert.match(routes, new RegExp(`read(Id|IdList)\\(req\\.body\\?\\.${field}`), `请求体字段 ${field} 必须先过边界校验`);
    }
    assert.doesNotMatch(routes, /ctx\.provider\.fertilizeOwnLand\(id, req\.body\?\.landId/);
    assert.doesNotMatch(routes, /ctx\.provider\.removePlant\(id, req\.body\?\.landId/);
    assert.doesNotMatch(routes, /Math\.max\(0, Math\.trunc\(Number\(req\.body/);
});

test('NapCat 插件配置损坏时拒绝服务，不退回「无 token = 免鉴权」', () => {
    const p = plugin();
    assert.match(p, /__configError/);
    assert.match(p, /res\.status\(503\)/);
    assert.equal((p.match(/if \(!guard\(req, res\)\) return;/g) || []).length, 3, '三个 NoAuth 路由都要过守卫');
    assert.doesNotMatch(p, /catch \{ return \{\}; \}/);
});

// ============ 前四轮修复的回归（本轮明确要求「包括之前已经检查过的」） ============

test('v3.23.3 / .5 / .6 / .7 的关键修复仍在，没有被后续改动冲掉', () => {
    assert.match(read('src/models/store/accounts.ts'), /wxCredentialNeedsRescan/);
    assert.match(read('src/services/log-query.ts'), /function parseLogLimit\(/);
    assert.match(read('src/controllers/admin/account-routes.ts'), /mergeLogLists\(/);
    assert.match(read('src/services/stats.ts'), /const dateKey: string = currentDateKey \|\| getTodayKey\(\)/);
    assert.match(read('src/services/account-runtime-state.ts'), /onlyFrom/);
    assert.match(read('src/services/wx-keepalive.ts'), /function cancelPendingRelogin/);
    assert.match(read('src/core/worker.ts'), /workerScheduler\.has\('activity_automation_interval'\)/);
    assert.match(read('src/services/preflight-stats.ts'), /\.corrupt-/);
    assert.match(read('src/services/account-visibility.ts'), /wxCanRecover/);
    assert.match(plugin(), /'getOpenAuth'/);
});
