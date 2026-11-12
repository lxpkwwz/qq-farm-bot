const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../dist/services/wx-login/recovery-policy');

const MINUTE = 60_000;

function info(message) {
    return policy.classifyProtocolError(new Error(message));
}

test('业务码分类：-14 AppID 拒绝 / -10 ticket 被拒 / -101 access token 失效', () => {
    const app = info('wx.login jslogin_business rejected: code=-14');
    assert.equal(app.kind, 'application_rejected');
    assert.equal(app.code, -14);
    assert.equal(app.businessRejected, true);
    assert.equal(app.retryable, true);
    assert.equal(app.definitive, false, '-14 是 AppID 自己的拒绝，不代表凭证被吊销');

    const ticket = info('ManualAuth rejected: code=-10 message=ticket expired');
    assert.equal(ticket.kind, 'ticket_rejected');
    assert.equal(ticket.businessRejected, true);
    assert.equal(ticket.definitive, false, 'ticket 被拒还能重新取一次');

    for (const code of [-101, 40014, 42001]) {
        const access = info(`微信授权续期失败：code=${code} msg=access_token invalid`);
        assert.equal(access.kind, 'access_rejected', `${code} 应归为 access token 失效`);
        assert.equal(access.retryable, true, 'access token 失效还能靠 refresh token 救回来');
        assert.equal(access.needsRescan, false);
    }
});

test('业务码分类：-109 / 42007 / 40030 / 42002 判为凭证已被吊销', () => {
    for (const code of [-109, 42007, 40030, 42002]) {
        const result = info(`微信授权续期失败：code=${code} msg=unknown`);
        assert.equal(result.kind, 'refresh_rejected', `${code} 应归为 refresh token 吊销`);
        assert.equal(result.definitive, true);
        assert.equal(result.needsRescan, true, '必须停止自动重试，等用户重新扫码');
        assert.equal(result.retryable, false);
    }
});

test('scope 与文案判定：40188 + invalid scope、重新扫码类文案都算吊销', () => {
    const scope = info('微信授权续期失败：code=40188 msg=invalid scope');
    assert.equal(scope.kind, 'scope_rejected');
    assert.equal(scope.definitive, true);

    assert.equal(info('账号缺少微信刷新凭证，请重新扫码登录').definitive, true);
    assert.equal(info('refresh_token is invalid').definitive, true);
    assert.equal(info('刷新令牌已过期').definitive, true);
});

test('传输类错误一律可重试，不会被误判成凭证吊销', () => {
    for (const message of ['网络超时', 'socket hang up', '微信授权续期请求失败（HTTP 502）', 'ECONNRESET']) {
        const result = info(message);
        assert.equal(result.kind, 'transient', message);
        assert.equal(result.definitive, false, `${message} 不是吊销证据`);
        assert.equal(result.retryable, true);
    }
});

test('-14 的修复闸门：两分钟内刚成功过就不重新登录', () => {
    const error = new Error('wx.login jslogin_business rejected: code=-14');
    assert.equal(policy.isApplicationRequestRejection(error), true);
    assert.equal(policy.shouldRepairAfterApplicationRejection(error, 0, 1_000_000), true, '没有成功记录时可以修一次');
    assert.equal(
        policy.shouldRepairAfterApplicationRejection(error, 1_000_000 - MINUTE, 1_000_000),
        false,
        '刚成功过的会话上出现 -14，更可能是 AppID 拒绝，重新登录只会多消耗一次授权',
    );
    assert.equal(
        policy.shouldRepairAfterApplicationRejection(error, 1_000_000 - 3 * MINUTE, 1_000_000),
        true,
        '超过 2 分钟窗口后允许修一次',
    );
    assert.equal(
        policy.shouldRepairAfterApplicationRejection(new Error('网络超时'), 0, 1_000_000),
        false,
        '不是 -14 就不走这条修复路径',
    );
});

test('退避：吊销直接停、已过期 15 分钟、其余按剩余寿命夹逼在 30 秒~5 分钟', () => {
    assert.equal(policy.computeRefreshBackoff(60 * MINUTE, { definitive: true, kind: 'refresh_rejected' }), 0);
    assert.equal(policy.computeRefreshBackoff(0, { definitive: false }), 15 * MINUTE);
    assert.equal(policy.computeRefreshBackoff(-1000, { definitive: false }), 15 * MINUTE);
    assert.equal(policy.computeRefreshBackoff(2 * MINUTE, { definitive: false }), MINUTE, '剩余的一半');
    assert.equal(policy.computeRefreshBackoff(20_000, { definitive: false }), 30_000, '下限 30 秒');
    assert.equal(policy.computeRefreshBackoff(100 * MINUTE, { definitive: false }), 5 * MINUTE, '上限 5 分钟');
});
