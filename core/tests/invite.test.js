/**
 * 邀请码处理（share.txt → ReportArkClick）。
 *
 * 这条链路只在微信环境生效，平时几乎跑不到，一旦跑起来就是「批量给陌生人发好友申请」，
 * 所以边界比功能重要：
 *   - 解析必须能处理用户整段粘贴的分享链接（带不带 ? 都要认）；
 *   - 按 uid 去重，同一个分享者只发一次；
 *   - 单条失败不能中断整批，最后仍要清空已处理的文件——否则失败的条目会一直重试刷屏；
 *   - QQ 环境直接跳过，连文件都不读。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-invite-'));
const shareFile = path.join(tmpDir, 'share.txt');

let platform = 'wx';
require.cache[require.resolve('../dist/config/config')] = {
    exports: { CONFIG: { get platform() { return platform; } } },
};

// 只替换分享文件路径，其余导出保持原样：logger 也依赖这个模块的 ensureDataDir。
require.cache[require.resolve('../dist/config/runtime-paths')] = {
    exports: {
        ...require('../dist/config/runtime-paths'),
        getShareFilePath: () => shareFile,
    },
};

require.cache[require.resolve('../dist/services/json-db')] = {
    exports: {
        readTextFile: (file, fallback) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback),
        writeTextFileAtomic: (file, content) => fs.writeFileSync(file, content, 'utf8'),
    },
};

const clicks = [];
let clickError = null;
require.cache[require.resolve('../dist/utils/network')] = {
    exports: {
        sendMsgAsync: async (_service, method, body) => {
            clicks.push({ method, body: JSON.parse(body.toString()) });
            if (clickError) throw clickError;
            return { body: Buffer.alloc(0) };
        },
    },
};

require.cache[require.resolve('../dist/utils/proto')] = {
    exports: {
        types: {
            ReportArkClickRequest: {
                create: value => value,
                encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }),
            },
            ReportArkClickReply: { decode: () => ({ ok: true }) },
        },
    },
};

let sleepCalls = 0;
const utilsPath = require.resolve('../dist/utils/utils');
const realUtils = require('../dist/utils/utils');
require.cache[utilsPath] = {
    exports: {
        ...realUtils,
        log: () => {},
        logWarn: () => {},
        sleep: async () => {
            sleepCalls += 1;
        },
    },
};

const invite = require('../dist/services/invite');

function writeShare(content) {
    fs.writeFileSync(shareFile, content, 'utf8');
}

function readShare() {
    return fs.existsSync(shareFile) ? fs.readFileSync(shareFile, 'utf8') : '';
}

function reset() {
    platform = 'wx';
    clicks.length = 0;
    clickError = null;
    sleepCalls = 0;
    try {
        fs.rmSync(shareFile);
    } catch {
        // 首次运行没有文件
    }
}

test.beforeEach(reset);
test.after(() => {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
        // 清理失败不影响结论
    }
});

// ============ 链接解析 ============

test('解析约定格式的查询串', () => {
    assert.deepEqual(invite.parseShareLink('?uid=123&openid=abc&share_source=7&doc_id=9'), {
        uid: '123',
        openid: 'abc',
        shareSource: '7',
        docId: '9',
    });
});

test('没有前导问号也能解析', () => {
    assert.deepEqual(invite.parseShareLink('uid=123&openid=abc'), {
        uid: '123',
        openid: 'abc',
        shareSource: null,
        docId: null,
    });
});

test('整段分享链接（带协议与路径）也能解析出参数', () => {
    const parsed = invite.parseShareLink('https://game.qq.com/share/index.html?uid=55&openid=op-55&share_source=3');
    assert.equal(parsed.uid, '55');
    assert.equal(parsed.openid, 'op-55');
    assert.equal(parsed.shareSource, '3');
});

test('缺失参数返回 null，空输入不抛错', () => {
    assert.deepEqual(invite.parseShareLink(''), { uid: null, openid: null, shareSource: null, docId: null });
    assert.deepEqual(invite.parseShareLink('?uid=1'), { uid: '1', openid: null, shareSource: null, docId: null });
});

test('URL 编码的参数会被解码', () => {
    const parsed = invite.parseShareLink('?uid=1&openid=a%2Fb%2Bc');
    assert.equal(parsed.openid, 'a/b+c');
});

test('同名参数取第一个', () => {
    assert.equal(invite.parseShareLink('?uid=first&uid=second&openid=x').uid, 'first');
});

// ============ 文件读取与去重 ============

test('只处理同时含 uid 与 openid 的行，并按 uid 去重', () => {
    writeShare([
        '?uid=1&openid=a',
        '',
        '   ',
        '?uid=1&openid=a-重复',
        '?uid=2&openid=b',
        '?uid=2&openid=b-重复',
        'openid=only-openid-没有 uid',
        'uid=3-没有-openid',
        '纯文本干扰行',
    ].join('\n'));

    const invites = invite.readShareFile();

    assert.deepEqual(invites.map(row => row.uid), ['1', '2'], '同 uid 只保留第一次出现');
    assert.deepEqual(invites.map(row => row.openid), ['a', 'b']);
});

test('文件不存在时返回空数组', () => {
    assert.deepEqual(invite.readShareFile(), []);
});

test('清空文件后立刻变空', () => {
    writeShare('?uid=1&openid=a');
    invite.clearShareFile();
    assert.equal(readShare(), '');
    assert.deepEqual(invite.readShareFile(), []);
});

// ============ 环境判定 ============

test('QQ 环境直接跳过：不发请求，也不动文件', async () => {
    platform = 'qq';
    writeShare('?uid=1&openid=a');

    await invite.processInviteCodes();

    assert.deepEqual(clicks, []);
    assert.equal(readShare(), '?uid=1&openid=a', '跳过的环境不该清空待处理文件');
});

test('没有可处理条目时不发请求', async () => {
    writeShare('纯文本，没有 openid');

    await invite.processInviteCodes();

    assert.deepEqual(clicks, []);
});

// ============ 批量处理 ============

test('逐条发送申请，条目之间才等待，最后一条不等', async () => {
    writeShare(['?uid=1&openid=a', '?uid=2&openid=b', '?uid=3&openid=c'].join('\n'));

    await invite.processInviteCodes();

    assert.equal(clicks.length, 3);
    assert.ok(clicks.every(click => click.method === 'ReportArkClick'));
    assert.equal(sleepCalls, 2, '3 条之间只应该有 2 次间隔');
});

test('请求体带上分享者标识与微信场景号', async () => {
    writeShare('?uid=77&openid=op-77&share_source=5');

    await invite.processInviteCodes();

    const Long = require('long');
    const body = clicks[0].body;
    // share_cfg_id 与 sharer_id 走 toLong，是 Long 实例，比较前先转成 number。
    assert.equal(Long.fromValue(body.share_cfg_id).toNumber(), 5);
    assert.equal(body.scene_id, '1256');
    assert.equal(body.sharer_open_id, 'op-77');
    assert.equal(Long.fromValue(body.sharer_id).toNumber(), 77);
});

test('单条失败不中断整批，处理完仍清空文件', async () => {
    writeShare(['?uid=1&openid=a', '?uid=2&openid=b'].join('\n'));
    clickError = new Error('网关超时');

    await invite.processInviteCodes();

    assert.equal(clicks.length, 2, '第二条仍要尝试');
    assert.equal(sleepCalls, 1);
    assert.equal(readShare(), '', '失败的条目也要清掉，避免每个周期重复刷屏');
});
