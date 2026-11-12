const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const pluginPath = path.resolve(ROOT, 'napcat/plugins/qq-miniapp-openauth/index.mjs');
const plugin = fs.readFileSync(pluginPath, 'utf8');

/** 取 `/miniapp` 端点里那份取码方法尝试顺序。 */
function ladder() {
    const matched = plugin.match(/for \(const operation of \[([^\]]+)\]\)/);
    assert.ok(matched, '找不到取码方法的尝试顺序');
    return [...matched[1].matchAll(/'([a-z]+)'/gi)].map(item => item[1]);
}

test('取码优先走 getOpenAuth：它在当前 NapCat 接口面上是唯一确认存在的入口', () => {
    const order = ladder();
    assert.equal(order[0], 'getOpenAuth', `getOpenAuth 必须排第一，当前是 ${order.join(' > ')}`);
});

test('老版本的三个方法名保留为兜底，不要当成死代码删掉', () => {
    const order = ladder();
    // checkSessionForMiniApp 语义是「查已有会话」，可能返回已被消费的旧 Code，
    // 所以只能排在新 Code 之后，但不能删 —— 老版本 NapCat 上 getOpenAuth 不存在。
    for (const legacy of ['checkSessionForMiniApp', 'loginWithAppId', 'getOpenCodeWithAppId']) {
        assert.ok(order.includes(legacy), `兜底方法 ${legacy} 被删掉了，老版本 NapCat 会无法取码`);
        assert.ok(order.indexOf(legacy) > 0, `${legacy} 不能排在 getOpenAuth 之前`);
    }
});

test('getOpenAuth 传 true：向服务端要新 Code 而不是复用已有会话', () => {
    assert.match(
        plugin,
        /service\[operation\]\(true,\s*appId\)/,
        'getOpenAuth 的第一个参数必须是 true，否则可能拿到旧 Code',
    );
});

test('NapCat 基础镜像仍可通过 NAPCAT_IMAGE 覆盖（上游已下线，不能只依赖 :latest）', () => {
    const dockerfile = fs.readFileSync(path.resolve(ROOT, 'napcat/Dockerfile'), 'utf8');
    assert.match(dockerfile, /ARG NAPCAT_IMAGE=/, 'NAPCAT_IMAGE 构建参数被删掉了，重建将无法固定版本');
    assert.match(dockerfile, /FROM \$\{NAPCAT_IMAGE\}/, 'FROM 没有引用 NAPCAT_IMAGE');
    assert.match(
        dockerfile,
        /docker\.m\.daocloud\.io\/mlikiowa\/napcat-docker/,
        'Dockerfile 注释里应保留镜像加速站的写法示例，Docker Hub 直连超时时靠它落地',
    );
});

test('部署文档给出固定版本与离线导入两条路径', () => {
    const doc = fs.readFileSync(path.resolve(ROOT, 'docs/detailed-reference.md'), 'utf8');
    assert.match(doc, /NAPCAT_IMAGE=mlikiowa\/napcat-docker:</, '文档缺少固定基础镜像版本的写法');
    assert.match(doc, /docker load -i/, '文档缺少镜像离线导入的兜底步骤');
});

test('文档说明 manifest inspect 不走镜像加速，别拿它判断标签可用性', () => {
    const doc = fs.readFileSync(path.resolve(ROOT, 'docs/detailed-reference.md'), 'utf8');
    // docker manifest inspect 是 CLI 直连 registry，不吃 daemon 的 registry-mirrors，
    // 在 Docker Hub 不可直连的网络里必然超时。若文档不提这一点，排查时会被它带偏。
    assert.match(doc, /registry-mirrors/, '文档缺少「manifest inspect 不走宿主机 registry-mirrors」的说明');
    assert.match(
        doc,
        /docker\.m\.daocloud\.io\/mlikiowa\/napcat-docker:/,
        '文档缺少镜像加速站前缀的构建写法',
    );
    assert.match(doc, /docker pull/, '文档应指明验证标签要用 docker pull（它会走镜像加速）');
});
