/**
 * 对「真实启动的服务」做全量路由扫描。
 *
 * 与 api-smoke.js 的区别：那个用假 provider 验证路由层形状；这个连的是真进程，
 * 验证「服务跑起来之后，全部路由逐个打过去会不会崩、会不会 500」。
 *
 * 用法（避免碰真实数据，用 live-preload 把数据目录指向副本）：
 *   cd core
 *   FARM_AUTO_START_ACCOUNTS=0 ADMIN_PORT=3010 \
 *     node -r ./tests/manual/live-preload.js client.js
 *   cd core && BASE=http://127.0.0.1:3010 node tests/manual/live-api-sweep.js
 *
 * 判定标准（缺一不可）：
 *   1. 进程还活着（脚本结束时 ping 仍能响应）；
 *   2. API 响应是合法 JSON；`/api/account-logs` 按前端约定直接返回数组，单独放行；
 *   3. 不出现 500 —— 500 意味着 handler 抛了未预期错误。
 *
 * 会跳过哪些（重要）：
 *   账号增删改（`/api/accounts*` 的非 GET）、系统设置、改密码、登录 —— 这些一调就
 *   改全局状态。实测教训：第一版把「跳过」只写进了计数、忘了 `continue`，
 *   结果 `DELETE /api/accounts/1` 把真实账号删了（已从快照恢复）。现在改成真跳过。
 *   其余带 `x-account-id` 的写接口照常调用：账号离线时它们会在校验或
 *   「账号未运行」处停下，覆盖到的是 handler 主体。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BASE = String(process.env.BASE || 'http://127.0.0.1:3007').replace(/\/$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ACCOUNT_ID = process.env.SWEEP_ACCOUNT_ID || '1';

/** 这些路由的响应不是 {ok,...} 包体，按各自约定单独校验。 */
const BARE_ARRAY_ROUTES = new Set(['/api/account-logs']);

/** 免鉴权白名单：与 auth-routes 里 `app.use('/api', ...)` 的例外保持一致。 */
const PUBLIC_ROUTES = [/^\/api\/login$/, /^\/api\/game-version$/, /^\/api\/wx-login\//];

/**
 * 从源码里扫路由，并判断该 handler 是否需要账号上下文。
 * 需要账号的写接口在账号离线时会自然停在「账号未运行」，可以安全调用；
 * 不需要账号的写接口通常直接改全局文件，必须跳过。
 */
function collectRoutes() {
    const root = path.resolve(__dirname, '../../src/controllers/admin');
    const routes = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts')) continue;
            const source = fs.readFileSync(full, 'utf8');
            // 两种注册方式都要收：直接 app.get/post，以及活动中心那套
            // `mountGet(path, providerMethod)`（内部就是 GET + withAccount）。
            const pattern = /app\.(get|post|put|delete)\(\s*'([^']+)'|mountGet\(\s*'([^']+)'/g;
            const hits = [];
            for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
                hits.push({
                    method: match[1] ? match[1].toUpperCase() : 'GET',
                    route: match[2] || match[3],
                    start: match.index,
                });
            }
            hits.forEach((hit, index) => {
                const end = index + 1 < hits.length ? hits[index + 1].start : source.length;
                const snippet = source.slice(hit.start, end);
                routes.push({
                    ...hit,
                    file: path.relative(root, full).replace(/\\/g, '/'),
                    needsAccount: /getAccId|resolveAccId|x-account-id|withAccount/.test(snippet),
                });
            });
        }
    };
    walk(root);
    return routes;
}

function request(method, route, { token, body, rawBody, accountId } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(BASE + route);
        const payload = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
        const headers = {};
        if (payload !== null) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (token) headers['x-admin-token'] = token;
        if (accountId) headers['x-account-id'] = accountId;
        const req = http.request(
            { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers, timeout: 8000 },
            (res) => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    let json = null;
                    try {
                        json = JSON.parse(raw);
                    } catch {
                        json = null;
                    }
                    resolve({ status: res.statusCode, body: json, raw: raw.slice(0, 200) });
                });
            },
        );
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

async function login() {
    const res = await request('POST', '/api/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
    if (res.status !== 200 || !res.body?.ok) {
        throw new Error(`登录失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data.token;
}

/** `:id` 这类占位符换成具体值；`*` 通配路由返回 null。 */
function materialize(route) {
    if (route.includes('*')) return null;
    return route
        .replace(':id', ACCOUNT_ID)
        .replace(':gid', '1')
        .replace(':taskId', 'no-such-task')
        .replace(':activityId', 'share_invite')
        .replace(':termId', '1')
        .replace(':key', 'autumn')
        .replace(':action', 'status');
}

/**
 * 是否必须跳过。
 * 账号增删改一律不碰；不需要账号上下文的写接口一律不碰。
 */
function mustSkip({ method, route, needsAccount }) {
    if (method === 'GET') return false;
    if (route.startsWith('/api/accounts')) return true;
    return !needsAccount;
}

async function main() {
    const token = await login();
    console.log(`登录成功，token=${token.slice(0, 8)}…`);

    const routes = collectRoutes();
    console.log(`从源码扫出 ${routes.length} 个路由\n`);

    const failures = [];
    const skipped = [];
    const stats = { requested: 0, ok: 0, businessError: 0, validation: 0 };

    for (const item of routes) {
        const { method, route, file } = item;
        const concrete = materialize(route);
        if (concrete === null || concrete === '/' || concrete === 'env') {
            skipped.push(`${method} ${route}（非 API）`);
            continue;
        }
        if (mustSkip(item)) {
            skipped.push(`${method} ${route}（写接口，跳过以免改状态）`);
            continue;
        }

        let res;
        try {
            res = await request(method, concrete, {
                token,
                body: method === 'GET' ? undefined : {},
                accountId: ACCOUNT_ID,
            });
        } catch (error) {
            failures.push({ route: `${method} ${route}`, file, why: `请求失败：${error.message}` });
            continue;
        }
        stats.requested += 1;

        if (res.status === 500) {
            failures.push({ route: `${method} ${route}`, file, why: `HTTP 500 ${res.raw}` });
            continue;
        }
        if (res.body === null) {
            failures.push({ route: `${method} ${route}`, file, why: `响应不是 JSON（HTTP ${res.status}）：${res.raw}` });
            continue;
        }
        if (BARE_ARRAY_ROUTES.has(route)) {
            if (!Array.isArray(res.body)) failures.push({ route: `${method} ${route}`, file, why: `约定返回数组，实际 ${res.raw}` });
            else stats.ok += 1;
            continue;
        }
        if (typeof res.body.ok !== 'boolean') {
            failures.push({ route: `${method} ${route}`, file, why: `响应缺少 ok 字段：${res.raw}` });
            continue;
        }
        if (res.status === 400) stats.validation += 1;
        else if (res.body.ok === false) stats.businessError += 1;
        else stats.ok += 1;
    }

    // ---- 认证闸门 ----
    console.log('=== 认证闸门（不带 token 必须 401）===');
    const authFailures = [];
    for (const { method, route } of routes) {
        const concrete = materialize(route);
        if (!concrete || concrete === '/' || concrete === 'env') continue;
        if (PUBLIC_ROUTES.some((pattern) => pattern.test(concrete))) continue;
        const res = await request(method, concrete, {});
        if (res.status !== 401) authFailures.push(`${method} ${route} -> HTTP ${res.status}`);
    }
    console.log(authFailures.length === 0 ? `  全部拦截 ✓（免鉴权：login / game-version / wx-login）` : `  ${authFailures.length} 条未拦截`);

    // ---- 静态资源 ----
    console.log('\n=== 静态资源 ===');
    const htmlRes = await new Promise((resolve, reject) => {
        http.get(`${BASE  }/`, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
                raw += c;
            });
            res.on('end', () => resolve(raw));
        }).on('error', reject);
    });
    const assets = [...htmlRes.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    const assetFailures = [];
    for (const asset of assets) {
        const res = await request('GET', asset);
        if (res.status !== 200) assetFailures.push(`${asset} -> HTTP ${res.status}`);
    }
    // SPA 深链接要回落到 index.html。
    // 注意不能用 request() 返回的 raw 判断——那个字段为日志截断到 200 字节，
    // index.html 的挂载点在后半段，会误判成「没回落」。
    const deepLink = await new Promise((resolve, reject) => {
        http.get(`${BASE  }/some/deep/link`, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
                raw += c;
            });
            res.on('end', () => resolve({ status: res.statusCode, raw }));
        }).on('error', reject);
    });
    const deepOk = deepLink.status === 200 && deepLink.raw.includes('<div id="app"');
    console.log(`  首页 ${assets.length} 个资源全部 200${assetFailures.length ? `（${assetFailures.length} 个失败）` : ' ✓'}`);
    console.log(`  SPA 深链接回落 -> HTTP ${deepLink.status}${deepOk ? ' ✓' : ' ✗'}`);
    if (!deepOk) assetFailures.push('SPA 深链接未回落 index.html');

    // ---- 异常输入 ----
    console.log('\n=== 异常输入（不能 5xx）===');
    const badInputFailures = [];
    const badCases = [
        ['login 字段类型全错', 'POST', '/api/login', '{"username":{"a":1},"password":[1,2]}'],
        ['login 超长字符串', 'POST', '/api/login', JSON.stringify({ username: 'a'.repeat(10000), password: 'b'.repeat(10000) })],
        ['login 空对象', 'POST', '/api/login', '{}'],
        ['非法 JSON', 'POST', '/api/login', '{"username":'],
        ['巨型数组', 'POST', '/api/login', JSON.stringify({ username: Array.from({length: 5000}).fill('a'), password: 'x' })],
    ];
    for (const [label, method, route, rawBody] of badCases) {
        let status;
        let raw = '';
        try {
            const res = await request(method, route, { rawBody });
            status = res.status;
            raw = res.raw;
        } catch (error) {
            status = 0;
            raw = error.message;
        }
        const ok = status > 0 && status < 500;
        console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${label} -> HTTP ${status}`);
        if (!ok) badInputFailures.push(`${label} -> HTTP ${status} ${raw.slice(0, 120)}`);
    }

    // ---- 并发 ----
    console.log('\n=== 并发（60 个请求）===');
    const concurrencyRoutes = ['/api/accounts', '/api/status', '/api/logs?limit=5', '/api/analytics', '/api/friend-blacklist'];
    const burst = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
            request('GET', concurrencyRoutes[i % concurrencyRoutes.length], { token, accountId: ACCOUNT_ID }).catch((error) => ({ status: 0, raw: error.message })),
        ),
    );
    const burstBad = burst.filter((r) => r.status === 0 || r.status >= 500);
    console.log(`  完成 ${burst.length} 个，异常 ${burstBad.length} 个`);
    if (burstBad.length) console.log(`  样例：${JSON.stringify(burstBad[0]).slice(0, 160)}`);

    // ---- 存活 ----
    console.log('\n=== 进程存活 ===');
    let alive = false;
    let uptime = null;
    try {
        const ping = await request('GET', '/api/ping', { token });
        alive = ping.status === 200 && ping.body?.ok === true;
        uptime = ping.body?.data?.uptime;
    } catch {
        alive = false;
    }
    console.log(`  /api/ping -> ${alive ? `200，uptime ${Math.round(uptime)}s ✓` : '无响应 ✗'}`);

    // ---- 汇总 ----
    console.log('\n================ 结果 ================');
    console.log(`路由 ${routes.length}，实际请求 ${stats.requested}，跳过 ${skipped.length}`);
    console.log(`  正常 ${stats.ok} | 业务拒绝 ok:false ${stats.businessError} | 参数校验 400 ${stats.validation}`);
    if (process.env.SWEEP_VERBOSE === '1') {
        console.log('\n--- 跳过清单 ---');
        for (const line of skipped) console.log(`  ${  line}`);
    }

    const issues = [
        ...failures,
        ...authFailures.map((x) => ({ route: x, file: '鉴权', why: '未返回 401' })),
        ...assetFailures.map((x) => ({ route: x, file: '静态', why: '资源失败' })),
        ...badInputFailures.map((x) => ({ route: x, file: '异常输入', why: '返回了 5xx 或连接失败' })),
    ];
    if (!alive) issues.push({ route: '/api/ping', file: '-', why: '服务已停止' });
    if (burstBad.length) issues.push({ route: '并发', file: '-', why: `${burstBad.length} 个请求异常` });

    if (issues.length === 0) {
        console.log('\n失败 0 条 ✓');
        process.exit(0);
    }
    console.log(`\n失败 ${issues.length} 条：`);
    for (const issue of issues) console.log(`  [${issue.file}] ${issue.route} — ${issue.why}`);
    process.exit(1);
}

main().catch((error) => {
    console.error('扫描异常终止：', error);
    process.exit(2);
});
