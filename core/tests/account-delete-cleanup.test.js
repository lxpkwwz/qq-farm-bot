// 数据目录指向临时区：本测试要真实创建/删除文件，绝不能碰 core/data。
const { tempData } = require('./helpers/isolate-data');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const store = require('../dist/models/store');
const stats = require('../dist/services/stats');
const { purgeAccountArtifacts, accountToken, listAccountArtifacts } = require('../dist/models/store/account-artifacts');
const { ensureAccountConfig } = require('../dist/models/store/account-config');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** 按各模块真实的命名规则铺一套该账号的落盘文件。 */
function seedArtifacts(accountId) {
    const token = crypto.createHash('sha256').update(String(accountId), 'utf8').digest('hex');
    const files = {
        accountConfig: path.join(tempData, 'account-configs', `${accountId}.json`),
        knownGids: path.join(tempData, 'known_friend_gids', `${accountId}.json`),
        statsFile: path.join(tempData, 'stats', `${accountId}.json`),
        petCache: path.join(tempData, `friend-pet-${token}.json`),
        badState: path.join(tempData, `friend-bad-state-${token}.json`),
    };
    writeJson(files.knownGids, { gids: [1001, 1002], updatedAt: Date.now() });
    writeJson(files.statsFile, { date: '2026-11-14', operations: { steal: 1439 } });
    writeJson(files.petCache, { entries: [{ gid: 1001, dogId: 7 }] });
    writeJson(files.badState, { version: 1, date: '2026-11-14', stopped: true });
    fs.mkdirSync(path.join(tempData, 'tsdk', String(accountId)), { recursive: true });
    fs.writeFileSync(path.join(tempData, 'tsdk', String(accountId), 'cache.bin'), 'x');
    return files;
}

test('删号会清掉该账号的好友 GID 缓存、当日统计、宠物缓存与 TSDK 缓存', (t) => {
    t.after(() => {
        // 用例之间互不影响：把账号清空
        for (const account of store.getAccounts().accounts) store.deleteAccount(account.id);
    });

    const created = store.addOrUpdateAccount({ name: '待删号', platform: 'qq' });
    const id = created.accounts.at(-1).id;
    ensureAccountConfig(id);
    const files = seedArtifacts(id);

    assert.ok(fs.existsSync(files.knownGids), '前置条件：好友 GID 缓存已铺好');
    assert.ok(fs.existsSync(files.statsFile), '前置条件：当日统计已铺好');

    store.deleteAccount(id);

    assert.equal(fs.existsSync(files.knownGids), false, 'known_friend_gids/<id>.json 必须被清掉');
    assert.equal(fs.existsSync(files.statsFile), false, 'stats/<id>.json 必须被清掉');
    assert.equal(fs.existsSync(files.petCache), false, 'friend-pet-<sha256>.json 必须被清掉');
    assert.equal(fs.existsSync(files.badState), false, 'friend-bad-state-<sha256>.json 必须被清掉');
    assert.equal(fs.existsSync(path.join(tempData, 'tsdk', String(id))), false, 'tsdk/<id>/ 必须被清掉');
});

test('删号不会牵连其它账号的数据', (t) => {
    t.after(() => {
        for (const account of store.getAccounts().accounts) store.deleteAccount(account.id);
    });

    const first = store.addOrUpdateAccount({ name: '保留号', platform: 'qq' }).accounts.at(-1).id;
    const second = store.addOrUpdateAccount({ name: '删除号', platform: 'qq' }).accounts.at(-1).id;
    const keep = seedArtifacts(first);
    seedArtifacts(second);

    store.deleteAccount(second);

    assert.ok(fs.existsSync(keep.knownGids), '另一个账号的好友 GID 缓存不能被动');
    assert.ok(fs.existsSync(keep.statsFile), '另一个账号的统计不能被动');
    assert.ok(fs.existsSync(keep.petCache), '另一个账号的宠物缓存不能被动');
    assert.deepEqual(store.getAccounts().accounts.map(a => a.id), [first]);
});

test('删空之后新建账号拿到复用的 id，但不继承任何旧数据', (t) => {
    t.after(() => {
        for (const account of store.getAccounts().accounts) store.deleteAccount(account.id);
    });

    const id = store.addOrUpdateAccount({ name: '旧号', platform: 'qq' }).accounts.at(-1).id;
    ensureAccountConfig(id);
    seedArtifacts(id);

    store.deleteAccount(id);
    const reborn = store.addOrUpdateAccount({ name: '新号', platform: 'qq' }).accounts.at(-1);

    // id 复用是既定行为（normalizeAccountsData 里「没有账号就从头编号」），
    // 关键是复用之后不能带上一个账号的痕迹。
    assert.equal(String(reborn.id), String(id), '前置条件：id 确实被复用');
    assert.equal(fs.existsSync(path.join(tempData, 'known_friend_gids', `${id}.json`)), false, '新号不能继承好友 GID 缓存');
    assert.equal(fs.existsSync(path.join(tempData, 'stats', `${id}.json`)), false, '新号不能继承当日统计');
    assert.equal(fs.existsSync(path.join(tempData, `friend-pet-${accountToken(id)}.json`)), false, '新号不能继承宠物缓存');
});

test('清理只针对固定文件名，不越界删除', () => {
    // 手改 accounts.json 塞进来的怪 id 不能变成路径穿越
    const weird = '../../store';
    const removed = purgeAccountArtifacts(weird);
    assert.deepEqual(removed, [], '不存在的目标不应报告删除');
    assert.ok(fs.existsSync(path.join(tempData, 'store.json')), '无论如何都不能删到 store.json');
    // 归一化后的文件名仍在 data 目录内
    for (const target of listAccountArtifacts(weird)) {
        assert.ok(target.startsWith(tempData + path.sep), `路径必须落在数据目录内：${target}`);
        assert.equal(target.includes('..'), false, `路径不能包含上跳：${target}`);
    }
});

test('当日统计跟随 runtime-paths 的数据目录，不再硬拼 __dirname', () => {
    // 用带进程与时间戳的 id：既避免和并行跑的其他用例撞名，也避免
    // 「上一次运行留下的文件」把反证断言弄成假阳性。
    const id = `stats-path-${process.pid}-${Date.now()}`;
    stats.initStatsWithPersistence(id, 0, 0);
    stats.recordOperation('harvest', 3);
    stats.saveStats();

    const expected = path.join(tempData, 'stats', `${id}.json`);
    assert.ok(fs.existsSync(expected), `统计应写在数据目录下：${expected}`);

    // 反证：不能再出现在源码目录旁的 data/ 里
    const repoData = path.resolve(__dirname, '../data/stats', `${id}.json`);
    assert.equal(fs.existsSync(repoData), false, '统计不能写到 core/data（已由 runtime-paths 接管）');

    fs.rmSync(expected, { force: true });
});
