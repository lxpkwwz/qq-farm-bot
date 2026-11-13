/**
 * 管理面板中间件：鉴权、客户端 IP、错误形状。
 *
 * 这层没有自己的测试，但它决定了三件到处都在用的事：
 *   1. 谁能进（`createAuthRequired` 是唯一的 token 闸门）；
 *   2. 限流按什么 IP 计数（`getClientIp` 取错头就等于所有请求共用一个桶，或者反过来绕开限流）；
 *   3. 错误响应的形状（软错误 200 / 其余 500 是历史契约，前端按这个分支）。
 *
 * 还额外锁一条实测过的坑：`handleApiError` 里的 `Number(err.code)`——
 * 有些错误对象的 code 是字符串状态码（`'ECONNRESET'`），`Number()` 得到 NaN 会被过滤掉，
 * 但 `Infinity` 这种是真能写进 JSON 的（JSON.stringify(Infinity) === 'null'，前端拿到 null）。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

let storeAccounts = { accounts: [] };
require.cache[require.resolve('../dist/models/store')] = {
    exports: {
        getAccounts: () => storeAccounts,
        getKnownFriendGids: () => [1, 2],
        getKnownFriendGidSyncCooldownSec: () => 600,
        getFriendsListCacheTtlSec: () => 60,
    },
};

const middleware = require('../dist/controllers/admin/middleware');

function fakeRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
    return res;
}

function reqWith(headers = {}, extra = {}) {
    return { headers, ...extra };
}

// ============ 客户端 IP ============

test('客户端 IP 按 cf-connecting-ip → x-real-ip → x-forwarded-for → socket 的顺序取', () => {
    assert.equal(middleware.getClientIp(reqWith({ 'cf-connecting-ip': '1.1.1.1' })), '1.1.1.1');
    assert.equal(middleware.getClientIp(reqWith({ 'x-real-ip': '2.2.2.2' })), '2.2.2.2');
    assert.equal(middleware.getClientIp(reqWith({ 'x-forwarded-for': '3.3.3.3, 4.4.4.4' })), '3.3.3.3');
    assert.equal(middleware.getClientIp(reqWith({}, { ip: '5.5.5.5' })), '5.5.5.5');
    assert.equal(middleware.getClientIp(reqWith({}, { socket: { remoteAddress: '6.6.6.6' } })), '6.6.6.6');
    assert.equal(middleware.getClientIp(reqWith({})), 'unknown');
});

test('x-forwarded-for 里有空项时取第一个非空值', () => {
    assert.equal(middleware.getClientIp(reqWith({ 'x-forwarded-for': ' , , 7.7.7.7,8.8.8.8' })), '7.7.7.7');
});

test('IPv4-mapped IPv6 地址去掉 ::ffff: 前缀，保证限流按同一个桶计数', () => {
    assert.equal(middleware.getClientIp(reqWith({}, { ip: '::ffff:9.9.9.9' })), '9.9.9.9');
});

test('cf-connecting-ip 优先于 x-real-ip 与 x-forwarded-for', () => {
    const req = reqWith({
        'cf-connecting-ip': '1.1.1.1',
        'x-real-ip': '2.2.2.2',
        'x-forwarded-for': '3.3.3.3',
    });
    assert.equal(middleware.getClientIp(req), '1.1.1.1');
});

// ============ 鉴权闸门 ============

test('没有 token 时返回 401，且不调用 next', () => {
    const guard = middleware.createAuthRequired({ tokens: new Set(['good']) });
    const req = reqWith({});
    const res = fakeRes();
    let nextCalled = false;

    guard(req, res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.equal(nextCalled, false);
});

test('token 不在集合里时返回 401', () => {
    const guard = middleware.createAuthRequired({ tokens: new Set(['good']) });
    const res = fakeRes();
    let nextCalled = false;

    guard(reqWith({ 'x-admin-token': 'bad' }), res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test('token 合法时放行并把 token 挂到请求上', () => {
    const guard = middleware.createAuthRequired({ tokens: new Set(['good']) });
    const req = reqWith({ 'x-admin-token': 'good' });
    const res = fakeRes();
    let nextCalled = false;

    guard(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.adminToken, 'good');
    assert.equal(res.statusCode, 200, '放行时不应该写响应');
});

// ============ 账号列表 ============

test('账号列表优先取 provider，provider 抛错时回落到持久化存储', () => {
    storeAccounts = { accounts: [{ id: 'stored' }] };
    const goodProvider = { getAccounts: () => ({ accounts: [{ id: 'live' }] }) };
    assert.deepEqual(middleware.getAccountIds({ provider: goodProvider }), ['live']);

    const brokenProvider = {
        getAccounts: () => {
            throw new Error('worker 未启动');
        },
    };
    assert.deepEqual(middleware.getAccountIds({ provider: brokenProvider }), ['stored']);
});

test('账号列表返回非法结构时退化成空数组，而不是抛错', () => {
    storeAccounts = { accounts: 'not-an-array' };
    assert.deepEqual(middleware.getAccountList({ provider: { getAccounts: () => ({ accounts: null }) } }), []);
    assert.deepEqual(middleware.getAccountIds({ provider: null }), []);
});

// ============ 错误分类 ============

test('软错误只认「账号未运行」与「API Timeout」两种文案', () => {
    assert.equal(middleware.isSoftRuntimeError('账号未运行'), true);
    assert.equal(middleware.isSoftRuntimeError(new Error('API Timeout')), true);
    assert.equal(middleware.isSoftRuntimeError(new Error('其他错误')), false);
    assert.equal(middleware.isSoftRuntimeError(null), false);
});

test('网关协议错误：识别 GatewayError 名字、errorMessage 字段与 code= 文案', () => {
    assert.equal(middleware.isGatewayProtocolError({ name: 'GatewayError' }), true);
    assert.equal(middleware.isGatewayProtocolError({ errorMessage: '错误' }), true);
    assert.equal(middleware.isGatewayProtocolError({ error_message: '错误' }), true);
    assert.equal(middleware.isGatewayProtocolError(new Error('gamepb.x.Y code=700')), true);
    assert.equal(middleware.isGatewayProtocolError(new Error('普通网络错误')), false);
});

test('协议文案优先取字段，其次从 code= 后面截取', () => {
    assert.equal(middleware.getProtocolErrorMessage({ errorMessage: '道具不足' }), '道具不足');
    assert.equal(middleware.getProtocolErrorMessage(new Error('gamepb.x.Y code=700 背包已满')), '背包已满');
    assert.equal(middleware.getProtocolErrorMessage(new Error('普通错误')), '');
});

// ============ 错误响应形状 ============

test('软错误与网关错误返回 200，其余返回 500（历史契约，前端按这个分支）', () => {
    const soft = fakeRes();
    middleware.handleApiError(soft, new Error('账号未运行'));
    assert.equal(soft.statusCode, 200);
    assert.equal(soft.body.ok, false);

    const gateway = fakeRes();
    middleware.handleApiError(gateway, { name: 'GatewayError', errorMessage: '道具不足', message: 'x' });
    assert.equal(gateway.statusCode, 200);
    assert.equal(gateway.body.error, '道具不足');
    assert.equal(gateway.body.errorMessage, '道具不足');

    const hard = fakeRes();
    middleware.handleApiError(hard, new Error('数据库写入失败'));
    assert.equal(hard.statusCode, 500);
    assert.equal(hard.body.error, '数据库写入失败');
});

test('errorCode 只在有限且非零时下发，Infinity 不能进响应体', () => {
    const withCode = fakeRes();
    middleware.handleApiError(withCode, Object.assign(new Error('x'), { code: 700 }));
    assert.equal(withCode.body.errorCode, 700);

    const zero = fakeRes();
    middleware.handleApiError(zero, Object.assign(new Error('x'), { code: 0 }));
    assert.equal(zero.body.errorCode, undefined);

    const textCode = fakeRes();
    middleware.handleApiError(textCode, Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    assert.equal(textCode.body.errorCode, undefined, '字符串状态码不该被 Number() 成 NaN 再写出去');

    const infinite = fakeRes();
    middleware.handleApiError(infinite, Object.assign(new Error('x'), { code: Number('1e400') }));
    assert.equal(infinite.body.errorCode, undefined, 'Infinity 是 JSON 里会变成 null 的脏值');
});

test('字符串形式的错误也能得到 ok:false', () => {
    const res = fakeRes();
    middleware.handleApiError(res, '账号未运行');
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, '账号未运行');
    assert.equal(res.statusCode, 200);
});

test('未知错误至少给出兜底文案，不返回空 error', () => {
    const res = fakeRes();
    middleware.handleApiError(res, {});
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'Unknown error');
});

// ============ 账号解析 ============

test('账号引用解析：provider 认得出来就以 provider 为准', () => {
    storeAccounts = { accounts: [{ id: 'a1', uin: '10001' }, { id: 'b2', uin: '10002' }] };
    const ctx = {
        provider: { resolveAccountId: ref => (ref === '10002' ? 'b2' : '') },
    };
    assert.equal(middleware.resolveAccId(ctx, '10002'), 'b2');
});

test('账号引用解析：provider 不认时回落到本地账号表的 id / uin / qq', () => {
    storeAccounts = { accounts: [{ id: 'a1', uin: '10001', qq: '20001' }] };
    const ctx = { provider: null };
    assert.equal(middleware.resolveAccId(ctx, 'a1'), 'a1');
    assert.equal(middleware.resolveAccId(ctx, '10001'), 'a1');
    assert.equal(middleware.resolveAccId(ctx, '20001'), 'a1');
});

test('账号引用解析：都认不出来时原样返回，空引用返回空串', () => {
    storeAccounts = { accounts: [] };
    const ctx = { provider: null };
    assert.equal(middleware.resolveAccId(ctx, 'unknown-ref'), 'unknown-ref');
    assert.equal(middleware.resolveAccId(ctx, ''), '');
    assert.equal(middleware.resolveAccId(ctx, null), '');
});

test('getAccId 从 x-account-id 头取账号', () => {
    storeAccounts = { accounts: [{ id: 'a1', uin: '10001' }] };
    const ctx = { provider: null };
    assert.equal(middleware.getAccId(ctx, reqWith({ 'x-account-id': '10001' })), 'a1');
    assert.equal(middleware.getAccId(ctx, reqWith({})), '');
});

// ============ 好友 GID 设置 ============

test('好友 GID 设置带默认值，存储缺失时用 600 秒 / 60 秒', () => {
    const settings = middleware.buildKnownFriendGidSettings('a1');
    assert.deepEqual(settings.knownFriendGids, [1, 2]);
    assert.equal(settings.knownFriendGidSyncCooldownSec, 600);
    assert.equal(settings.friendsListCacheTtlSec, 60);
});
