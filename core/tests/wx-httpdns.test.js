const test = require('node:test');
const assert = require('node:assert/strict');

const dns = require('../dist/services/wx-login/httpdns');

const NOW = 1_800_000_000_000;

function payload() {
    return {
        dns: {
            domainlist: [
                {
                    name: 'longcloud.weixin.com',
                    iplist: [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }],
                    protocollist: [
                        { name: 'http', portlist: [80] },
                        { name: 'mmtlsovertcp', portlist: [8080, 443] },
                    ],
                },
                {
                    name: 'shortcloud.weixin.com',
                    iplist: [{ ip: '3.3.3.3' }],
                    protocollist: [
                        { name: 'http', portlist: [80] },
                        { name: 'mmtlsoverhttp', portlist: [80, 443] },
                    ],
                },
            ],
        },
    };
}

test('长链候选：协议优先 mmtlsovertcp，端口按 443 优先，IP 全铺开', () => {
    const targets = dns.parseDnsTargets(payload(), 'long');
    assert.deepEqual(targets.map(t => `${t.host}:${t.port}`), [
        '1.1.1.1:443', '2.2.2.2:443',
        '1.1.1.1:8080', '2.2.2.2:8080',
    ]);
    assert.ok(targets.every(t => t.source === 'dns'));
});

test('短链候选：协议优先 mmtlsoverhttp，且必须排除 443（明文 HTTP 不支持 TLS）', () => {
    const targets = dns.parseDnsTargets(payload(), 'short');
    assert.deepEqual(targets.map(t => `${t.host}:${t.port}`), ['3.3.3.3:80']);
    assert.equal(targets.some(t => t.port === 443), false, '连 443 只会白等 8 秒超时');
});

test('DNS 返回里没有对应域名时给出空列表，由 resolveTargets 兜底', () => {
    assert.deepEqual(dns.parseDnsTargets({ dns: { domainlist: [] } }, 'long'), []);
    assert.deepEqual(dns.parseDnsTargets({}, 'short'), []);
    assert.deepEqual(dns.parseDnsTargets(null, 'long'), []);
});

test('resolveTargets：DNS + 域名直连 + 硬编码兜底，查询参数用真实 clientversion', async () => {
    dns.clearDnsCache();
    const urls = [];
    const fetchImpl = async (url) => {
        urls.push(url);
        return { ok: true, json: async () => payload() };
    };
    const targets = await dns.resolveTargets('long', { fetchImpl, now: NOW });
    const keys = targets.map(t => `${t.host}:${t.port}`);
    assert.equal(keys[0], '1.1.1.1:443', 'DNS 结果排在最前');
    assert.ok(keys.includes('longcloud.weixin.com:443'), '必须有域名直连槽位');
    assert.ok(keys.includes('180.153.202.85:8080'), '必须有硬编码兜底');
    assert.ok(urls[0].includes('clientversion=524545'), '传 0 时服务端可能返回空列表');
});

test('resolveTargets：DNS 完全失败时仍返回非空候选（直连 + 兜底）', async () => {
    dns.clearDnsCache();
    const targets = await dns.resolveTargets('short', {
        fetchImpl: async () => { throw new Error('DNS 挂了'); },
        now: NOW,
    });
    const keys = targets.map(t => `${t.host}:${t.port}`);
    assert.deepEqual(keys, [
        'shortcloud.weixin.com:80',
        '116.128.171.253:80',
        '140.207.120.146:80',
        '182.50.15.223:80',
        '182.50.15.171:80',
    ]);
    assert.equal(keys.includes('120.241.131.173:80'), false, '这个旧 IP 已被微信下线，不能再当兜底');
});

test('resolveTargets：结果缓存 10 分钟，bypassCache 才会重新请求', async () => {
    dns.clearDnsCache();
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, json: async () => payload() }; };
    await dns.resolveTargets('long', { fetchImpl, now: NOW });
    await dns.resolveTargets('long', { fetchImpl, now: NOW + 1000 });
    assert.equal(calls, 1, '短时间内的第二次解析走缓存');
    await dns.resolveTargets('long', { fetchImpl, now: NOW + dns.DNS_CACHE_TTL_MS + 1 });
    assert.equal(calls, 2, '缓存过期后重新解析');
    await dns.resolveTargets('long', { fetchImpl, now: NOW + dns.DNS_CACHE_TTL_MS + 2, bypassCache: true });
    assert.equal(calls, 3);
});
