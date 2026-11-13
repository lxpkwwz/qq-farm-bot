/**
 * 请求班次的环境上下文。
 *
 * 后台定时任务和面板请求走同一个网络层，靠 AsyncLocalStorage 在任务入口打一次标记，
 * 让任务内部发出的所有请求自动继承班次（否则后台任务会占用前台的在途预算）。
 *
 * 这套机制的两个失效模式都是「静默降级」，很难从现象上发现：
 *   1. 上下文没传进去 → 全部按前台处理 → 后台任务把前台预算吃光，面板变慢；
 *   2. 上下文串了 → 前台请求被当成后台 → 用户点一下要排队等定时任务。
 * 所以这里同时锁「继承」和「隔离」两个方向。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { runWithRequestClass, getAmbientRequestClass, classForSchedulerNamespace } = require('../dist/utils/request-context');

// ============ 环境班次 ============

test('没有被包裹时没有环境班次（调用方按前台处理）', () => {
    assert.equal(getAmbientRequestClass(), null);
});

test('包裹内可以读到班次，包裹结束后恢复为空', () => {
    const inside = runWithRequestClass('farm', () => getAmbientRequestClass());
    assert.equal(inside, 'farm');
    assert.equal(getAmbientRequestClass(), null, '离开作用域必须清干净，不能泄漏给后续请求');
});

test('包裹会原样返回回调的返回值', () => {
    assert.equal(runWithRequestClass('friend', () => 42), 42);
    assert.deepEqual(runWithRequestClass('background', () => ({ ok: true })), { ok: true });
});

test('嵌套时内层覆盖外层，内层结束后外层仍然生效', () => {
    const trace = runWithRequestClass('farm', () => {
        const outer = getAmbientRequestClass();
        const inner = runWithRequestClass('friend', () => getAmbientRequestClass());
        const afterInner = getAmbientRequestClass();
        return { outer, inner, afterInner };
    });

    assert.deepEqual(trace, { outer: 'farm', inner: 'friend', afterInner: 'farm' });
});

test('异步回调里班次同样能继承', async () => {
    await runWithRequestClass('background', async () => {
        await Promise.resolve();
        assert.equal(getAmbientRequestClass(), 'background');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(getAmbientRequestClass(), 'background', '跨过 await 之后仍要保留班次');
    });
    assert.equal(getAmbientRequestClass(), null);
});

test('非法班次不包裹，直接执行回调并保留外层班次', () => {
    for (const invalid of ['bogus', '', null, undefined, 123, {}]) {
        const seen = runWithRequestClass(invalid, () => getAmbientRequestClass());
        assert.equal(seen, null, `${String(invalid)} 不是合法班次，不该建立上下文`);
    }

    // 内层用非法班次时，外层班次不能被破坏
    const nested = runWithRequestClass('farm', () => runWithRequestClass('bogus', () => getAmbientRequestClass()));
    assert.equal(nested, 'farm');
});

test('五个合法班次都能正确注入', () => {
    for (const allowed of ['critical', 'foreground', 'farm', 'friend', 'background']) {
        assert.equal(runWithRequestClass(allowed, () => getAmbientRequestClass()), allowed);
    }
});

// ============ 调度器命名空间映射 ============

test('基础设施命名空间不注入班次', () => {
    assert.equal(classForSchedulerNamespace('network'), null);
    assert.equal(classForSchedulerNamespace('ace'), null);
    assert.equal(classForSchedulerNamespace('worker_manager'), null);
    assert.equal(classForSchedulerNamespace(''), null);
    assert.equal(classForSchedulerNamespace(null), null);
});

test('好友宠物同步跑在后台班次，其余好友任务跑好友班次', () => {
    assert.equal(classForSchedulerNamespace('friend-pet-sync'), 'background');
    assert.equal(classForSchedulerNamespace('friend'), 'friend');
    assert.equal(classForSchedulerNamespace('friend-visit'), 'friend');
});

test('其余命名空间默认农场班次（保守默认值）', () => {
    assert.equal(classForSchedulerNamespace('farm'), 'farm');
    assert.equal(classForSchedulerNamespace('worker'), 'farm');
    assert.equal(classForSchedulerNamespace('activity'), 'farm');
});

test('命名空间两侧空白会被忽略', () => {
    assert.equal(classForSchedulerNamespace('  network  '), null);
    assert.equal(classForSchedulerNamespace('  friend-pet-sync  '), 'background');
});
