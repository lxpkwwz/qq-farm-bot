const test = require('node:test');
const assert = require('node:assert/strict');
const {
    WARNING_WINDOW_MS,
    inspectAccountCodeHealth,
    buildCodeHealthSnapshot,
    autoFixAccountCode,
} = require('../dist/services/code-watch');

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function wxAccount(patch = {}) {
    return {
        id: '1',
        name: '微信一号',
        platform: 'wx',
        expires_at: NOW + 2 * HOUR,
        expires_in: 7200,
        refreshtoken: 'rt-1',
        ...patch,
    };
}

function qqAccount(patch = {}) {
    return { id: '2', name: 'QQ 一号', platform: 'qq', ...patch };
}

test('凭证充足时 Code 正常，不做任何提示', () => {
    const item = inspectAccountCodeHealth(wxAccount(), { now: NOW });
    assert.equal(item.level, 'ok');
    assert.equal(item.autoFixable, false);
    assert.equal(item.needsManual, false);
    assert.equal(item.remainingMs, 2 * HOUR);
});

test('剩余 10 分钟内判定即将过期，且有长效凭证时可自动补 Code', () => {
    const near = inspectAccountCodeHealth(wxAccount({ expires_at: NOW + 8 * MINUTE }), { now: NOW });
    assert.equal(near.level, 'expiring');
    assert.equal(near.autoFixable, true);
    assert.equal(near.needsManual, false);
    assert.equal(WARNING_WINDOW_MS, 10 * MINUTE);
    assert.equal(inspectAccountCodeHealth(wxAccount({ expires_at: NOW + 11 * MINUTE }), { now: NOW }).level, 'ok');
});

test('已过期且没有长效凭证时必须手动补 Code', () => {
    const item = inspectAccountCodeHealth(wxAccount({ expires_at: NOW - 1000, refreshtoken: '', loginBuffer: '' }), { now: NOW });
    assert.equal(item.level, 'expired');
    assert.equal(item.autoFixable, false);
    assert.equal(item.needsManual, true);
    assert.match(item.reason, /需要补 Code/);
});

test('秒级到期时间戳按秒解析，不会被误判为早已过期', () => {
    const item = inspectAccountCodeHealth(wxAccount({ expires_at: Math.floor((NOW + HOUR) / 1000) }), { now: NOW });
    assert.equal(item.level, 'ok');
    assert.equal(item.remainingMs, HOUR);
});

test('续期失败标记只在失败晚于最近一次成功时生效', () => {
    const stale = wxAccount({
        wxCredentialRefreshedAt: NOW - MINUTE,
        wxCredentialLastAttemptAt: NOW - 2 * MINUTE,
        wxCredentialRefreshError: '旧失败',
    });
    assert.equal(inspectAccountCodeHealth(stale, { now: NOW }).level, 'ok');
    const recent = wxAccount({
        wxCredentialRefreshedAt: NOW - 2 * MINUTE,
        wxCredentialLastAttemptAt: NOW - MINUTE,
        wxCredentialRefreshError: 'ManualAuth rejected',
    });
    const item = inspectAccountCodeHealth(recent, { now: NOW });
    assert.equal(item.level, 'refresh_failed');
    assert.match(item.reason, /ManualAuth rejected/);
});

test('QQ 账号最后一条日志是 Code 失效类掉线且未运行 → 判定需要补 Code', () => {
    const item = inspectAccountCodeHealth(qqAccount(), {
        now: NOW,
        running: false,
        latestLogAction: 'disconnect_stop',
    });
    assert.equal(item.level, 'offline');
    assert.equal(item.autoFixable, true);
    assert.equal(item.needsManual, false);
});

test('用户手动停止后不再被历史掉线日志误判', () => {
    const item = inspectAccountCodeHealth(qqAccount(), {
        now: NOW,
        running: false,
        latestLogAction: 'stop',
    });
    assert.equal(item.level, 'ok');
});

test('快照只取每个账号最新一条日志，并汇总需要处理的账号数', () => {
    const accounts = [wxAccount({ expires_at: NOW - 1000 }), qqAccount()];
    const logs = [
        { accountId: '2', action: 'stop' },
        { accountId: '2', action: 'disconnect_stop' },
        { accountId: '1', action: 'start' },
    ];
    const snapshot = buildCodeHealthSnapshot(accounts, {
        now: NOW,
        accountLogs: logs,
        isAccountRunning: () => false,
    });
    assert.equal(snapshot.generatedAt, NOW);
    assert.equal(snapshot.needsAttention, 1);
    assert.equal(snapshot.items[0].level, 'expired');
    assert.equal(snapshot.items[1].latestLogAction, 'stop');
    assert.equal(snapshot.items[1].level, 'ok');
});

function fixDeps(patch = {}) {
    const calls = { restart: [], logs: [], notify: [] };
    return {
        calls,
        deps: {
            getAccount: () => wxAccount(),
            ensureFreshGameCode: async () => ({ ok: true, code: 'new-code' }),
            tryRefreshQqGameCode: async () => ({ ok: true, code: 'new-code' }),
            isAccountRunning: () => true,
            restartAccount: id => calls.restart.push(id),
            addAccountLog: (action, msg, id, name) => calls.logs.push({ action, msg, id, name }),
            notify: (id, entry) => calls.notify.push({ id, entry }),
            ...patch,
        },
    };
}

test('微信自动补 Code 成功后让运行中账号用新 Code 重连', async () => {
    const { calls, deps } = fixDeps();
    const result = await autoFixAccountCode('1', deps);
    assert.equal(result.ok, true);
    assert.equal(result.needsManual, false);
    assert.equal(result.restarted, true);
    assert.deepEqual(calls.restart, ['1']);
    assert.equal(calls.logs[0].action, 'auto_code_fix');
    assert.equal(calls.notify.length, 0);
});

test('掉线停下的账号补 Code 成功后直接拉起，且不会二次触发启动前换码', async () => {
    const { calls, deps } = fixDeps({ isAccountRunning: () => false, latestLogAction: 'disconnect_stop' });
    const result = await autoFixAccountCode('1', deps);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.restart, ['1']);
    assert.equal(calls.logs[0].action, 'auto_code_fix');
});

test('自动补 Code 失败时标记需手动补码，并写入局内通知与账号日志', async () => {
    const { calls, deps } = fixDeps({
        getAccount: () => qqAccount(),
        tryRefreshQqGameCode: async () => ({ ok: false, error: 'QQ 授权服务不支持免扫码重签' }),
    });
    const result = await autoFixAccountCode('2', deps);
    assert.equal(result.ok, false);
    assert.equal(result.needsManual, true);
    assert.match(result.error, /不支持免扫码重签/);
    assert.equal(calls.logs[0].action, 'auto_code_fix_failed');
    assert.equal(calls.notify.length, 1);
    assert.match(calls.notify[0].entry.content, /请到账号管理页/);
    assert.equal(calls.restart.length, 0);
});

test('账号不存在时不会调用续期接口', async () => {
    const { deps } = fixDeps({ getAccount: () => null });
    const result = await autoFixAccountCode('missing', deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, '账号不存在');
});
