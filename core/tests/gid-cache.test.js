/**
 * 已知好友 GID 的磁盘缓存。
 *
 * 文件名由账号 id 直接拼出来，所以这里唯一的硬要求是：**账号 id 不能左右落盘位置**。
 * 面板允许自定义账号 id，如果没做字符过滤，一个叫 `../../admin` 的 id 就能把缓存写到
 * 数据目录之外去。另外读写都必须吞错——缓存丢了只是多拉一次好友列表，不能因此让整个
 * 好友流程失败。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-gidcache-'));
const cacheDir = path.join(tmpDir, 'known-friend-gids');

require.cache[require.resolve('../dist/models/store/shared-state')] = {
    exports: { KNOWN_FRIEND_GIDS_DIR: cacheDir },
};

// 用真实文件读写，但落点全在临时目录里。
require.cache[require.resolve('../dist/services/json-db')] = {
    exports: {
        readJsonFile: file => JSON.parse(fs.readFileSync(file, 'utf8')),
        writeJsonFileAtomic: (file, data) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        },
    },
};

const cache = require('../dist/models/store/gid-cache');

test.after(() => {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
        // 清理失败不影响结论
    }
});

test('账号 id 里的路径分隔符与点号被替换，缓存不会写到目录之外', () => {
    for (const hostile of ['../../admin', '..\\..\\admin', '/etc/passwd', 'a/b/c', 'a.b.c']) {
        const file = cache.getKnownFriendGidsCacheFile(hostile);
        assert.equal(path.dirname(file), cacheDir, `${hostile} 必须落在缓存目录内`);
        assert.doesNotMatch(path.basename(file), /[/\\]/, `${hostile} 不该在文件名里留下分隔符`);
        assert.ok(!path.basename(file).includes('..'), `${hostile} 不该留下上跳片段`);
    }
});

test('常规账号 id 保持可读的文件名', () => {
    assert.equal(path.basename(cache.getKnownFriendGidsCacheFile('acc-1_2')), 'acc-1_2.json');
});

test('写入后能原样读回', () => {
    cache.writeKnownFriendGidsCache('acc-1', [1001, 1002, 1003]);
    assert.deepEqual(cache.readKnownFriendGidsCache('acc-1'), [1001, 1002, 1003]);
});

test('不同账号的缓存互不覆盖', () => {
    cache.writeKnownFriendGidsCache('acc-a', [11]);
    cache.writeKnownFriendGidsCache('acc-b', [22]);
    assert.deepEqual(cache.readKnownFriendGidsCache('acc-a'), [11]);
    assert.deepEqual(cache.readKnownFriendGidsCache('acc-b'), [22]);
});

test('没有缓存文件时返回 null', () => {
    assert.equal(cache.readKnownFriendGidsCache('never-written'), null);
});

test('文件损坏时返回 null 而不是抛错', () => {
    const file = cache.getKnownFriendGidsCacheFile('broken');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    assert.equal(cache.readKnownFriendGidsCache('broken'), null);
});

test('结构不符（gids 不是数组）时返回 null', () => {
    const file = cache.getKnownFriendGidsCacheFile('wrong-shape');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ gids: 'not-an-array' }), 'utf8');
    assert.equal(cache.readKnownFriendGidsCache('wrong-shape'), null);
});

test('写入空数组是合法的（表示已知但没有好友）', () => {
    cache.writeKnownFriendGidsCache('empty', []);
    assert.deepEqual(cache.readKnownFriendGidsCache('empty'), []);
});

test('写入失败时不抛错（缓存丢了只影响性能，不该中断好友流程）', () => {
    const original = fs.writeFileSync;
    fs.writeFileSync = () => {
        throw new Error('磁盘只读');
    };
    try {
        assert.doesNotThrow(() => cache.writeKnownFriendGidsCache('readonly', [1]));
    } finally {
        fs.writeFileSync = original;
    }
});
