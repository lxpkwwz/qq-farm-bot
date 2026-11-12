const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// 账号存储模块只在内存里工作：拦截文件 IO，测试不触碰 core/data。
const mocks = { data: null };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request.endsWith('services/json-db')) {
        return {
            readJsonFileStrict: (_file, fallback) => mocks.data || fallback(),
            writeJsonFileAtomic: (_file, value) => { mocks.data = value; },
            storageError: (action, file, error) => new Error(`${action} ${file}: ${error?.message || error}`),
        };
    }
    if (request.endsWith('/shared-state') || request === './shared-state') return { ACCOUNTS_FILE: 'memory://accounts.json' };
    if (request.endsWith('config/runtime-paths')) return { ensureDataDir: () => {} };
    if (request.endsWith('store/account-config') || request === './account-config') {
        return { ensureAccountConfig: () => {}, removeAccountConfig: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const storePath = require.resolve('../dist/models/store/accounts');

/** 每个用例重新加载模块，清掉模块级 accountsCache，保证从 mocks.data 读取。 */
function seed(accounts) {
    mocks.data = { accounts, nextId: 100 };
    delete require.cache[storePath];
    return require(storePath);
}
function read(store, id) {
    return store.getAccounts().accounts.find(account => account.id === id);
}
function base(id, patch = {}) {
    return {
        id,
        name: `账号${id}`,
        code: 'OLD_CODE',
        platform: 'wx',
        wxid: 'openid-1',
        refreshtoken: 'refresh-1',
        loginBuffer: 'buffer-1',
        expires_in: 7200,
        expires_at: Date.now() + 7200_000,
        wxCredentialRefreshedAt: Date.now() - 3600_000,
        wxCredentialLastAttemptAt: Date.now() - 3600_000,
        wxCredentialRefreshError: '微信授权续期失败：invalid refresh token',
        ...patch,
    };
}

test('重新扫码换 Code 后自动清掉上一次的续期失败标记，但不刷新授权时间戳', () => {
    const store = seed([base('1')]);
    const seeded = read(store, '1');
    store.addOrUpdateAccount({ id: '1', code: 'BRAND_NEW_CODE' });
    const account = read(store, '1');

    assert.equal(account.code, 'BRAND_NEW_CODE');
    assert.equal(account.wxCredentialRefreshError, undefined, '失败标记必须清除，否则账号管理页一直显示待续期颜色');
    // 只换 Code 不会延长 access token 的寿命。若这里把时间戳抬到 now，
    // code-watch 与面板都会按「最近成功 + 2 小时」重算到期时间，
    // 真正的续期窗口被整体推后，token 过期后才发现 → 直接掉线。
    assert.equal(account.wxCredentialRefreshedAt, seeded.wxCredentialRefreshedAt);
    assert.equal(account.wxCredentialLastAttemptAt, seeded.wxCredentialLastAttemptAt);
});

test('只换 Code（loginBuffer 直接换码）不推进到期基准，避免错过续期窗口', () => {
    const store = seed([base('10')]);
    const seeded = read(store, '10');
    const staleExpiry = seeded.expires_at;
    store.addOrUpdateAccount({ id: '10', code: 'BUFFER_SWAPPED_CODE' });
    const account = read(store, '10');

    assert.equal(account.code, 'BUFFER_SWAPPED_CODE');
    assert.equal(account.expires_at, staleExpiry, 'expires_at 是 token 的到期时间，换 Code 不该动它');
    assert.ok(
        Number(account.wxCredentialRefreshedAt) < Date.now(),
        '换 Code 后 refreshedAt 必须保持旧值，否则到期时间会被重算成 now+2h',
    );
});

test('换刷新令牌才更新到期基准时间', () => {
    const store = seed([base('11')]);
    const before = Date.now();
    store.addOrUpdateAccount({ id: '11', refreshtoken: 'refresh-2' });
    const account = read(store, '11');

    assert.equal(account.refreshtoken, 'refresh-2');
    assert.ok(Number(account.wxCredentialRefreshedAt) >= before, '真正换了令牌才应该推进基准时间');
    assert.ok(Number(account.wxCredentialLastAttemptAt) >= before);
});

test('「需要重新扫码」标记能落盘，换到新凭据后被清除', () => {
    const store = seed([base('12')]);
    store.addOrUpdateAccount({ id: '12', wxCredentialNeedsRescan: true });
    // saveAccounts 会用 normalizeAccount 归一化后回填缓存并写文件，
    // 归一化时漏字段就等于这个闸门从来没生效过。
    assert.equal(read(store, '12').wxCredentialNeedsRescan, true, '吊销标记必须落盘，否则跨日之后又会拿死 token 空打 OAuth');

    store.addOrUpdateAccount({ id: '12', refreshtoken: 'refresh-after-rescan' });
    assert.equal(read(store, '12').wxCredentialNeedsRescan, undefined, '重新授权后必须清掉标记，否则账号永远不再自动续期');
});

test('写入 false 的吊销标记不会覆盖落盘值（只认 true）', () => {
    const store = seed([base('13', { wxCredentialNeedsRescan: true })]);
    store.addOrUpdateAccount({ id: '13', name: '改个备注' });
    assert.equal(read(store, '13').wxCredentialNeedsRescan, true);
});

test('只更新备注不会误清失败标记', () => {
    const store = seed([base('2')]);
    store.addOrUpdateAccount({ id: '2', name: '新备注' });
    const account = read(store, '2');
    assert.equal(account.name, '新备注');
    assert.match(account.wxCredentialRefreshError, /invalid refresh token/);
});

test('续期失败写入新错误时保留错误（不带 code）', () => {
    const store = seed([base('3')]);
    store.addOrUpdateAccount({ id: '3', wxCredentialLastAttemptAt: Date.now(), wxCredentialRefreshError: '本次失败' });
    assert.equal(read(store, '3').wxCredentialRefreshError, '本次失败');
});

test('同一 payload 里带新 Code 且显式声明失败时，以显式错误为准', () => {
    const store = seed([base('4')]);
    store.addOrUpdateAccount({ id: '4', code: 'NEW', wxCredentialRefreshError: '换 Code 失败' });
    assert.equal(read(store, '4').wxCredentialRefreshError, '换 Code 失败');
});

test('只换长效凭据（loginBuffer / refreshtoken）同样会清除失败标记', () => {
    const store = seed([base('5')]);
    store.addOrUpdateAccount({ id: '5', loginBuffer: 'buffer-2', refreshtoken: 'refresh-2' });
    assert.equal(read(store, '5').wxCredentialRefreshError, undefined);
});

test('重新扫码写入全套新凭据后到期时间同步更新', () => {
    const expiresAt = Date.now() + 7200_000;
    const store = seed([base('6', { expires_at: 1 })]);
    store.addOrUpdateAccount({
        id: '6',
        code: 'SCANNED',
        wxid: 'openid-2',
        refreshtoken: 'refresh-new',
        accesstoken: 'access-new',
        loginBuffer: 'buffer-new',
        expires_in: 7200,
        expires_at: expiresAt,
        wxCredentialRefreshedAt: Date.now(),
        wxCredentialRefreshError: '',
    });
    const account = read(store, '6');
    assert.equal(account.expires_at, expiresAt);
    assert.equal(account.refreshtoken, 'refresh-new');
    assert.equal(account.wxCredentialRefreshError, undefined);
});
