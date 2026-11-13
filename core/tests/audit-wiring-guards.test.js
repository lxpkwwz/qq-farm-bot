const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.resolve(ROOT, file), 'utf8');

test('化肥自动购买定时器随配置下发重建（否则登录后打开开关永远不生效）', () => {
    const worker = read('src/core/worker.ts');
    const barreled = read('src/services/farm/index.ts');
    const scheduler = read('src/services/farm/scheduler.ts');

    assert.match(worker, /startFertilizerBuyCheckTimer/, 'worker 必须引入化肥定时器');
    const syncBlock = worker.slice(worker.indexOf('startMysteryShopTimer();', worker.lastIndexOf('hasAutomationPayload')));
    assert.match(syncBlock, /startFertilizerBuyCheckTimer\(\)/, '配置下发路径必须重建化肥定时器');
    assert.match(barreled, /startFertilizerBuyCheckTimer: scheduler\.startFertilizerBuyCheckTimer/);

    // 重建必须按「开关 + 间隔」去重：每次都重置计时会让巡检永远等不到触发
    assert.match(scheduler, /fertilizerTimerSignature/, '缺少生效签名');
    assert.match(scheduler, /if \(signature === fertilizerTimerSignature && farmScheduler\.has\('fertilizer_buy_check'\)\) return;/);
});

test('好友帮忙的经验闸门在缺少限制数据时放行，不能自锁', () => {
    const scheduler = read('src/services/friend/scheduler.ts');
    const body = scheduler.slice(
        scheduler.indexOf('export function canGetExp('),
        scheduler.indexOf('export function canOperate('),
    );
    assert.match(body, /if \(!limit\) return true;/, '没有 operation_limits 时必须放行（与 canOperate 同口径）');
    assert.doesNotMatch(body, /if \(!limit\) return false;/, '判 false 会让只开「帮忙」的配置永久自锁');
});

test('好友宠物同步遇到瞬时失败不标记当日完成', () => {
    const source = read('src/services/friend/pet-sync.ts');
    assert.match(source, /if \(deferred === 0 && failed === 0\) markFullSyncDone\(\);/);
    assert.match(source, /type ProbeOutcome = 'ok' \| 'invalid' \| 'failed' \| 'yield';/);
    assert.match(source, /if \(handled\.handled\) return 'invalid';/, '已失效/已拉黑要与瞬时失败区分开');
});

test('拜访好友主路径用 finally 兜底 Leave，异常也不会留在别人农场里', () => {
    const source = read('src/services/friend/visit-strategy.ts');
    const start = source.indexOf('export async function visitFriend(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.match(body, /\} finally \{[\s\S]*leaveFriendFarm\(gid\)[\s\S]*\}/, 'Leave 必须放在 finally 里');
    // Leave 只该由 finally 发一次，正常路径不要再额外发
    assert.equal((body.match(/await leaveFriendFarm\(gid\)/g) || []).length, 2,
        '预期两处：空快照早退 + finally；多出来的会让同一次拜访重复 Leave');
});

test('清理过期预留组时只释放确实不合格的组，不误伤别的种子', () => {
    const source = read('src/services/farm/planting.ts');
    assert.match(source, /getLayoutClearMetrics/);
    assert.match(source, /if \(groupOccupants\.size === 0 \|\| !isQualifiedForWaiting\(metrics, nowSec\)\) \{/,
        '必须逐组用真实占用者重算后再释放');
});

test('QQ 取码写盘前比对返回的 uin，防止串号', () => {
    const source = read('src/services/qq-credential.ts');
    const guardIndex = source.indexOf('const issuedUin: string = normalizeUin(data?.uin);');
    const writeIndex = source.indexOf("store.addOrUpdateAccount({ id: String(account.id), code })");
    assert.ok(guardIndex > 0, '缺少 uin 守卫');
    assert.ok(writeIndex > guardIndex, 'uin 校验必须发生在写盘之前');
    assert.match(source, /function normalizeUin\(/, 'uin 归一化（数字 + 去前导 0）缺失');
    assert.match(source, /function maskUin\(/, '错误信息里不应带完整 QQ 号');
});

test('降级日志同样受体积上限约束', () => {
    const source = read('src/services/logger.ts');
    const body = source.slice(source.indexOf('function ensureFallbackLogDir('), source.indexOf('function appendFallbackLog('));
    assert.match(body, /startLogSizeGuard\(dir,/, 'winston 加载失败时的 appendFileSync 也必须限体积');
});

test('原子写补上 fsync，临时文件名带随机后缀', () => {
    const source = read('src/services/json-db.ts');
    const body = source.slice(source.indexOf('function writeTextFileAtomic('), source.indexOf('module.exports'));
    assert.match(body, /fs\.fsyncSync\(fd\)/, 'rename 前不 fsync 会写出 0 字节的「新」文件');
    assert.match(body, /Math\.random\(\)\.toString\(36\)/, 'pid + 毫秒在同一毫秒内会撞名');
});

test('面板状态归一化收敛负数与 Infinity', () => {
    const source = read('src/runtime/runtime-state.ts');
    assert.match(source, /Number\.isFinite\(n\) && n >= 0 \? n : 0/);
});

test('保存设置不会把活动自动化 / 神秘商人的巡检周期清零', () => {
    const worker = read('src/core/worker.ts');

    const activityStart = worker.slice(worker.indexOf('function startActivityAutomationTimer('));
    const activityBody = activityStart.slice(0, activityStart.indexOf('\n}\n'));
    assert.match(activityBody, /if \(workerScheduler\.has\('activity_automation_interval'\)\) return;/,
        '已注册就不要重建：setIntervalTask 会先 clear 再注册，等于每次保存都把 5 分钟推后一轮');

    const mysteryStart = worker.slice(worker.indexOf('function startMysteryShopTimer('));
    const mysteryBody = mysteryStart.slice(0, mysteryStart.indexOf('\n}\n'));
    assert.match(mysteryBody, /if \(workerScheduler\.has\('mystery_shop_interval'\)\) return;/,
        '神秘商人巡查同样不能每保存一次就重置 10 分钟周期');
    // 关掉开关时必须真的停，不能被去重分支挡住
    assert.ok(mysteryBody.indexOf('stopMysteryShopTimer();') < mysteryBody.indexOf("has('mystery_shop_interval')"),
        '停用分支要在去重之前，否则关掉开关定时器还在跑');
});

test('停机 / 切号时活动自动化的主循环定时器也会被清掉', () => {
    const source = read('src/services/activity-automation.ts');
    const stopBody = source.slice(source.indexOf('function stopActivityAutomation('));
    const body = stopBody.slice(0, stopBody.indexOf('\n}\n'));
    assert.match(body, /workerSchedulerRef\.clear\('activity_automation_interval'\)/,
        '漏清主循环会让 stop 之后每个周期仍按旧账号的开关跑一轮');
    assert.match(body, /clearTimeout\(fallbackInitialTimer\)/,
        '降级通道那条 10 秒首跑的句柄必须能取消');
    // 注册与清理要成对出现
    assert.match(source, /setIntervalTask\('activity_automation_interval'/);
    assert.match(source, /fallbackInitialTimer = initial;/);
});
