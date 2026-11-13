const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    ACCOUNT_RUNTIME_STATES,
    STOPPING_STALE_MS,
    setAccountRuntimeState,
    getAccountRuntimeState,
    clearAccountRuntimeState,
    resetAccountRuntimeStates,
} = require('../dist/services/account-runtime-state');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.resolve(ROOT, file), 'utf8');

test.beforeEach(() => resetAccountRuntimeStates());

test('状态集合与前端联合类型逐字一致', () => {
    // 后端多一个少一个，前端 switch 就有一支永远走不到 / 一个状态掉进 default。
    assert.deepEqual([...ACCOUNT_RUNTIME_STATES], [
        'logging_in',
        'relogin_waiting',
        'running',
        'offline',
        'stopping',
        'stopped',
    ]);
    const web = read('../web/src/utils/account-runtime.ts');
    for (const state of ACCOUNT_RUNTIME_STATES) {
        assert.match(web, new RegExp(`'${state}'`), `前端缺少状态 ${state}`);
    }
});

test('状态写入与读取，reloginAt 只在等待重登时保留', () => {
    const now = 1_700_000_000_000;
    assert.equal(setAccountRuntimeState('acc-1', 'relogin_waiting', { reloginAt: now + 60_000, now }), true);
    let entry = getAccountRuntimeState('acc-1', now);
    assert.equal(entry.state, 'relogin_waiting');
    assert.equal(entry.reloginAt, now + 60_000);
    assert.equal(entry.updatedAt, now);

    setAccountRuntimeState('acc-1', 'running', { now });
    entry = getAccountRuntimeState('acc-1', now);
    assert.equal(entry.state, 'running');
    assert.equal(entry.reloginAt, 0, '非等待态必须清掉倒计时，否则前端会算出负秒数');
});

test('非法 id / 非法状态不抛异常也不落库', () => {
    assert.equal(setAccountRuntimeState('', 'running'), false);
    assert.equal(setAccountRuntimeState(null, 'running'), false);
    assert.equal(setAccountRuntimeState('acc-1', 'launching'), false);
    assert.equal(getAccountRuntimeState('acc-1'), null);
    assert.equal(getAccountRuntimeState(''), null);
});

test('onlyFrom 守卫：晚到的「已停止」不会覆盖「等待重登」', () => {
    const now = 1_700_000_000_000;
    // 断开流程真实顺序：stopWorker 写 stopping → 排重登写 relogin_waiting
    setAccountRuntimeState('acc-1', 'stopping', { now });
    setAccountRuntimeState('acc-1', 'relogin_waiting', { reloginAt: now + 60_000, now });
    // 随后子进程 exit 才异步到达，带着 onlyFrom 收尾
    const written = setAccountRuntimeState('acc-1', 'stopped', { onlyFrom: ['stopping', 'logging_in', 'running'], now });
    assert.equal(written, false);
    assert.equal(getAccountRuntimeState('acc-1', now).state, 'relogin_waiting');
});

test('onlyFrom 守卫：正常停止仍能收尾成「已停止」', () => {
    const now = 1_700_000_000_000;
    setAccountRuntimeState('acc-1', 'running', { now });
    setAccountRuntimeState('acc-1', 'stopping', { now });
    const written = setAccountRuntimeState('acc-1', 'stopped', { onlyFrom: ['stopping', 'logging_in', 'running'], now });
    assert.equal(written, true);
    assert.equal(getAccountRuntimeState('acc-1', now).state, 'stopped');
});

test('onlyFrom 守卫：没有记录时不写入', () => {
    assert.equal(setAccountRuntimeState('acc-x', 'stopped', { onlyFrom: ['stopping'] }), false);
    assert.equal(getAccountRuntimeState('acc-x'), null);
});

test('「停止中」超时按「已停止」返回，按钮不会永久置灰', () => {
    const now = 1_700_000_000_000;
    setAccountRuntimeState('acc-1', 'stopping', { now });
    assert.equal(getAccountRuntimeState('acc-1', now + STOPPING_STALE_MS - 1).state, 'stopping');
    assert.equal(getAccountRuntimeState('acc-1', now + STOPPING_STALE_MS + 1).state, 'stopped');
});

test('删除账号后状态随之清空', () => {
    setAccountRuntimeState('acc-1', 'offline');
    assert.equal(clearAccountRuntimeState('acc-1'), true);
    assert.equal(getAccountRuntimeState('acc-1'), null);
    assert.equal(clearAccountRuntimeState('acc-1'), false);
});

test('生命周期写入点在源码里存在（防止重构后状态永不更新）', () => {
    const manager = read('src/runtime/worker-manager.ts');
    // 启动 → 登录中；连上 → 运行中；停止 → 停止中；进程退出 → 已停止/已掉线
    assert.match(manager, /setAccountRuntimeState\(account\.id, 'logging_in'\)/);
    assert.match(manager, /if \(!worker\.stopping\) setAccountRuntimeState\(accountId, 'running'\)/);
    assert.match(manager, /setAccountRuntimeState\(accountId, 'stopping'\)/);
    assert.match(manager, /setAccountRuntimeState\(account\.id, previous && previous\.state === 'stopping' \? 'stopped' : 'offline'/, '崩溃退出不能显示成用户主动停止');
    assert.match(manager, /onlyFrom: \['stopping', 'logging_in', 'running'\]/, '退出收尾必须带状态守卫');

    const keepAlive = read('src/services/wx-keepalive.ts');
    assert.match(keepAlive, /setAccountRuntimeState\(key, 'relogin_waiting', \{ reloginAt: now \+ delayMs \}\)/, '等待重登要带倒计时');
    // 自动重登被闸门挡住 / 没有凭证 / 关掉开关，都必须是「已掉线」而不是「等待重登」
    const offlineWrites = keepAlive.match(/setAccountRuntimeState\(key, 'offline'\)/g) || [];
    assert.ok(offlineWrites.length >= 3, `无法自愈的三条分支都要写已掉线，实际 ${offlineWrites.length} 处`);
    assert.match(keepAlive, /if \(!ok\) setAccountRuntimeState\(key, 'offline'\)/, '重登失败要回落成已掉线');
});

test('接口投影下发 runtimeState / reloginAt，且缺记录时回落 running/stopped', () => {
    const provider = read('src/runtime/data-provider.ts');
    assert.match(provider, /a\.runtimeState = runtime\.state/);
    assert.match(provider, /a\.reloginAt = runtime\.state === 'relogin_waiting' \? runtime\.reloginAt : 0/);
    assert.match(provider, /a\.runtimeState = a\.running \? 'running' : 'stopped'/, '本次进程还没碰过的账号要回落到旧语义');
});

test('手动停止 / 启动 / 重启都会撤掉待执行的重登定时器', () => {
    const provider = read('src/runtime/data-provider.ts');
    const calls = provider.match(/cancelPendingReloginSafe\(/g) || [];
    // 定义 1 处 + 停止 1 处 + 启动 1 处 + 重启 1 处
    assert.ok(calls.length >= 4, `应有三处调用点，实际 ${calls.length}`);
    // 依赖由 runtime-engine 注入：撤销函数自身不能去 require 保活模块。
    // startAccount 会在启动链路上执行，一旦在那里 require，保活模块顶层会把真的
    // 凭证服务提前钉进模块缓存，auto-login-on-boot 里的 Module._load 注入就失效了。
    const helperStart = provider.indexOf('function cancelPendingReloginSafe');
    const helperEnd = provider.indexOf('\n    }', helperStart);
    assert.ok(helperStart > 0 && helperEnd > helperStart, '要能取到撤销函数体');
    const helper = provider.slice(helperStart, helperEnd);
    assert.doesNotMatch(helper, /require\(/);
    assert.match(helper, /cancelPendingRelogin\(accountId\)/);
    const engine = read('src/runtime/runtime-engine.ts');
    assert.match(engine, /cancelPendingRelogin \} = require\('\.\.\/services\/wx-keepalive'\)/);
    assert.match(engine, /cancelPendingRelogin,\n {4}\}\);/, '必须真的注入到 createDataProvider');
    const keepAlive = read('src/services/wx-keepalive.ts');
    assert.match(keepAlive, /function cancelPendingRelogin\(accountId: unknown\): boolean/, '保活侧要导出撤销入口');
    assert.match(keepAlive, /offlineTimers\.delete\(key\)/);
});

// 保持与其他用例一致：孤立跑本文件时也要能看到 1 条断言计数
test('状态机自检：空账本读不到任何账号', () => {
    resetAccountRuntimeStates();
    assert.equal(getAccountRuntimeState('nobody'), null);
});
