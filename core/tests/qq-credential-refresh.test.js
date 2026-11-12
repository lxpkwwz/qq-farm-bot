const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// NapCat 与 store 全部注入内存假实现：不发网络、不碰 core/data。
const mocks = {
    settings: null,
    accounts: [],
    patches: [],
    responses: [],
    posts: 0,
};

const storeMock = {
    getLoginSettings: () => mocks.settings,
    getAccounts: () => ({ accounts: mocks.accounts }),
    addOrUpdateAccount: patch => { mocks.patches.push(patch); },
};

const axiosMock = {
    default: {
        post: async () => {
            mocks.posts += 1;
            const next = mocks.responses.length > 1 ? mocks.responses.shift() : mocks.responses[0];
            if (next instanceof Error) throw next;
            return { data: next };
        },
    },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'axios') return axiosMock;
    if (request === '../models/store') return storeMock;
    return originalLoad.call(this, request, parent, isMain);
};

const {
    tryRefreshQqGameCode,
    isQqCodeRefreshConfigured,
    resetQqCodeRefreshState,
} = require('../dist/services/qq-credential');

after(() => {
    Module._load = originalLoad;
});

function reset() {
    mocks.settings = { qqQrLogin: true, napCatEndpoint: 'http://napcat.local', napCatSignature: 'sig' };
    mocks.accounts = [{ id: 'qq-1', name: 'QQ 一号', platform: 'qq', uin: '10001', qq: '10001' }];
    mocks.patches = [];
    mocks.responses = [];
    mocks.posts = 0;
    resetQqCodeRefreshState();
}

test('未配置 NapCat 时不算可自愈，也不发请求', async () => {
    reset();
    mocks.settings = null;
    assert.equal(isQqCodeRefreshConfigured(), false);
    const result = await tryRefreshQqGameCode('qq-1');
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(mocks.posts, 0);
});

test('重签成功：返回新 Code 并写回账号', async () => {
    reset();
    mocks.responses = [{ ok: true, code: 'fresh-code' }];
    assert.equal(isQqCodeRefreshConfigured(), true);
    const result = await tryRefreshQqGameCode('qq-1');
    assert.equal(result.ok, true);
    assert.equal(result.code, 'fresh-code');
    assert.deepEqual(mocks.patches, [{ id: 'qq-1', code: 'fresh-code' }]);
});

test('标准服务明确不支持（TASK_EXPIRED）后停止探测，避免反复打无效请求', async () => {
    reset();
    mocks.responses = [{ ok: false, code: 'TASK_EXPIRED' }];
    assert.equal((await tryRefreshQqGameCode('qq-1')).ok, false);
    assert.equal(isQqCodeRefreshConfigured(), false, '明确不支持后不再声称可自愈');

    const second = await tryRefreshQqGameCode('qq-1');
    assert.equal(second.skipped, true);
    assert.equal(mocks.posts, 1, '第二次不再发请求');
});

test('NapCat 里 QQ 未登录（LOGIN_REQUIRED）属于可恢复状态，下次仍会尝试', async () => {
    reset();
    mocks.responses = [{ ok: false, code: 'LOGIN_REQUIRED' }, { ok: true, code: 'after-relogin' }];
    const first = await tryRefreshQqGameCode('qq-1');
    assert.equal(first.ok, false);
    assert.match(first.error, /LOGIN_REQUIRED/);
    assert.equal(isQqCodeRefreshConfigured(), true, 'NapCat 重新扫码后应该还能继续重签');

    const second = await tryRefreshQqGameCode('qq-1');
    assert.equal(second.ok, true);
    assert.equal(second.code, 'after-relogin');
    assert.equal(mocks.posts, 2);
});

test('网络异常不会被当成「服务不支持」永久禁用', async () => {
    reset();
    mocks.responses = [new Error('connect ECONNREFUSED')];
    const result = await tryRefreshQqGameCode('qq-1');
    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
    assert.equal(isQqCodeRefreshConfigured(), true, '临时故障不能永久关掉掉线自愈');
});
