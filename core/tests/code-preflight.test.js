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
    refreshImpl: null,
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
    refreshAccountCredential: async id => mocks.refreshImpl(id),
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
    mocks.qqConfigured = true;
    mocks.refreshImpl = async id => ({ ok: true, accountId: id, accountName: '微信一号' });
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

test('移植老版本阈值：45 分钟窗口 / 当日失败 8 次 / 连续 3 次 / 冷却 5 分钟', () => {
    assert.equal(ka.PREFLIGHT_WINDOW_MS, 45 * MINUTE);
    assert.equal(ka.MAX_DAILY_PREFLIGHT_FAILURES, 8, '日额度只统计失败次数');
    assert.equal(ka.MAX_CONSECUTIVE_FAILURES, 3);
    assert.equal(ka.PREFLIGHT_RETRY_MS, 5 * MINUTE);
});

test('isCredentialDue：凭证充足不刷，到期前 45 分钟 / 已过期 / 无到期信息才刷', () => {
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW + 2 * HOUR }), NOW), false);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW + 50 * MINUTE }), NOW), false);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW + 45 * MINUTE }), NOW), true);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW + 10 * MINUTE }), NOW), true);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: NOW - MINUTE }), NOW), true);
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: 0, wxCredentialRefreshedAt: 0 }), NOW), true);
    // 秒级到期时间戳也要兼容（老数据可能由外部写成秒）
    assert.equal(ka.isCredentialDue(wxAccount({ expires_at: (NOW + 2 * HOUR) / 1000 }), NOW), false);
});

test('governor：失败 5 分钟冷却、连续 3 次熔断、成功清零且不占额度', () => {
    const g = ka.createPreflightGovernor(() => NOW);
    assert.equal(g.canAttempt('x', NOW), true);
    g.recordAttempt('x', NOW);
    g.recordFailure('x', '网络超时', NOW);
    assert.equal(g.canAttempt('x', NOW + MINUTE), false, '冷却期内不重复打续期接口');
    assert.equal(g.canAttempt('x', NOW + 5 * MINUTE), true);

    g.recordAttempt('x', NOW + 5 * MINUTE);
    g.recordFailure('x', '网络超时', NOW + 5 * MINUTE);
    g.recordSuccess('x', NOW + 5 * MINUTE + 1);
    assert.equal(g.snapshot('x', NOW + 5 * MINUTE + 1).failures, 0, '成功后连续失败计数清零');
    assert.equal(g.snapshot('x', NOW + 5 * MINUTE + 1).failuresToday, 2, '成功不占日额度，仍只记 2 次失败');

    g.recordAttempt('x', NOW + 11 * MINUTE);
    g.recordFailure('x', '网络超时', NOW + 11 * MINUTE);
    g.recordAttempt('x', NOW + 17 * MINUTE);
    g.recordFailure('x', '网络超时', NOW + 17 * MINUTE);
    g.recordAttempt('x', NOW + 23 * MINUTE);
    g.recordFailure('x', '网络超时', NOW + 23 * MINUTE);
    assert.equal(g.canAttempt('x', NOW + 30 * MINUTE), false, '连续 3 次失败熔断');
});

test('governor：凭证明确失效直接熔断，UTC+8 换日后重新放行', () => {
    const g = ka.createPreflightGovernor(() => NOW);
    g.recordAttempt('y', NOW);
    g.recordFailure('y', '凭证已失效，请重新扫码登录', NOW);
    assert.equal(g.canAttempt('y', NOW + 6 * MINUTE), false, '当天不再重试');
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

test('后端自主：掉线重登默认开启，到期账号仍会续期并重启', async () => {
    reset();
    const acc = wxAccount({ expires_at: NOW + 20 * MINUTE });
    mocks.accounts = [acc];
    mocks.running.add('1');
    mocks.refreshImpl = async id => {
        acc.expires_at = NOW + 2 * HOUR + 20 * MINUTE; // 模拟滚动续期写回新到期时间
        return { ok: true, accountId: id, accountName: '微信一号' };
    };
    assert.equal(ka.getConfig().offlineEnabled, true, '系统配置默认开启掉线重登（只在掉线后动作）');
    assert.equal('enabled' in ka.getConfig(), false, '定时重登开关已整体移除');
    assert.deepEqual(await ka.runCodePreflight(NOW), ['1']);
    assert.deepEqual(mocks.restarts, ['1'], '运行中账号立刻用新 Code 重新上线');
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_preflight'));
    assert.ok(mocks.printed.some(entry => entry.msg.includes('到期前预防性续期常开')));
});

test('成功续期推进 expires_at 后，下一轮不再重复消耗滚动 token', async () => {
    reset();
    const acc = wxAccount({ expires_at: NOW + 20 * MINUTE });
    mocks.accounts = [acc];
    mocks.running.add('1');
    let calls = 0;
    mocks.refreshImpl = async id => {
        calls++;
        acc.expires_at = NOW + 2 * HOUR + 20 * MINUTE;
        return { ok: true, accountId: id, accountName: '微信一号' };
    };
    assert.deepEqual(await ka.runCodePreflight(NOW), ['1']);
    assert.deepEqual(await ka.runCodePreflight(NOW + 6 * MINUTE), [], '已过冷却期仍不触发');
    assert.equal(calls, 1);
});

test('端到端：一天内连续 12 次成功续期仍继续放行，日额度不再被成功耗尽', async () => {
    reset();
    const acc = wxAccount({ expires_at: NOW + 20 * MINUTE });
    mocks.accounts = [acc];
    mocks.running.add('1');
    let calls = 0;
    mocks.refreshImpl = async id => {
        calls++;
        return { ok: true, accountId: id, accountName: '微信一号' };
    };
    for (let i = 0; i < 12; i++) {
        const at = NOW + i * 6 * MINUTE;
        acc.expires_at = at + 10 * MINUTE; // 每轮重新进入 45 分钟预警窗口
        assert.deepEqual(await ka.runCodePreflight(at), ['1'], `第 ${i + 1} 次成功后续期仍应放行`);
    }
    assert.equal(calls, 12, '旧逻辑第 9 次就会被成功次数误熔断');
});

test('onlyIfDue：凭证充足的账号完全不调用续期接口', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 2 * HOUR })];
    mocks.running.add('1');
    let calls = 0;
    mocks.refreshImpl = async id => { calls++; return { ok: true, accountId: id, accountName: '微信一号' }; };
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
    assert.equal(calls, 0);
});

test('用户手动停止的账号不会被预防性续期拉起', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE })];
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
    assert.deepEqual(mocks.restarts, []);
});

test('仅 loginBuffer、缺少 refreshtoken 的账号跳过滚动续期', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE, refreshtoken: '' })];
    mocks.running.add('1');
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
});

test('续期失败写 auto_code_preflight_failed 并进入 5 分钟冷却', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE })];
    mocks.running.add('1');
    mocks.refreshImpl = async id => ({ ok: false, accountId: id, accountName: '微信一号', error: '网络超时' });
    assert.deepEqual(await ka.runCodePreflight(NOW), ['1']);
    assert.deepEqual(mocks.restarts, [], '失败不重启账号');
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_preflight_failed'));
    assert.deepEqual(await ka.runCodePreflight(NOW + MINUTE), [], '冷却期内不重试');
});

test('自动续期结果写入账本：成功记 true、失败记 false，供账号卡片展示', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE })];
    mocks.running.add('1');
    await ka.runCodePreflight(NOW);
    assert.deepEqual(mocks.preflightResults, [{ id: '1', ok: true, at: NOW }]);

    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE })];
    mocks.running.add('1');
    mocks.refreshImpl = async id => ({ ok: false, accountId: id, accountName: '微信一号', error: '网络超时' });
    await ka.runCodePreflight(NOW);
    assert.deepEqual(mocks.preflightResults, [{ id: '1', ok: false, at: NOW }]);
});

test('手动点「续期全部微信授权」不计入无人值守账本', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE })];
    mocks.running.add('1');
    assert.equal(await ka.refreshAndMaybeRestart('1', 'manual', NOW), true);
    assert.deepEqual(mocks.preflightResults, []);
    assert.deepEqual(mocks.restarts, [], '手动续期本来就不重启账号');
});

test('账本注入函数抛错也不会中断续期与重启', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE })];
    mocks.running.add('1');
    ka.startWxKeepAlive({ recordPreflightResult: () => { throw new Error('磁盘满'); } });
    assert.deepEqual(await ka.runCodePreflight(NOW), ['1']);
    assert.deepEqual(mocks.restarts, ['1']);
    assert.ok(mocks.logs.some(entry => entry.action === 'auto_code_preflight'));
});

test('同一账号续期在途时不会重复触发（inFlight 去重）', async () => {
    reset();
    mocks.accounts = [wxAccount({ expires_at: NOW + 10 * MINUTE })];
    mocks.running.add('1');
    let release;
    mocks.refreshImpl = () => new Promise((resolve) => {
        release = () => resolve({ ok: true, accountId: '1', accountName: '微信一号' });
    });
    const first = ka.runCodePreflight(NOW);
    assert.deepEqual(await ka.runCodePreflight(NOW), []);
    release();
    assert.deepEqual(await first, ['1']);
});

test('接线断言：定时重登链路已移除，预防通道常开且定时器由 runtime-engine 启动', () => {
    const keepAlive = fs.readFileSync(path.join(SRC, 'services/wx-keepalive.ts'), 'utf8');
    const engine = fs.readFileSync(path.join(SRC, 'runtime/runtime-engine.ts'), 'utf8');
    assert.match(keepAlive, /void runCodePreflight\(Date\.now\(\)\)\.catch/);
    assert.doesNotMatch(keepAlive, /if \(!config\.enabled\) return;/, '预防性续期不能再受定时重登总开关控制');
    assert.doesNotMatch(keepAlive, /intervalMinutes|'timer'|"timer"/, '定时重登的间隔与 reason 必须清空');
    assert.doesNotMatch(keepAlive, /定时重登/, '定时重登文案不得残留');
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
});

test('Code 失效信号：ws_400（worker 实际写入）与预防续期失败日志均已纳入判定', () => {
    assert.ok(OFFLINE_LOG_ACTIONS.has('ws_400'));
    assert.ok(OFFLINE_LOG_ACTIONS.has('auto_code_preflight_failed'));
    const workerManager = fs.readFileSync(path.join(SRC, 'runtime/worker-manager.ts'), 'utf8');
    assert.match(workerManager, /'ws_400'/);
});

test('掉线自愈准入：微信看滚动凭证，QQ 看 NapCat 重签服务是否可用', () => {
    reset();
    assert.equal(ka.canRecoverAccount(wxAccount()), true);
    assert.equal(ka.canRecoverAccount(wxAccount({ refreshtoken: '' })), false, '只有 loginBuffer 的微信账号不能滚动续期');
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

test('登录失败不再直接杀进程：交给主进程补 Code 后重登', () => {
    const network = fs.readFileSync(path.join(SRC, 'utils/network.ts'), 'utf8');
    assert.doesNotMatch(network, /process\.exit\(0\)/, '登录失败不能再直接退出进程，否则掉线重登永远收不到信号');
    assert.match(network, /finalizeConnection\(context, \{ source: 'login_failed'/, '走正常的断线收尾');
    assert.match(network, /交由主进程补 Code 后重试登录/);

    const keepAlive = fs.readFileSync(path.join(SRC, 'services/wx-keepalive.ts'), 'utf8');
    assert.doesNotMatch(keepAlive, /if \(!hasWxCredential\(account\)\) return;/, '掉线重登不能再拿微信凭证当准入门槛');
    assert.match(keepAlive, /canRecoverAccount\(account\)/, '准入条件改为「能否免扫码恢复」');
    assert.match(keepAlive, /request === '\.\/qq-credential'|require\('\.\/qq-credential'\)/);
});
