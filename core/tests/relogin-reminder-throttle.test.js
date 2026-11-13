const test = require('node:test');
const assert = require('node:assert/strict');

const { createReloginReminderService } = require('../dist/runtime/relogin-reminder');

function harness(cfg) {
    const sent = [];
    const logs = [];
    const service = createReloginReminderService({
        store: { getOfflineReminder: () => cfg },
        sendPushooMessage: async (payload) => {
            sent.push(payload);
            return { ok: true };
        },
        log: (tag, msg) => logs.push({ tag, msg: String(msg) }),
    });
    return { service, sent, logs };
}

function webhookConfig(overrides = {}) {
    return {
        channel: 'webhook',
        endpoint: 'https://example.invalid/hook',
        token: '',
        secret: '',
        title: '账号掉线提醒',
        msg: '账号已掉线，请及时处理',
        ...overrides,
    };
}

test('同一账号 10 分钟内反复掉线只推一条，避免自动重登循环刷屏', async () => {
    const { service, sent, logs } = harness(webhookConfig());

    await service.triggerOfflineReminder({ accountId: '1', accountName: '甲', reason: 'kickout:其他设备登录' });
    await service.triggerOfflineReminder({ accountId: '1', accountName: '甲', reason: 'disconnect:ws_close:login:1006' });
    await service.triggerOfflineReminder({ accountId: '1', accountName: '甲', reason: 'kickout:其他设备登录' });

    assert.equal(sent.length, 1, '同账号重复提醒必须被节流');
    assert.ok(logs.some(item => /节流/.test(item.msg)), '被节流时要在日志里留下痕迹，否则像是没触发');
});

test('不同账号互不影响节流', async () => {
    const { service, sent } = harness(webhookConfig());

    await service.triggerOfflineReminder({ accountId: '1', accountName: '甲', reason: 'kickout:x' });
    await service.triggerOfflineReminder({ accountId: '2', accountName: '乙', reason: 'kickout:x' });

    assert.equal(sent.length, 2);
});

test('推送正文带上具体掉线原因，用户不用翻日志', async () => {
    const { service, sent } = harness(webhookConfig());

    await service.triggerOfflineReminder({ accountId: '1', accountName: '甲', reason: 'disconnect:ws_close:login:1006' });

    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /掉线原因/);
    assert.match(sent[0].content, /ws_close/);
});

test('持续离线被自动删除时，正文写清楚离线时长', async () => {
    const { service, sent } = harness(webhookConfig());

    await service.triggerOfflineReminder({
        accountId: '1',
        accountName: '甲',
        reason: 'offline_timeout',
        offlineMs: 30 * 60_000,
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /30 分钟/);
});

test('钉钉渠道缺 Webhook 地址时不发送（token 单独存在也发不出去）', async () => {
    const { service, sent, logs } = harness(webhookConfig({ channel: 'dingtalk', endpoint: '', token: 'some-token' }));

    await service.triggerOfflineReminder({ accountId: '1', accountName: '甲', reason: 'kickout:x' });

    assert.equal(sent.length, 0, '配置必然失败时不该调用推送');
    assert.ok(logs.some(item => /钉钉渠道未设置 Webhook 地址/.test(item.msg)));
});
