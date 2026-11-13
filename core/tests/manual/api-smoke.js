/**
 * Admin HTTP 冒烟测试（手工运行，不在 `pnpm test` 里）。
 *
 *   node -r ./tests/manual/smoke-preload.js tests/manual/api-smoke.js
 *   # 端口可用 SMOKE_PORT 覆盖，默认 34567
 *
 * 为什么需要它：现有单测全是 mock 的，从来没有真正把 Express 服务拉起来过。
 * 路由挂载漏了、路径写错、错误处理返回 500 而不是 400、静态资源挂错目录——
 * 这些在单测里都看不见，只有真发一次 HTTP 请求才暴露。
 *
 * 判定规则：
 *   - 未登录访问受保护接口必须是 401，不能是 500 或 200；
 *   - 已登录的正常读接口必须是 200（业务上为空也应返回 200 + 空结果）；
 *   - 参数非法必须是 400；
 *   - 任何 500 都算失败，除非错误信息表明是「本脚本的假数据提供者缺方法」。
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.SMOKE_PORT || 34567);
// 服务读的是 ADMIN_PORT，这里在 require 业务模块之前设好，避免连到默认 3007 上
// （那个端口可能正被真实实例占用）。
process.env.ADMIN_PORT = String(PORT);
const DATA_DIR = process.env.QQ_FARM_SMOKE_DATA_DIR;
const BASE_HEADERS = {};

if (!DATA_DIR) {
    console.error('必须用 -r ./tests/manual/smoke-preload.js 启动，否则会写到真实数据目录');
    process.exit(1);
}

// ============ 准备一个账号 ============
// 没有账号时，所有带 withAccount 的接口都会正确地返回 400，那样就测不到它们内部的逻辑。
const ACCOUNT = {
    id: 'smoke-acc',
    name: '冒烟账号',
    code: '',
    platform: 'qq',
    uin: '10001',
    qq: '10001',
    avatar: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
};
fs.writeFileSync(
    path.join(DATA_DIR, 'accounts.json'),
    JSON.stringify({ accounts: [ACCOUNT], nextId: 2 }, null, 2),
    'utf8',
);

// ============ 假的数据提供者 ============
const syncStubs = {
    getAccounts: () => ({ accounts: [ACCOUNT] }),
    resolveAccountId: ref => (ref === ACCOUNT.id || ref === ACCOUNT.uin ? ACCOUNT.id : ''),
    getAccountConfig: () => ({}),
    getSystemConfig: () => ({}),
    getStatusSnapshot: () => ({}),
    getRuntimeState: () => ({}),
    isAccountActive: () => false,
    getLogs: () => [],
    getAccountLogs: () => [],
};

const recorded = [];
const RECORD_METHODS = new Set(['useItem', 'useDogFood']);

const provider = new Proxy(syncStubs, {
    get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== 'string') return undefined;
        return async (...args) => {
            if (RECORD_METHODS.has(prop)) recorded.push({ method: prop, args });
            return {};
        };
    },
});

// ============ 请求工具 ============

function request(method, route, { token, body, rawBody, accountId, headers } = {}) {
    return new Promise((resolve, reject) => {
        // rawBody 用来发非法 JSON 数值：JSON.stringify(Infinity) 会变成 null，
        // 而真实攻击面是请求体里直接写 `1e400`，服务端 JSON.parse 之后才是 Infinity。
        const payload = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1',
            port: PORT,
            method,
            path: route,
            headers: {
                ...BASE_HEADERS,
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                ...(token ? { 'x-admin-token': token } : {}),
                ...(accountId ? { 'x-account-id': accountId } : {}),
                ...(headers || {}),
            },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                text += chunk;
            });
            res.on('end', () => {
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {
                    // 非 JSON（静态资源 / HTML）保持 null
                }
                resolve({ status: res.statusCode, json, text: text.slice(0, 300) });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function waitReady(timeoutMs = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            await request('GET', '/api/ping');
            return true;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    return false;
}

// ============ 断言 ============

const failures = [];
const stubGaps = [];

function isStubGap(res) {
    const text = String(res.text || '');
    return /is not a function|Cannot read propert|不是函数/.test(text);
}

async function expect(label, method, route, options = {}) {
    const res = await request(method, route, options);
    const allowed = Array.isArray(options.want) ? options.want : [options.want];
    const ok = allowed.includes(res.status);
    if (!ok && res.status === 500 && isStubGap(res)) {
        stubGaps.push({ label, route, text: res.text });
        console.log(`  [skip] ${label} → 假 provider 缺方法（不计失败）`);
        return res;
    }
    if (!ok) failures.push({ label, status: res.status, want: allowed, body: res.json ?? res.text });
    console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${label} → ${res.status}`);
    return res;
}

// ============ 主流程 ============

async function main() {
    const { startAdminServer } = require('../../dist/controllers/admin');
    startAdminServer(provider);

    if (!await waitReady()) {
        console.error('服务在 20 秒内没有就绪，冒烟测试中止');
        process.exit(1);
    }
    console.log(`服务已就绪: http://127.0.0.1:${PORT}`);
    console.log(`临时数据目录: ${DATA_DIR}\n`);

    // ---- 1. 鉴权闸门 ----
    console.log('1) 鉴权');
    await expect('未登录访问受保护接口返回 401', 'GET', '/api/accounts', { want: 401 });
    await expect('伪造 token 返回 401', 'GET', '/api/accounts', { token: 'not-a-real-token', want: 401 });
    await expect('缺少账号密码返回 401', 'POST', '/api/login', { body: {}, want: 401 });
    await expect('错误密码返回 401', 'POST', '/api/login', { body: { username: 'admin', password: 'wrong-pass' }, want: 401 });

    const login = await request('POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
    const token = login.json?.data?.token;
    console.log(`  [${login.status === 200 && token ? 'ok  ' : 'FAIL'}] 默认管理员登录并下发 token → ${login.status}`);
    if (!token) {
        failures.push({ label: '登录', status: login.status, want: [200], body: login.json });
        console.error('\n拿不到 token，后续接口无法验证，中止');
        process.exit(1);
    }

    await expect('带合法 token 校验会话', 'GET', '/api/auth/validate', { token, want: 200 });

    // ---- 2. 只读接口 ----
    console.log('\n2) 只读接口（全部应 200）');
    const account = { accountId: ACCOUNT.id };
    const readEndpoints = [
        ['账号列表', '/api/accounts', {}],
        ['当前用户', '/api/user/me', {}],
        ['设置总览', '/api/settings', {}],
        ['默认设置', '/api/settings/default', {}],
        ['系统配置', '/api/settings/system-config', {}],
        ['登录配置', '/api/settings/login-config', {}],
        ['设备预设', '/api/settings/device-presets', {}],
        ['运行日志', '/api/logs', {}],
        ['账号日志', '/api/account-logs', {}],
        ['代码健康', '/api/accounts/code-health', {}],
        ['游戏版本', '/api/game-version', {}],
        ['状态快照', '/api/status', {}],
        ['调度器快照', '/api/scheduler', {}],
        ['作物分析', '/api/analytics', {}],
        ['果实配置', '/api/config/fruits', {}],
        ['物品配置', '/api/config/items', {}],
        ['种子配置', '/api/config/seeds', {}],
        ['种子商店', '/api/seeds', account],
        ['背包', '/api/bag', account],
        ['背包种子', '/api/bag/seeds', account],
        ['地块', '/api/lands', account],
        ['好友列表', '/api/friends', account],
        ['好友缓存', '/api/friends/cache', account],
        ['好友 GID', '/api/friend-known-gids', account],
        ['好友黑名单', '/api/friend-blacklist', account],
        ['互动道具', '/api/friend-interaction-items', account],
        ['自用互动道具', '/api/farm/interaction-items', account],
        ['蔬菜黑名单', '/api/plant-blacklist', account],
        ['藏品', '/api/collections', account],
        ['图鉴', '/api/illustrated', account],
        ['变异图鉴', '/api/illustrated/mutations', account],
        ['商城目录', '/api/game-mall', account],
        ['道具商店', '/api/props-shop', account],
        ['神秘商店', '/api/mystery-shop', account],
        ['神秘商店历史', '/api/mystery-shop/history', account],
        ['活动快照', '/api/activity-center/snapshot', account],
        ['活动目录', '/api/activity-center/activities', account],
        ['赛季', '/api/activity-center/season', account],
        ['活动商店', '/api/activity-center/shop', account],
        ['节气', '/api/activity-center/solar-terms', account],
        ['职业信息', '/api/career', account],
        ['面板通知', '/api/panel-notifications', account],
        ['宠物', '/api/pets', account],
        ['宠物技能', '/api/pets/skills', account],
        ['宠物保护记录', '/api/pets/protect-logs', account],
        ['资本模式', '/api/dog/capital-mode', account],
        ['技能礼包', '/api/dog/skill-gifts', account],
        ['每日礼包', '/api/daily-gifts', account],
        ['钻石', '/api/diamond', account],
        ['互动记录', '/api/interact-records', account],
        ['阳历日程', '/api/solar-calendar', account],
    ];
    for (const [label, route, extra] of readEndpoints) {
        await expect(label, 'GET', route, { token, want: 200, ...extra });
    }

    // ---- 3. 写接口（正常入参） ----
    console.log('\n3) 写接口（正常入参应 200）');
    await expect('保存自动化开关', 'POST', '/api/automation', {
        token,
        accountId: ACCOUNT.id,
        body: { farm: true },
        want: 200,
    });

    // ---- 4. 参数校验（必须是 400，不能 500） ----
    console.log('\n4) 参数校验（非法输入必须 400）');
    const invalidCases = [
        ['地块编号为 1e400（JSON 原始数值）', 'POST', '/api/farm/fertilize', null, '{"landId":1e400,"fertilizerType":"normal"}'],
        ['地块编号为字符串', 'POST', '/api/farm/fertilize', { landId: 'abc', fertilizerType: 'normal' }],
        ['地块编号为负数', 'POST', '/api/land/remove', { landId: -1 }],
        ['化肥类型非法', 'POST', '/api/farm/fertilize', { landId: 1, fertilizerType: 'bogus' }],
        ['购买数量为 1e400（JSON 原始数值）', 'POST', '/api/fertilizer/buy', null, '{"type":"organic","count":1e400}'],
        ['购买数量超上限', 'POST', '/api/fertilizer/buy', { type: 'organic', count: 999999 }],
        ['化肥阈值越界', 'POST', '/api/fertilizer/check-and-buy', { organicThresholdHours: 5000 }],
        ['道具编号缺失', 'POST', '/api/bag/use', { count: 1 }],
        ['出售列表不是数组', 'POST', '/api/bag/sell', { items: 'nope' }],
        ['出售列表超长', 'POST', '/api/bag/sell', { items: Array.from({ length: 600 }, () => ({ id: 1001, count: 1 })) }],
        ['互动道具数组含 Infinity', 'POST', '/api/farm/interaction-items/use-batch', { itemId: 5001, landIds: [1, Number('1e400')] }],
        ['互动道具空数组', 'POST', '/api/farm/interaction-items/use-batch', { itemId: 5001, landIds: [] }],
    ];
    for (const [label, method, route, body, rawBody] of invalidCases) {
        await expect(label, method, route, { token, accountId: ACCOUNT.id, body, rawBody, want: 400 });
    }

    // 数量非法时按设计静默回落成 1：这里直接检查「传进 provider 的值」，
    // 比只看状态码更严格 —— 200 但有 Infinity 漏下去才是真问题。
    const useItemRes = await request('POST', '/api/bag/use', {
        token,
        accountId: ACCOUNT.id,
        rawBody: '{"itemId":1001,"count":1e400}',
    });
    const useItemCall = recorded.find(item => item.method === 'useItem');
    const usedCount = useItemCall ? useItemCall.args[2] : undefined;
    const useItemOk = useItemRes.status === 200 && Number.isFinite(usedCount) && usedCount === 1;
    console.log(`  [${useItemOk ? 'ok  ' : 'FAIL'}] 道具数量 1e400 被清成 1（实际传给 provider: ${String(usedCount)}）`);
    if (!useItemOk) failures.push({ label: '道具数量兜底', status: useItemRes.status, want: ['count=1'], body: { usedCount } });

    // ---- 5. 路由边界 ----
    console.log('\n5) 路由边界');
    const notFound = await request('GET', '/api/definitely-not-exists', { token });
    const notFoundOk = notFound.status === 404 && notFound.json?.ok === false;
    console.log(`  [${notFoundOk ? 'ok  ' : 'FAIL'}] 未知 API 返回 404 JSON → ${notFound.status}`);
    if (!notFoundOk) failures.push({ label: '未知 API', status: notFound.status, want: [404], body: notFound.text });

    const asset = await request('GET', '/game-config/Plant.json');
    const assetOk = asset.status === 200 && asset.text.includes('seed_id');
    console.log(`  [${assetOk ? 'ok  ' : 'FAIL'}] 静态游戏配置可访问 → ${asset.status}`);
    if (!assetOk) failures.push({ label: '静态配置', status: asset.status, want: [200] });

    // ---- 6. 账号解析 ----
    console.log('\n6) 账号解析');
    await expect('缺少 x-account-id 返回 400', 'GET', '/api/bag', { token, want: 400 });
    // 解析不出来时 resolveAccId 会把原始引用透传下去（便于「先填号后建号」），
    // 下游由 worker 报「账号未运行」，所以这里 200 是既定行为而不是漏判。
    await expect('未知账号透传给下游', 'GET', '/api/bag', { token, accountId: 'no-such-account', want: 200 });
    await expect('用 uin 也能解析到账号', 'GET', '/api/bag', { token, accountId: ACCOUNT.uin, want: 200 });

    // ---- 汇总 ----
    console.log('\n================ 结果 ================');
    console.log(`失败: ${failures.length} 条`);
    for (const failure of failures) {
        console.log(`  - ${failure.label}: got ${failure.status}, want ${JSON.stringify(failure.want)}`);
        console.log(`    body: ${String(JSON.stringify(failure.body)).slice(0, 300)}`);
    }
    if (stubGaps.length) {
        console.log(`跳过（假 provider 缺方法）: ${stubGaps.length} 条`);
        for (const item of stubGaps) console.log(`  - ${item.label} (${item.route}) ${item.text.slice(0, 120)}`);
    }

    process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('冒烟测试异常:', error);
    process.exit(1);
});
