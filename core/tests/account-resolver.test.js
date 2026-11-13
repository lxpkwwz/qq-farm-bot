/**
 * 账号引用解析。
 *
 * 面板和内部调用都用「一个字符串」指代账号：可能是 `id`、`uin`、`qq`，也可能带空格。
 * 这套解析是 `/api/*` 里 `x-account-id` 头的唯一解释器——解析错了就是「操作了另一个账号」，
 * 而且两边都成功、都不报错，只能靠对账发现。之前没有测试。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeAccountRef, findAccountByRef, resolveAccountId } = require('../dist/services/account-resolver');

const ACCOUNTS = [
    { id: 'acc-1', uin: '10001', qq: '20001' },
    { id: 'acc-2', uin: '10002' },
    { id: '', uin: '10003' },
    { notAnAccount: true },
    null,
];

// ============ 引用归一化 ============

test('空引用归一成空串', () => {
    assert.equal(normalizeAccountRef(undefined), '');
    assert.equal(normalizeAccountRef(null), '');
    assert.equal(normalizeAccountRef(''), '');
    assert.equal(normalizeAccountRef('   '), '');
});

test('数组取第一个元素（兼容重复的 query 参数）', () => {
    assert.equal(normalizeAccountRef(['acc-1', 'acc-2']), 'acc-1');
    assert.equal(normalizeAccountRef([['acc-1']]), 'acc-1');
    assert.equal(normalizeAccountRef([]), '');
});

test('数字与带空白的字符串都能归一成去空白的文本', () => {
    assert.equal(normalizeAccountRef(10001), '10001');
    assert.equal(normalizeAccountRef('  10001  '), '10001');
});

// ============ 查找 ============

test('id / uin / qq 三种标识都能找到账号', () => {
    assert.equal(findAccountByRef(ACCOUNTS, 'acc-1')?.id, 'acc-1');
    assert.equal(findAccountByRef(ACCOUNTS, '10001')?.id, 'acc-1');
    assert.equal(findAccountByRef(ACCOUNTS, '20001')?.id, 'acc-1');
    assert.equal(findAccountByRef(ACCOUNTS, '10002')?.id, 'acc-2');
});

test('引用里的空白会被忽略', () => {
    assert.equal(findAccountByRef(ACCOUNTS, '  10002 ')?.id, 'acc-2');
});

test('找不到、空引用、账号表不是数组时都返回 null', () => {
    assert.equal(findAccountByRef(ACCOUNTS, 'nobody'), null);
    assert.equal(findAccountByRef(ACCOUNTS, ''), null);
    assert.equal(findAccountByRef(ACCOUNTS, null), null);
    assert.equal(findAccountByRef(null, 'acc-1'), null);
    assert.equal(findAccountByRef('not-an-array', 'acc-1'), null);
});

test('账号表里的非对象与 null 条目会被跳过，不影响后面的正常匹配', () => {
    assert.equal(findAccountByRef([null, 'string', 42, { id: 'later' }], 'later')?.id, 'later');
});

test('空字符串不会命中任何账号（避免用空引用误选第一个）', () => {
    const accountsWithEmptyId = [{ id: '' }, { id: 'real' }];
    assert.equal(findAccountByRef(accountsWithEmptyId, ''), null);
});

// ============ 解析成 id ============

test('命中时返回账号的 id', () => {
    assert.equal(resolveAccountId(ACCOUNTS, '10001'), 'acc-1');
    assert.equal(resolveAccountId(ACCOUNTS, '20001'), 'acc-1');
});

test('未命中时返回空串，而不是把输入原样当成 id', () => {
    assert.equal(resolveAccountId(ACCOUNTS, 'nobody'), '');
    assert.equal(resolveAccountId(ACCOUNTS, ''), '');
});

test('命中了但账号本身没有 id 时返回空串', () => {
    assert.equal(resolveAccountId(ACCOUNTS, '10003'), '', 'uins 命中了一个没有 id 的条目，不能返回 uin 冒充 id');
});
