const test = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../dist/services/wx-login/session-cache');

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function session(patch = {}) {
    return {
        sendKey: Buffer.from('send'),
        recvKey: Buffer.from('recv'),
        f9: Buffer.alloc(0),
        uin: 123n,
        deviceId: Buffer.from('dev'),
        hostAppId: Buffer.from('wxd44977328b36e647'),
        psk: Buffer.alloc(32, 1),
        ticket: Buffer.alloc(16, 2),
        ...patch,
    };
}

test('缓存键只留摘要：不把 loginBuffer 明文当 key', () => {
    const key = cache.sessionCacheKey('super-secret-login-buffer', 'wx5306c5978fdb76e4');
    assert.equal(key.includes('super-secret-login-buffer'), false);
    assert.equal(key.endsWith('|wx5306c5978fdb76e4'), true);
    assert.equal(cache.sessionCacheKey('a', 'x') === cache.sessionCacheKey('b', 'x'), false);
    assert.equal(cache.sessionCacheKey('a', 'x') === cache.sessionCacheKey('a', 'y'), false, 'AppID 不同不能共用一个会话');
});

test('会话可以存取，且同一个键能命中', () => {
    cache.clearSessionCache();
    const key = cache.sessionCacheKey('lb', 'app');
    assert.equal(cache.getCachedSession(key, NOW), null);
    cache.setCachedSession(key, session(), NOW);
    const hit = cache.getCachedSession(key, NOW + MINUTE);
    assert.ok(hit);
    assert.equal(hit.uin, 123n);
    assert.equal(hit.sendKey.toString(), 'send');
});

test('超过 TTL 自动失效（服务端可能已经回收，不能一直复用）', () => {
    cache.clearSessionCache();
    const key = cache.sessionCacheKey('lb2', 'app');
    cache.setCachedSession(key, session(), NOW);
    assert.ok(cache.getCachedSession(key, NOW + cache.DEFAULT_SESSION_TTL_MS - 1));
    assert.equal(cache.getCachedSession(key, NOW + cache.DEFAULT_SESSION_TTL_MS), null);
});

test('invalidate / clear 能主动丢弃会话', () => {
    cache.clearSessionCache();
    const key = cache.sessionCacheKey('lb3', 'app');
    cache.setCachedSession(key, session(), NOW);
    cache.invalidateCachedSession(key);
    assert.equal(cache.getCachedSession(key, NOW), null);

    cache.setCachedSession(cache.sessionCacheKey('lb4', 'app'), session(), NOW);
    cache.clearSessionCache();
    assert.equal(cache.sessionCacheStats().size, 0);
});

test('缺关键字段的会话不入缓存（避免拿半截会话去请求）', () => {
    cache.clearSessionCache();
    const key = cache.sessionCacheKey('lb5', 'app');
    cache.setCachedSession(key, session({ sendKey: Buffer.alloc(0) }), NOW);
    assert.equal(cache.getCachedSession(key, NOW), null);

    cache.setCachedSession(key, session({ ticket: Buffer.alloc(0) }), NOW);
    assert.equal(cache.getCachedSession(key, NOW), null);
});
