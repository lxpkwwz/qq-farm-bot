const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const src = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
const worker = src('core/worker.ts');
const farmScheduler = src('services/farm/scheduler.ts');
const farmIndex = src('services/farm/index.ts');
const ownMaturitySrc = src('services/farm/own-maturity.ts');
const automationLock = src('services/automation-lock.ts');

const maturity = require('../dist/services/farm/own-maturity');
const utils = require('../dist/utils/utils');
const { runExclusiveAutomationTask } = require('../dist/services/automation-lock');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function bodyOf(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    assert.ok(start > 0, `找不到 ${startMarker}`);
    const end = text.indexOf(endMarker, start);
    assert.ok(end > start, `找不到 ${endMarker}`);
    return text.slice(start, end);
}

// ============ 真跑：自家成熟计划 ============

test('成熟墙钟归一化：绝对秒 / 毫秒 / 相对倒计时 / 非法值', () => {
    const nowSec = 1_700_000_000;
    assert.equal(maturity.toAbsoluteTimeSec(1_700_000_500, nowSec), 1_700_000_500);
    assert.equal(maturity.toAbsoluteTimeSec(1_700_000_500_000, nowSec), 1_700_000_500);
    assert.equal(maturity.toAbsoluteTimeSec(300, nowSec), nowSec + 300);
    assert.equal(maturity.toAbsoluteTimeSec(0, nowSec), 0);
    assert.equal(maturity.toAbsoluteTimeSec('abc', nowSec), 0);
    assert.equal(maturity.toAbsoluteTimeSec(null, nowSec), 0);
});

test('多块地取最近的成熟时刻，忽略非成熟阶段与已过期的墙钟', () => {
    const nowSec = 1_700_000_000;
    const lands = [
        { plant: { phases: [{ phase: 6, begin_time: nowSec + 600 }] } },
        { plant: { phases: [{ phase: 2, begin_time: nowSec + 5 }] } },
        { plant: { phases: [{ phase_id: 19, begin_time: nowSec + 120 }] } },
        { plant: { phases: [{ phase: 6, begin_time: nowSec - 10 }] } },
    ];
    assert.equal(maturity.findNearestOwnMaturityAt(lands, nowSec), nowSec + 120);
    assert.equal(maturity.findNearestOwnMaturityAt(null, nowSec), 0);
    assert.equal(maturity.findNearestOwnMaturityAt([{ plant: null }], nowSec), 0);
});

test('整片快照登记成熟点；局部推送只收紧不清空；整片无成熟点时旧计划作废', () => {
    maturity.resetOwnFarmMaturity();
    const nowSec = Math.floor(Date.now() / 1000);
    const makeLands = sec => [{ plant: { phases: [{ phase: 6, begin_time: sec }] } }];

    maturity.observeOwnFarmMaturity(makeLands(nowSec + 600), 'round');
    const firstDelayMs = maturity.getOwnFarmMaturityDelayMs(Date.now());
    assert.ok(firstDelayMs > 590_000 && firstDelayMs <= 601_000, `首次计划应约 600 秒，实际 ${firstDelayMs}`);

    // 局部推送带来更晚的点：不能把已算出的更早成熟点抹掉。
    maturity.observeOwnFarmMaturity(makeLands(nowSec + 900), 'push');
    assert.ok(maturity.getOwnFarmMaturityDelayMs(Date.now()) > 590_000, '推送不能把计划推后');

    // 局部推送带来更早的点：收紧。
    maturity.observeOwnFarmMaturity(makeLands(nowSec + 60), 'push');
    assert.ok(maturity.getOwnFarmMaturityDelayMs(Date.now()) < 61_000, '更早的成熟点要生效');

    maturity.observeOwnFarmMaturity([{ plant: null }], 'round');
    assert.equal(maturity.getOwnFarmMaturityDelayMs(Date.now()), 0, '整片快照无成熟点要清掉旧计划');
    maturity.resetOwnFarmMaturity();
});

test('成熟点过了宽限期就作废，不会把唤醒永久钉在最小值', () => {
    maturity.resetOwnFarmMaturity();
    maturity.setOwnFarmMatureAtForTest(Math.floor(Date.now() / 1000) + 5);
    assert.ok(maturity.getOwnFarmMaturityDelayMs(Date.now()) > 0);
    maturity.setOwnFarmMatureAtForTest(Math.floor(Date.now() / 1000) - 120);
    assert.equal(maturity.getOwnFarmMaturityDelayMs(Date.now()), 0);
    assert.equal(maturity.getOwnFarmMaturityDelayMs(Date.now()), 0, '作废后要清零而不是每次重算');
    maturity.resetOwnFarmMaturity();
});

test('成熟延迟按服务器时间计算，不受本地时钟偏移影响', () => {
    // 复现「服务器时钟与本地时钟不一致」：syncServerTime 本就是为这种偏移存在的。
    // 旧写法用 matureAtSec*1000 减本地 Date.now()，会把整段偏移当成还要等多久。
    maturity.resetOwnFarmMaturity();
    const localNow = Date.now();
    const SERVER_AHEAD_MS = 30 * 1000; // 服务器比本地快 30 秒
    utils.syncServerTime(localNow + SERVER_AHEAD_MS);
    const serverNowSec = utils.getServerTimeSec();
    maturity.setOwnFarmMatureAtForTest(serverNowSec + 10); // 服务器视角下 10 秒后成熟
    const delay = maturity.getOwnFarmMaturityDelayMs();
    assert.ok(Math.abs(delay - 10_000) < 2000, `应按服务器时间差算约 10 秒，实际 ${delay}`);
    assert.ok(delay < 20_000, '不能把本地与服务器的 30 秒偏移当成还要等约 40 秒');
    utils.syncServerTime(Date.now()); // 还原，避免污染同文件其它用例
    maturity.resetOwnFarmMaturity();
});

test('立刻补跑一分钟最多三次，且消费一次就清空', () => {
    maturity.resetOwnFarmMaturity();
    const reasons = [];
    for (let i = 0; i < 5; i++) {
        maturity.requestFarmWakeup(`reason-${i}`);
        reasons.push(maturity.consumeFarmWakeup());
    }
    assert.equal(reasons.filter(Boolean).length, 3, '窗口内最多放行三次');
    assert.equal(maturity.consumeFarmWakeup(), null, '同一条请求不能被消费两次');
    maturity.resetOwnFarmMaturity();
});

// ============ 真跑：worker 的下一次农场到期线 ============

const plannerSrc = bodyOf(worker, 'function planNextFarmRun(nowMs: number, farmMs: number): number {', '\nfunction resetUnifiedSchedule')
    .replace('function planNextFarmRun(nowMs: number, farmMs: number): number', 'function planNextFarmRun(nowMs, farmMs)');

function makePlanner({ wakeReason = null, maturityDelayMs = 0 } = {}) {
    const sandbox = {
        consumeFarmWakeup: () => wakeReason,
        getOwnFarmMaturityDelayMs: () => maturityDelayMs,
        logFileOnly: () => {},
        FARM_MATURITY_WAKE_BUFFER_MS: 1500,
        FARM_WAKEUP_IMMEDIATE_MS: 200,
        Number,
        Math,
    };
    vm.runInNewContext(`${plannerSrc}\nglobalThis.planNextFarmRun = planNextFarmRun;`, sandbox);
    return sandbox.planNextFarmRun;
}

test('没有成熟计划时仍按常规 20~25 秒轮询', () => {
    const now = 1_000_000;
    assert.equal(makePlanner()(now, 22_000), now + 22_000);
});

test('作物比常规轮询先熟时，到期线提前到成熟点 + 缓冲', () => {
    const now = 1_000_000;
    assert.equal(makePlanner({ maturityDelayMs: 5_000 })(now, 22_000), now + 6_500);
});

test('作物比常规轮询晚熟时，常规轮询兜底，不会被推后', () => {
    const now = 1_000_000;
    assert.equal(makePlanner({ maturityDelayMs: 60_000 })(now, 22_000), now + 22_000);
});

test('脏标记 / 收获失败的补跑优先于成熟点，且不会排到 1 秒以内空转', () => {
    const now = 1_000_000;
    assert.equal(makePlanner({ wakeReason: 'lands_push', maturityDelayMs: 5_000 })(now, 22_000), now + 200);
    assert.equal(makePlanner({ maturityDelayMs: 0 })(now, 500), now + 1000);
});

// ============ 真跑：自动化锁的优先级与排队超时 ============

test('高优先任务插到低优先队列之前，但不打断正在执行的任务', async () => {
    const order = [];
    const blocker = runExclusiveAutomationTask('blocker', async () => {
        order.push('blocker-start');
        await delay(25);
        order.push('blocker-end');
    });
    const low1 = runExclusiveAutomationTask('low-1', () => { order.push('low-1'); });
    const low2 = runExclusiveAutomationTask('low-2', () => { order.push('low-2'); });
    const high = runExclusiveAutomationTask('high', () => { order.push('high'); }, { priority: true });
    await Promise.all([blocker, low1, low2, high]);
    assert.deepEqual(order, ['blocker-start', 'blocker-end', 'high', 'low-1', 'low-2']);
});

test('排队等锁超时会跳过本轮，不会执行已经过期的任务体', async () => {
    let ran = false;
    const blocker = runExclusiveAutomationTask('slow', () => delay(70));
    const skipped = await runExclusiveAutomationTask('skipped', () => { ran = true; return 'ran'; }, { timeoutMs: 15 });
    assert.equal(skipped, undefined);
    await blocker;
    await delay(10);
    assert.equal(ran, false);
});

test('已经开始执行的任务不受 timeoutMs 影响', async () => {
    const value = await runExclusiveAutomationTask('fast', () => 'ok', { timeoutMs: 40 });
    assert.equal(value, 'ok');
    await delay(50);
});

test('超时跳过后锁队列仍然可用，后续任务不会被卡死', async () => {
    const blocker = runExclusiveAutomationTask('hold', () => delay(60));
    await runExclusiveAutomationTask('will-timeout', () => 'never', { timeoutMs: 10 });
    await blocker;
    const after = await runExclusiveAutomationTask('after-timeout', () => 'ok');
    assert.equal(after, 'ok');
});

// ============ 静态锁：防止以后被改回旧写法 ============

test('worker 两条农场到期线都走 planNextFarmRun，不再直接写死常规间隔', () => {
    assert.match(worker, /function planNextFarmRun\(/);
    assert.match(worker, /getOwnFarmMaturityDelayMs/);
    assert.match(worker, /consumeFarmWakeup/);
    assert.doesNotMatch(worker, /nextFarmRunAt = now \+ farmMs/);
    assert.doesNotMatch(worker, /nextFarmRunAt = Date\.now\(\) \+ farmMs/);
    const resetBody = bodyOf(worker, 'function resetUnifiedSchedule', '\nconst BUSINESS_TICK_LABEL');
    assert.match(resetBody, /nextFarmRunAt = planNextFarmRun\(now, farmMs\)/);
    const farmTickBody = bodyOf(worker, 'async function runFarmTick', '\n// ============ 帮助 Tick');
    assert.match(farmTickBody, /nextFarmRunAt = planNextFarmRun\(Date\.now\(\), farmMs\)/);
});

test('农场 tick 带优先级与等锁超时；好友 / 偷菜 tick 仍不套锁', () => {
    const tickBody = bodyOf(worker, 'async function runUnifiedTick', '\nfunction scheduleUnifiedNextTick');
    const farmCall = bodyOf(tickBody, "runExclusiveAutomationTask('farm_tick'", '\n    if (!unifiedSchedulerRunning');
    assert.match(farmCall, /priority: true/);
    assert.match(farmCall, /timeoutMs: FARM_TICK_LOCK_WAIT_MS/);
    assert.doesNotMatch(tickBody, /runExclusiveAutomationTask\(\s*'friend_tick'/);
    assert.doesNotMatch(tickBody, /runExclusiveAutomationTask\(\s*'steal_tick'/);
});

test('两类推送拆开节流时间戳与计时器名，不再互相挤掉', () => {
    assert.match(farmScheduler, /lastLandsPushTime/);
    assert.match(farmScheduler, /lastSocialPushTime/);
    assert.doesNotMatch(farmScheduler, /let lastPushTime\b/, '不能再用单变量给两类推送节流');
    assert.match(farmScheduler, /'farm_push_check_lands'/);
    assert.match(farmScheduler, /'farm_push_check_social'/);
    assert.doesNotMatch(farmScheduler, /setTimeoutTask\('farm_push_check',/);
});

test('巡查中到达的推送改成脏标记，不再无声丢弃', () => {
    assert.match(farmScheduler, /function markFarmPushDuringCheck/);
    const landsBody = bodyOf(farmScheduler, 'function onLandsChangedPush', '\nfunction onFarmSocialEventsChangedPush');
    const socialBody = bodyOf(farmScheduler, 'function onFarmSocialEventsChangedPush', '\nfunction stopFarmCheckLoop');
    for (const body of [landsBody, socialBody]) {
        assert.match(body, /if \(isCheckingFarm\) \{/);
        assert.match(body, /markFarmPushDuringCheck\(/);
    }
    assert.match(landsBody, /observeOwnFarmMaturity\(lands, 'push'\)/);
});

test('配置下发在统一调度器模式下能叫醒农场线', () => {
    const refreshBody = bodyOf(farmScheduler, 'function refreshFarmCheckLoop', '\n// ============ 化肥自动购买定时检测');
    assert.match(refreshBody, /if \(externalSchedulerMode\)/);
    assert.match(refreshBody, /requestFarmWakeup\('config_sync'\)/);
    assert.match(farmIndex, /getOwnFarmMaturityDelayMs: scheduler\.getOwnFarmMaturityDelayMs/);
    assert.match(farmIndex, /consumeFarmWakeup: scheduler\.consumeFarmWakeup/);
});

test('整轮软预算、收获失败重试与成熟计划观察都已接线', () => {
    assert.match(farmScheduler, /FARM_ROUND_BUDGET_MS/);
    assert.match(farmScheduler, /const overBudget = /);
    assert.equal((farmScheduler.match(/if \(overBudget\(\)\) return/g) || []).length, 3, '三个阶段边界都要有预算检查');
    assert.match(farmScheduler, /deadlineMs: Date\.now\(\) \+ FARM_ROUND_BUDGET_MS/);
    assert.match(farmScheduler, /observeOwnFarmMaturity\(lands, 'round'\)/);
    assert.match(farmScheduler, /requestFarmWakeup\('harvest_failed'\)/);
    assert.match(farmScheduler, /requestFarmWakeup\('budget_exceeded'\)/);
    assert.match(farmScheduler, /resetOwnFarmMaturity\(\)/);
});

test('成熟计划自带宽限期与补跑限流，锁自带优先级与超时参数', () => {
    assert.match(ownMaturitySrc, /MATURITY_GRACE_MS/);
    assert.match(ownMaturitySrc, /WAKEUP_MAX_PER_WINDOW/);
    assert.match(automationLock, /priority\?: boolean/);
    assert.match(automationLock, /timeoutMs\?: number/);
    assert.match(automationLock, /queue\.splice\(insertAt, 0, item\)/);
    assert.match(automationLock, /const index = queue\.indexOf\(item\)/);
});
