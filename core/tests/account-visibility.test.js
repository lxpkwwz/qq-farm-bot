const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { PRIVATE_CREDENTIAL_KEYS, toPublicAccount, toPublicAccountsData } = require('../dist/services/account-visibility');

/** 与 wx-credential.hasWxCredential 同一口径：微信账号 + wxid + refreshtoken 齐备。 */
const canPreflight = account => String(account?.platform || '') === 'wx'
    && !!String(account?.wxid || '').trim()
    && !!String(account?.refreshtoken || '').trim();

function account(patch = {}) {
    return {
        id: '1',
        name: '微信账号',
        platform: 'wx',
        code: 'GAME_CODE',
        wxid: 'openid-1',
        refreshtoken: 'refresh-1',
        accesstoken: 'access-1',
        loginBuffer: 'buffer-1',
        expires_at: 1800000000000,
        ...patch,
    };
}

test('账号列表对外投影剥离全部长效凭证明文，保留展示与编辑需要的字段', () => {
    const publicAccount = toPublicAccount(account(), canPreflight);
    for (const key of PRIVATE_CREDENTIAL_KEYS) {
        assert.equal(key in publicAccount, false, `${key} 不能出现在浏览器响应里`);
    }
    assert.deepEqual(PRIVATE_CREDENTIAL_KEYS, ['refreshtoken', 'accesstoken', 'loginBuffer']);
    assert.equal(publicAccount.code, 'GAME_CODE', '编辑弹窗还要读 code');
    assert.equal(publicAccount.wxid, 'openid-1');
    assert.equal(publicAccount.expires_at, 1800000000000, '凭证倒计时还要用到期时间');
    assert.equal(publicAccount.name, '微信账号');
});

/** 与 wx-keepalive.canRecoverAccount 同一口径：微信账号 + (loginBuffer 或 refreshtoken)。 */
const canRecover = account => String(account?.platform || '') === 'wx'
    && (!!String(account?.loginBuffer || '').trim() || !!String(account?.refreshtoken || '').trim());

test('只有 loginBuffer 的账号：滚不了 token，但掉线后能免扫码重登', () => {
    const onlyBuffer = account({ refreshtoken: '', wxid: '' });
    const pub = toPublicAccount(onlyBuffer, canPreflight, undefined, canRecover);

    assert.equal(pub.wxPreflightSupported, false, '没有 refreshtoken，到期前预检做不了');
    assert.equal(pub.wxCanRecover, true, 'loginBuffer 能直接换 Code，掉线重登照样会成功并记账');
});

test('两个判定都缺凭据时为 false；QQ 账号不下发 wxCanRecover', () => {
    assert.equal(
        toPublicAccount(account({ refreshtoken: '', loginBuffer: '' }), canPreflight, undefined, canRecover).wxCanRecover,
        false,
    );
    const qq = toPublicAccount(account({ platform: 'qq' }), canPreflight, undefined, canRecover);
    assert.equal('wxCanRecover' in qq, false, 'QQ 不走微信续期，不该带这个字段');
});

test('免扫码续期标记严格按 wxid + refreshtoken 齐备判定', () => {
    assert.equal(toPublicAccount(account(), canPreflight).wxPreflightSupported, true);
    assert.equal(toPublicAccount(account({ refreshtoken: '' }), canPreflight).wxPreflightSupported, false);
    assert.equal(toPublicAccount(account({ wxid: '' }), canPreflight).wxPreflightSupported, false);
    assert.equal(toPublicAccount(account({ platform: 'qq' }), canPreflight).wxPreflightSupported, false);
    assert.equal(toPublicAccount({}, canPreflight).wxPreflightSupported, false);
});

test('投影只作用于响应副本，后端拿到的原账号对象不受影响', () => {
    const original = account();
    const publicAccount = toPublicAccount(original, canPreflight);
    assert.notStrictEqual(publicAccount, original);
    assert.equal(original.refreshtoken, 'refresh-1');
    assert.equal(original.loginBuffer, 'buffer-1');
    assert.equal(original.accesstoken, 'access-1');
    publicAccount.name = '改名不应影响原对象';
    assert.equal(original.name, '微信账号');
});

test('判定函数缺失或抛错时降级为 false，不让接口 500', () => {
    assert.equal(toPublicAccount(account(), undefined).wxPreflightSupported, false);
    assert.equal(toPublicAccount(account(), null).wxPreflightSupported, false);
});

test('整个列表响应保留 nextId 等顶层字段，并逐账号投影', () => {
    const data = {
        accounts: [account(), account({ id: '2', refreshtoken: '' }), account({ id: '3', platform: 'qq' })],
        nextId: 4,
    };
    const result = toPublicAccountsData(data, canPreflight);
    assert.equal(result.nextId, 4);
    assert.equal(result.accounts.length, 3);
    assert.deepEqual(result.accounts.map(item => item.wxPreflightSupported), [true, false, false]);
    for (const item of result.accounts) {
        for (const key of PRIVATE_CREDENTIAL_KEYS) assert.equal(key in item, false);
    }
});

test('空数据 / 异常 accounts 字段安全兜底', () => {
    assert.deepEqual(toPublicAccountsData(null, canPreflight), { accounts: [] });
    assert.deepEqual(toPublicAccountsData({}, canPreflight), { accounts: [] });
    assert.deepEqual(toPublicAccountsData({ accounts: 'oops', nextId: 9 }, canPreflight), { accounts: [], nextId: 9 });
    assert.equal(toPublicAccount(null, canPreflight).wxPreflightSupported, false);
});

test('/api/accounts 走对外投影，不再把 store 数据原样发给浏览器', () => {
    const source = readFileSync(path.join(__dirname, '../src/controllers/admin/account-routes.ts'), 'utf8');
    const listRoute = source.slice(
        source.indexOf("app.get('/api/accounts'"),
        source.indexOf("app.get('/api/accounts/code-health'"),
    );
    assert.ok(listRoute.length > 0);
    assert.match(listRoute, /toPublicAccountsData\(data, hasWxCredential, getPreflightStatsSnapshot\(\), canRecoverAccount\)/);
    assert.match(listRoute, /require\('..\/..\/services\/wx-credential'\)/);
    assert.match(listRoute, /const \{ canRecoverAccount \} = require\('..\/..\/services\/wx-keepalive'\)/);
    assert.match(source, /const \{ getPreflightStatsSnapshot \} = require\('..\/..\/services\/preflight-stats'\)/);
    assert.doesNotMatch(listRoute, /res\.json\(\{ ok: true, data \}\)/);
});
