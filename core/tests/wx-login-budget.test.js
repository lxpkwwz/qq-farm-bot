const test = require('node:test');
const assert = require('node:assert/strict');

const { createLoginBudget, DEFAULT_LOGIN_BUDGET, DEFAULT_LOGIN_WINDOW_MS, loginBudget } = require('../dist/services/wx-login/login-budget');

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

test('默认额度：10 分钟 3 次，第 4 次被拒并给出恢复时间', () => {
    assert.equal(DEFAULT_LOGIN_BUDGET, 3);
    assert.equal(DEFAULT_LOGIN_WINDOW_MS, 10 * MINUTE);

    const budget = createLoginBudget();
    assert.equal(budget.take('a', NOW).allowed, true);
    assert.equal(budget.take('a', NOW + MINUTE).allowed, true);
    assert.equal(budget.take('a', NOW + 2 * MINUTE).allowed, true);

    const blocked = budget.take('a', NOW + 3 * MINUTE);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.used, 3);
    assert.equal(blocked.retryAfterMs, 7 * MINUTE, '最早那次 3 分钟后滑出窗口');
});

test('滑动窗口：最早一次滑出后立即恢复一次额度', () => {
    const budget = createLoginBudget();
    budget.take('a', NOW);
    budget.take('a', NOW + MINUTE);
    budget.take('a', NOW + 2 * MINUTE);
    assert.equal(budget.take('a', NOW + 5 * MINUTE).allowed, false);
    assert.equal(budget.take('a', NOW + 10 * MINUTE + 1).allowed, true, '第一次已滑出窗口');
    assert.equal(budget.take('a', NOW + 10 * MINUTE + 2).allowed, false, '窗口内仍是 3 次');
});

test('账号之间互不影响，peek 只看不占额度', () => {
    const budget = createLoginBudget();
    budget.take('a', NOW);
    budget.take('a', NOW);
    budget.take('a', NOW);
    assert.equal(budget.peek('a', NOW).allowed, false);
    assert.equal(budget.peek('b', NOW).allowed, true);
    assert.equal(budget.take('b', NOW).allowed, true, '别的账号有自己的额度');
    assert.equal(budget.peek('b', NOW).used, 1, 'peek 没有额外占用');
});

test('额度为 0 表示关闭限制（便于本地调试）', () => {
    const budget = createLoginBudget(0);
    for (let i = 0; i < 20; i++) assert.equal(budget.take('a', NOW + i).allowed, true);
});

test('reset 清空所有窗口，供测试与热重载使用', () => {
    const budget = createLoginBudget();
    budget.take('a', NOW);
    budget.take('a', NOW);
    budget.take('a', NOW);
    assert.equal(budget.peek('a', NOW).allowed, false);
    budget.reset();
    assert.equal(budget.peek('a', NOW).allowed, true);
});

test('进程级预算单例使用默认上限', () => {
    assert.equal(loginBudget.limit, DEFAULT_LOGIN_BUDGET);
    assert.equal(loginBudget.windowMs, DEFAULT_LOGIN_WINDOW_MS);
});
