const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SRC = path.join(__dirname, '..', 'src');

// 保活调度器的 store / 微信续期服务全部注入内存假实现：不发网络、不碰 core/data。
const mocks = {
    accounts: [],
    running: new Set(),
    restarts: [],
    logs: [],
    printed: [],
    preflightResults: [],
    systemConfig: null,
    tokenCalls: [],
    codeCalls: [],
    fullCalls: [],
    tokenImpl: null,
    codeImpl: null,
    fullImpl: null,
    qqConfigured: true,
    qqRefreshImpl: null,
};

const storeMock = {
    getAccounts: () => ({ accounts: mocks.accounts }),
    getSystemConfig: () => mocks.systemConfig,
};

const wxCredentialMock = {
    hasWxCredential: account => !!account
        && String(account.platform || '') === 'wx'
        && !!String(account.wxid || '').trim()
        && !!String(account.refreshtoken || '').trim(),
    renewOAuthToken: async id => { mocks.tokenCalls.push(String(id)); return mocks.tokenImpl(String(id)); },
    ensureFreshGameCode: async id => { mocks.codeCalls.push(String(id)); return mocks.codeImpl(String(id)); },
    refreshAccountCredential: async id => { mocks.fullCalls.push(String(id)); return mocks.fullImpl(String(id)); },
};

// QQ 没有滚动凭证，掉线重登走 NapCat 免扫码重签；这里给一个可控的假实现。
const qqCredentialMock = {
    isQqCodeRefreshConfigured: () => mocks.qqConfigured,
    tryRefreshQqGameCode: async id => mocks.qqRefreshImpl(id),
    resetQqCodeRefreshState: () => {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '../models/store') return storeMock;
    if (request === './wx-credential') return wxCredentialMock;
    if (request === './qq-credential') return qqCredentialMock;
    return originalLoad.call(this, request, parent, isMain);
};

const ka = require('../dist/services/wx-keepalive');
const { OFFLINE_LOG_ACTIONS } = require('../dist/services/code-watch');

after(() => {
    ka.stopWxKeepAlive();
    Module._load = originalLoad;
});

function wxAccount(patch = {}) {
    return {
        id: '1',
        name: '微信一号',
        platform: 'wx',
        wxid: 'wxid-1',
        refreshtoken: 'rt-1',
        loginBuffer: 'lb-1',
        expires_in: 7200,
        expires_at: NOW + 2 * HOUR,
        ...patch,
    };
}

function qqAccount(patch = {}) {
    return {
        id: '9',
        name: 'QQ 一号',
        platform: 'qq',
        uin: '10001',
        qq: '10001',
        code: 'old-code',
        ...patch,
    };
}

function reset() {
    mocks.accounts = [];
    mocks.running = new Set();
    mocks.restarts = [];
    mocks.logs = [];
    mocks.printed = [];
    mocks.preflightResults = [];
    mocks.systemConfig = null;
    mocks.tokenCalls = [];
    mocks.codeCalls = [];
    mocks.fullCalls = [];
    mocks.qqConfigured = true;
    mocks.tokenImpl = async id => ({ ok: true, accountId: id, accountName: '微信一号', codeIssued: false });
    mocks.codeImpl = async id => ({ ok: true, accountId: id, accountName: '微信一号', code: 'new-code', codeIssued: true });
    mocks.fullImpl = async id => ({ ok: true, accountId: id, accountName: '微信一号', code: 'full-code', codeIssued: true });
    mocks.qqRefreshImpl = async id => ({ ok: true, code: 'new-code', accountId: id });
    ka.stopWxKeepAlive(); // 清掉定时器、inFlight 与熔断计数
    ka.startWxKeepAlive({
        isAccountRunning: id => mocks.running.has(id),
        restartWorker: acc => mocks.restarts.push(String(acc.id)),
        log: (tag, msg) => mocks.printed.push({ tag, msg }),
        addAccountLog: (action, msg, id) => mocks.logs.push({ action, msg, id: String(id || '') }),
        recordPreflightResult: (id, ok, at) => mocks.preflightResults.push({ id: String(id), ok, at }),
    });
}

test('阈值对齐官方续期窗口：到期前 5 分钟滚令牌，不再提前 45 分钟', () => {
    assert.equal(ka.RENEW_AHEAD_MS, 5 * MINUTE);
    assert.equal(ka.PREFLIGHT_WINDOW_MS, 5 * MINUTE, '预警窗口与续期窗口是同一个值');
    assert.equal(ka.PREFLIGHT_RETRY_MS, 5 * MINUTE, '未知剩余寿命时的默认退避');
    assert.equal(ka.MAX_DAILY_PREFLIGHT_FAILURES, 8, '日额度只统计失败次数');
    assert.equal(ka.MAX_CONSECUTIVE_FAILURES, 3);
});

test('isCredentialDue：只有进入到期前 5 分钟才触发', () => {
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW + 2 * HOUR }), NOW), false);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW + 10 * MINUTE }), NOW), false);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW + 5 * MINUTE }), NOW), true);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW + MINUTE }), NOW), true);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW - MINUTE }), NOW), true);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: 0, wxCredentialRefreshedAt: 0 }), NOW), true);
    // 秒级到期时间戳也要兼容（老数据可能由外部写成秒）
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: (NOW + 2 * HOUR) / 1000 }), NOW), false);
});

test('governor：失败按剩余寿命退避，连续 3 次熔断，成功清零且不占额度', () => {
    const g = ka.createPreflightGovernor(() => NOW);
    assert.equal(g.canAttempt('x', NOW), true);
    g.recordAttempt('x', NOW);
    g.recordFailure('x', '网络超时', NOW);
    assert.equal(g.canAttempt('x', NOW + MINUTE), false, '退避期内不重复打续期接口');
    assert.equal(g.canAttempt('x', NOW + 5 * MINUTE + 1), true, '未知剩余寿命时默认退避 5 分钟');

    g.recordAttempt('x', NOW + 5 * MINUTE + 1);
    g.recordFailure('x', '网络超时', NOW + 5 * MINUTE + 1);
    g.recordSuccess('x', NOW + 5 * MINUTE + 2);
    assert.equal(g.snapshot('x', NOW + 5 * MINUTE + 2).failures, 0, '成功后连续失败计数清零');
    assert.equal(g.snapshot('x', NOW + 5 * MINUTE + 2).failuresToday, 2, '成功不占日额度，仍只记 2 次失败');

    g.recordAttempt('x', NOW + 12 * MINUTE);
    g.recordFailure('x', '网络超时', NOW + 12 * MINUTE);
    g.recordAttempt('x', NOW + 18 * MINUTE);
    g.recordFailure('x', '网络超时', NOW + 18 * MINUTE);
    g.recordAttempt('x', NOW + 24 * MINUTE);
    g.recordFailure('x', '网络超时', NOW + 24 * MINUTE);
    assert.equal(g.canAttempt('x', NOW + 40 * MINUTE), false, '连续 3 次失败熔断');
});

test('governor：退避按剩余寿命走，30 秒到 5 分钟之间，已过期才 15 分钟', () => {
    const g = ka.createPreflightGovernor(() => NOW);
    // 剩余 2 分钟 → 退避 = max(30s, 剩余/2) = 1 分钟
    g.recordAttempt('d', NOW);
    g.recordFailure('d', '网络超时', NOW, 2 * MINUTE);
    assert.equal(g.canAttempt('d', NOW + 59_000), false);
    assert.equal(g.canAttempt('d', NOW + MINUTE + 1), true);

    // 已过期 → 15 分钟，避免每个 tick 都重复打一个必然被拒的请求
    g.recordAttempt('e', NOW);
    g.recordFailure('e', '网络超时', NOW, 0);
    assert.equal(g.canAttempt('e', NOW + 14 * MINUTE), false);
    assert.equal(g.canAttempt('e', NOW + 15 * MINUTE + 1), true);
});

test('governor：凭证明确吊销直接熔断，UTC+8 换日后重新放行', () => {
    const g = ka.createPreflightGovernor(() => NOW);
    g.recordAttempt('y', NOW);
    g.recordFailure('y', '凭证已失效，请重新扫码登录', NOW);
    assert.equal(g.canAttempt('y', NOW + 60 * MINUTE), false, '当天不再重试');
    assert.equal(g.canAttempt('y', NOW + DAY), true, '跨 UTC+8 自然日后重新计数');
});

test('governor：当日累计 8 次失败才熔断，穿插成功不减免日额度', () => {
    const g = ka.createPreflightGovernor(() => NOW);
    for (let i = 0; i < 8; i++) {
        const at = NOW + i * 6 * MINUTE;
        assert.equal(g.canAttempt('z', at), true, `第 ${i + 1} 次失败应放行`);
        g.recordAttempt('z', at);
        g.recordFailure('z', '网络超时', at);
        g.recordSuccess('z', at + 1); // 只清连续失败，不清当日累计失败
    }
    assert.equal(g.snapshot('z', NOW + 7 * 6 * MINUTE).failuresToday, 8);
    assert.equal(g.canAttempt('z', NOW + 9 * 6 * MINUTE), false, '当日累计 8 次失败后熔断');
    assert.equal(g.canAttempt('z', NOW + DAY), true, '换日后重新计数');
});

test('governor：连续 12 次成功不消耗任何日额度', () => {
    const g = ka.createPreflightGovernor(() => NOW);
    for (let i = 0; i < 12; i++) {
        const at = NOW + i * 6 * MINUTE;
        assert.equal(g.canAttempt('s', at), true, `第 ${i + 1} 次成功不应被日额度拦下`);
        g.recordAttempt('s', at);
        g.recordSuccess('s', at);
    }
    assert.equal(g.snapshot('s', NOW + 12 * 6 * MINUTE).failuresToday, 0);
    assert.equal(g.canAttempt('s', NOW + 12 * 6 * MINUTE + 6 * MINUTE), true);
});

test('到期前只滚令牌：不换 Code、不重启连接', async () => {
    reset();
    const acc = wxAccount({ expires_at: NOW + 3 * MINUTE });
    mocks.accounts = [acc];
    mocks.running.add('1');
    mocks.tokenImpl = async id => {
        acc.expires_at = NOW + 2 * HOUR; // 模拟滚动续期写回新到期时间
        return { ok: true, accountId: id, accountName: '微信一号', codeIssued: false };
    };
    assert.equal(ka.getConfig().offlineEnabled, true, '系统配置默认开启掉线重登（只在掉线后动作）');
    assert.equal('enabled' in ka.getConfig(), false, '定时重登开关已整体移除');
    assert.deepEqual(await ka.runCodePreflight(NOW), ['1']);
    assert.deepEqual(mocks.tokenCalls, ['1'], '走的是「只滚 token」的续期');
    assert.deepEqual(mocks.codeCalls, [], '预检不再顺手换 Code');
    assert.deepEqual(mocks.fullCalls, [], '预检不碰 loginBuffer 全链路');
    assert.deepEqual(mocks.restarts, [], '预检不再重启连接（面板上的「每 2 小时闪一次」消失）');
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_preflight'));
    assert.ok(mocks.printed.some(entry => entry.msg.includes('仅滚动令牌')));
});

test('成功续期推进 expires_at 后，下一轮不再重复消耗滚动 token', async () => {
    reset();
    const acc = wxAccount({ expires_at: NOW + 3 * MINUTE });
    mocks.accounts = [acc];
    mocks.running.add('1');
    let calls = 0;
    mocks.tokenImpl = async id => {
        calls++;
        acc.expires_at = NOW + 2 * HOUR;
        return { ok: true, accountId: id, accountName: '微信一号' };
    };
    assert.deepEqual(await ka.runCodePreflight(NOW), ['1']);
    assert.deepEqual(await ka.runCodePreflight(NOW + 6 * MINUTE), [], '已过冷却期仍不触发');
    assert.equal(calls, 1);
});

test('端到端：一天内连续 12 次成功续期仍继续放行，日额度不再被成功耗尽', async () => {
    reset();
    const acc = wxAccount({ expires_at: NOW + 3 * MINUTE });
    mocks.accounts = [acc];
    mocks.running.add('1');
    let calls = 0;
    mocks.tokenImpl = async id => {
        calls++;
        return { ok: true, accountId: id, accountName: '微信一号' };
    };
    for (let i = 0; i < 12; i++) {
        const at = NOW + i * 6 * MINUTE;
        acc.expires_at = at + 3 * MINUTE; // 每轮重新进入 5 分钟续期窗口
        assert.deepEqual(await ka.runCodePreflight(at), ['1'], `第 ${i + 1} 次成功后续期仍应放行`);
    }
    assert.equal(calls, 12, '旧逻辑第 9 次就会被成功次数误熔断');
});

test('onlyIfDue：凭证充足的账号完全不调用续期接口', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 2 * HOUR })];
    mocks.running.add('1');
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
    assert.deepEqual(mocks.tokenCalls, []);
});

test('用户手动停止的账号不会被预防性续期拉起', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 3 * MINUTE })];
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
    assert.deepEqual(mocks.restarts, []);
});

test('仅 loginBuffer、缺少 refreshtoken 的账号跳过滚动续期', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 3 * MINUTE, refreshtoken: '' })];
    mocks.running.add('1');
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
});

test('已被判定需要重新扫码的账号不再按节奏空转', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 3 * MINUTE, wxCredentialNeedsRescan: true })];
    mocks.running.add('1');
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
    assert.deepEqual(mocks.tokenCalls, []);
});

test('续期失败写 auto_code_preflight_failed 并进入退避', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 3 * MINUTE })];
    mocks.running.add('1');
    mocks.tokenImpl = async id => ({ ok: false, accountId: id, accountName: '微信一号', error: '网络超时' });
    assert.deepEqual(await ka.runCodePreflight(NOW), ['1']);
    assert.deepEqual(mocks.restarts, [], '失败不重启账号');
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_preflight_failed'));
    assert.deepEqual(await ka.runCodePreflight(NOW + MINUTE), [], '退避期内不重试');
});

test('凭证被吊销但连接还在线：降级成「仅会话模式」而不是直接判死', async () => {
    reset();
    const acc = wxAccount({ expires_at: NOW + 3 * MINUTE });
    mocks.accounts = [acc];
    mocks.running.add('1');
    mocks.tokenImpl = async id => ({
        ok: false,
        accountId: id,
        accountName: '微信一号',
        error: '微信授权续期失败：code=-109 msg=refresh token revoked',
        needsRescan: true,
    });
    await ka.runCodePreflight(NOW);
    const entry = mocks.printed.find(item => item.msg.includes('仅会话模式'));
    assert.ok(entry, '运行中的账号不应被一条续期失败直接杀掉');
    assert.match(entry.msg, /暂停自动续期/);
});

test('自动续期结果写入账本：成功记 true、失败记 false，供账号卡片展示', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 3 * MINUTE })];
    mocks.running.add('1');
    await ka.runCodePreflight(NOW);
    assert.deepEqual(mocks.preflightResults, [{ id: '1', ok: true, at: NOW }]);

    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 3 * MINUTE })];
    mocks.running.add('1');
    mocks.tokenImpl = async id => ({ ok: false, accountId: id, accountName: '微信一号', error: '网络超时' });
    await ka.runCodePreflight(NOW);
    assert.deepEqual(mocks.preflightResults, [{ id: '1', ok: false, at: NOW }]);
});

test('手动点「续期全部微信授权」走全链路但不重启、不计入无人值守账本', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE })];
    mocks.running.add('1');
    assert.equal(await ka.refreshAndMaybeRestart('1', 'manual', NOW), true);
    assert.deepEqual(mocks.fullCalls, ['1'], '手动续期走 token + buffer + Code 全链路');
    assert.deepEqual(mocks.preflightResults, []);
    assert.deepEqual(mocks.restarts, [], '手动续期本来就不重启账号');
});

test('账本注入函数抛错也不会中断续期', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 3 * MINUTE })];
    mocks.running.add('1');
    ka.startWxKeepAlive({ recordPreflightResult: () => { throw new Error('磁盘满'); } });
    assert.deepEqual(await ka.runCodePreflight(NOW), ['1']);
    assert.deepEqual(mocks.tokenCalls, ['1']);
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_preflight'));
});

test('同一账号续期在途时不会重复触发（inFlight 去重）', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 3 * MINUTE })];
    mocks.running.add('1');
    let release;
    mocks.tokenImpl = () => new Promise((resolve) => {
        release = () => resolve({ ok: true, accountId: '1', accountName: '微信一号' });
    });
    const first = ka.runCodePreflight(NOW);
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
    release();
    assert.deepEqual(await first, ['1']);
});

test('掉线重登：微信优先用 loginBuffer 换 Code（零 OAuth 调用）再重启', async () => {
    reset();
    mocks.accounts = [wxAccount()];
    assert.equal(await ka.refreshAndMaybeRestart('1', 'offline', NOW), true);
    assert.deepEqual(mocks.codeCalls, ['1'], '走按需换码');
    assert.deepEqual(mocks.fullCalls, [], '能用 buffer 就不滚 token');
    assert.deepEqual(mocks.restarts, ['1'], '拿到新 Code 后重启连接');
});

test('掉线重登失败：不重启，原因写进账号日志', async () => {
    reset();
    mocks.accounts = [wxAccount()];
    mocks.codeImpl = async id => ({ ok: false, accountId: id, accountName: '微信一号', error: 'ManualAuth rejected: code=-10 message=ticket expired' });
    assert.equal(await ka.refreshAndMaybeRestart('1', 'offline', NOW), false);
    assert.deepEqual(mocks.restarts, []);
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_refresh_failed' && entry.msg.includes('-10')));
});

test('掉线自愈准入：微信有 loginBuffer 或 refreshtoken 即可，QQ 看 NapCat', () => {
    reset();
    assert.equal(ka.canRecoverAccount(wxAccount()), true);
    assert.equal(ka.canRecoverAccount(wxAccount({ refreshtoken: '' })), true, '只有 loginBuffer 也能直接换 Code');
    assert.equal(ka.canRecoverAccount(wxAccount({ refreshtoken: '', loginBuffer: '' })), false);
    assert.equal(ka.canRecoverAccount(qqAccount()), true, 'QQ 配好 NapCat 即可免扫码重签');

    mocks.qqConfigured = false;
    assert.equal(ka.canRecoverAccount(qqAccount()), false, '未配置 / 不支持重签时不再假装能自愈');
    assert.equal(ka.canRecoverAccount(null), false);
});

test('QQ 账号掉线后也能自动重签 Code 并重新上线（不再只认微信）', async () => {
    reset();
    mocks.accounts = [qqAccount()];
    const calls = [];
    mocks.qqRefreshImpl = async id => {
        calls.push(id);
        return { ok: true, code: 'fresh-code' };
    };
    assert.equal(await ka.refreshAndMaybeRestart('9', 'offline', NOW), true);
    assert.deepEqual(calls, ['9'], 'QQ 走 NapCat 重签');
    assert.deepEqual(mocks.restarts, ['9'], '拿到新 Code 后立刻重启账号');
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_refresh' && entry.msg.includes('QQ 登录 Code 已重签')));
});

test('QQ 重签失败时不重启，并把原因写进账号日志', async () => {
    reset();
    mocks.accounts = [qqAccount()];
    mocks.qqRefreshImpl = async () => ({ ok: false, skipped: true, error: '当前 QQ 授权服务不支持免扫码重签' });
    assert.equal(await ka.refreshAndMaybeRestart('9', 'offline', NOW), false);
    assert.deepEqual(mocks.restarts, []);
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_refresh_failed' && entry.msg.includes('不支持免扫码重签')));
});

test('掉线重登限流：一小时 5 次，超了暂停 30 分钟，暂停期满继续放行', () => {
    reset();
    const attempts = [];
    for (let i = 0; i < 5; i++) attempts.push(ka.reserveReconnectSlot('limit', NOW + i * MINUTE));
    assert.deepEqual(attempts.map(a => a.allowed), [true, true, true, true, true]);
    assert.deepEqual(attempts.map(a => a.attempt), [1, 2, 3, 4, 5]);

    const blocked = ka.reserveReconnectSlot('limit', NOW + 5 * MINUTE);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.state, 'exhausted');
    assert.equal(blocked.remainingPauseMs, ka.RECONNECT_PAUSE_MS);

    const stillPaused = ka.reserveReconnectSlot('limit', NOW + 20 * MINUTE);
    assert.equal(stillPaused.allowed, false);
    assert.equal(stillPaused.state, 'paused', '暂停期内不再重登，也不重复刷「已用满」日志');

    const resumed = ka.reserveReconnectSlot('limit', NOW + 5 * MINUTE + ka.RECONNECT_PAUSE_MS + 1);
    assert.equal(resumed.allowed, true, '暂停期满后重新放行');
    assert.equal(resumed.attempt, 1, '暂停期满后重新起一轮额度，给临时故障一次机会');
});

test('掉线重登限流：窗口滚过 1 小时后计数归零', () => {
    reset();
    for (let i = 0; i < 5; i++) ka.reserveReconnectSlot('roll', NOW + i * MINUTE);
    assert.equal(ka.reserveReconnectSlot('roll', NOW + 5 * MINUTE).allowed, false);
    const afterWindow = ka.reserveReconnectSlot('roll', NOW + ka.RECONNECT_WINDOW_MS + 1);
    assert.equal(afterWindow.allowed, true);
    assert.equal(afterWindow.attempt, 1, '新窗口从 1 重新计数');
});

test('接线断言：预检只滚令牌、只有掉线才重启、登录失败不杀进程', () => {
    const keepAlive = fs.readFileSync(path.join(SRC, 'services/wx-keepalive.ts'), 'utf8');
    const engine = fs.readFileSync(path.join(SRC, 'runtime/runtime-engine.ts'), 'utf8');
    assert.match(keepAlive, /runCodePreflight\(Date\.now\(\)\)/, '巡检入口没变');
    // running 必须在巡检真正结束后才释放。旧写法是 `void runCodePreflight(...)` 之后
    // 立刻在 finally 里置 false，异步还没回来互斥就已经放开了。
    assert.match(keepAlive, /\.finally\(\(\) => \{\s*running = false;\s*\}\)/, 'running 要等巡检结束才释放，否则互斥失效');
    assert.doesNotMatch(keepAlive, /catch\(\(\) => \{\}\)/, '巡检异常不能静默吞掉，至少要落一条日志');
    assert.doesNotMatch(keepAlive, /void refreshAndMaybeRestart\(key, 'offline'\);/, '掉线重登的 Promise 必须带 catch，裸 void 在 Node 20 会带走主进程');
    assert.match(keepAlive, /续期异常/, 'refreshAndMaybeRestart 要把预期外异常收口成一次失败');
    assert.doesNotMatch(keepAlive, /if \(!config\.enabled\) return;/, '预防性续期不能再受定时重登总开关控制');
    assert.doesNotMatch(keepAlive, /intervalMinutes|'timer'|"timer"/, '定时重登的间隔与 reason 必须清空');
    assert.doesNotMatch(keepAlive, /定时重登/, '定时重登文案不得残留');
    assert.match(keepAlive, /renewOAuthToken\(key\)/, '预检走只滚令牌的续期');
    assert.match(keepAlive, /ensureFreshGameCode\(key\)/, '掉线恢复优先用 loginBuffer 直接换 Code');
    assert.match(keepAlive, /reason === 'offline' && typeof deps\.restartWorker === 'function'/, '只有掉线重登才重启连接');
    assert.doesNotMatch(keepAlive, /PREFLIGHT_WINDOW_MS = 45/, '提前 45 分钟续期属于窗口外空打，已废弃');
    assert.match(engine, /startWxKeepAlive\(/);
    assert.match(engine, /startAccountKeepAlive\(\)/);

    const attemptStart = keepAlive.indexOf('recordAttempt(id: string');
    const attemptEnd = keepAlive.indexOf('\n        },', attemptStart);
    const attemptBody = attemptStart > -1 && attemptEnd > attemptStart
        ? keepAlive.slice(attemptStart, attemptEnd)
        : '';
    assert.match(attemptBody, /lastAttemptAt = now/, '尝试仍要记时间做最短间隔防抖');
    assert.doesNotMatch(attemptBody, /failuresToday \+= 1|\.attempts \+= 1/, '开始尝试不能占用日额度');
    assert.match(keepAlive, /state\.failuresToday \+= 1/, '日额度只在续期失败时累加');

    const network = fs.readFileSync(path.join(SRC, 'utils/network.ts'), 'utf8');
    assert.doesNotMatch(network, /process\.exit\(0\)/, '登录失败不能再直接退出进程，否则掉线重登永远收不到信号');
    assert.match(network, /finalizeConnection\(context, \{ source: 'login_failed'/, '走正常的断线收尾');
    assert.match(network, /交由主进程补 Code 后重试登录/);
});

test('Code 失效信号：ws_400（worker 实际写入）与预防续期失败日志均已纳入判定', () => {
    assert.ok(OFFLINE_LOG_ACTIONS.has('ws_400'));
    assert.ok(OFFLINE_LOG_ACTIONS.has('auto_code_preflight_failed'));
    const workerManager = fs.readFileSync(path.join(SRC, 'runtime/worker-manager.ts'), 'utf8');
    assert.match(workerManager, /'ws_400'/);
});

test('续期抛异常时被吸收成一次失败：不冒未处理拒绝，且退避会前进', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + MINUTE })];
    mocks.running = new Set(['1']);
    // 模拟账号文件写入失败这类预期外异常（不是「返回 ok:false」的正常失败）。
    mocks.tokenImpl = () => { throw new Error('账号文件写入失败'); };

    // 不能抛出去：掉线重登那条路径是裸 `void refreshAndMaybeRestart(...)`，
    // 一旦 reject 就是未处理拒绝，Node 20 默认按致命错误处理，主进程直接退出。
    await ka.runCodePreflight(NOW);

    assert.equal(mocks.tokenCalls.length, 1);
    assert.ok(
        mocks.printed.some(item => /续期异常/.test(item.msg)),
        '异常必须落到系统日志，否则会变成看不见的重试循环',
    );
    assert.equal(mocks.logs.length, 1, '异常同样要写一条账号日志');
    assert.equal(mocks.logs[0].action, 'auto_code_preflight_failed');
    assert.deepEqual(mocks.preflightResults, [{ id: '1', ok: false, at: NOW }]);

    mocks.tokenCalls = [];
    await ka.runCodePreflight(NOW);
    assert.equal(mocks.tokenCalls.length, 0, '记了失败之后退避必须生效，不能同一 tick 立刻重试');
});

test('单个账号续期异常不影响同批其它账号', async () => {
    reset();
    mocks.accounts = [
        wxAccount({ id: '1', expires_at: NOW + MINUTE }),
        wxAccount({ id: '2', name: '微信二号', wxid: 'wxid-2', refreshtoken: 'rt-2', expires_at: NOW + MINUTE }),
    ];
    mocks.running = new Set(['1', '2']);
    mocks.tokenImpl = (id) => {
        if (id === '1') throw new Error('账号 1 写盘失败');
        return { ok: true, accountId: id, accountName: '微信二号', codeIssued: false };
    };

    const triggered = await ka.runCodePreflight(NOW);
    assert.deepEqual(triggered.sort(), ['1', '2']);
    assert.equal(mocks.tokenCalls.length, 2, '两个账号都应该被试过');
    assert.deepEqual(
        mocks.preflightResults.map(item => ({ id: item.id, ok: item.ok })).sort((a, b) => a.id.localeCompare(b.id)),
        [{ id: '1', ok: false }, { id: '2', ok: true }],
    );
});
