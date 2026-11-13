const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.resolve(ROOT, file), 'utf8');

// ============ 防复发门禁：把「未处理 Promise」变成写的时候就报错 ============
// 背景：同一类缺陷（async 函数被当同步回调传出去 / 定时器不接管拒绝）在多轮复查里
// 反复出现，原因是每次只修实例、没有闸门。这里锁住闸门本身，防止被静默关掉或改弱。

test('eslint 必须启用类型感知的「未处理 Promise」规则族', () => {
    const config = read('eslint.config.mjs');
    assert.match(config, /tsconfigPath:\s*'\.\/tsconfig\.json'/, '没有 tsconfigPath 时类型感知规则不会生效');
    assert.match(config, /'ts\/no-floating-promises':\s*'error'/);
    assert.match(config, /'ts\/no-misused-promises':\s*\['error',\s*\{[^}]*checksConditionals:\s*false/);
    assert.match(config, /'ts\/await-thenable':\s*'error'/);
});

test('类型感知的噪声规则必须保持关闭，否则门禁会被淹没而形同虚设', () => {
    const config = read('eslint.config.mjs');
    for (const rule of [
        'ts/no-unsafe-assignment',
        'ts/no-unsafe-member-access',
        'ts/strict-boolean-expressions',
        'ts/promise-function-async',
    ]) {
        assert.match(config, new RegExp(`'${rule}':\\s*'off'`), `${rule} 应保持 off`);
    }
});

test('lint 脚本必须扫全目录，不能只扫 src', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.lint, /eslint \./);
});

test('主进程指令处理器允许 async，且由 onMasterMessage 统一接管拒绝', () => {
    const worker = read('src/core/worker.ts');
    assert.match(worker, /function onMasterMessage\(handler: \(msg: any\) => void \| Promise<void>\)/);
    assert.match(worker, /Promise\.resolve\(result\)\.catch\(/);
    assert.match(worker, /主进程指令处理异常/);
});

test('定时器不接管返回值，注册处必须自己兜住拒绝', () => {
    const scheduler = read('src/services/scheduler.ts');
    assert.doesNotMatch(scheduler, /setTimeout\(async/, 'setTimeout 里直接写 async 箭头函数，拒绝无人接管');
    assert.doesNotMatch(scheduler, /setInterval\(runner,/, 'setInterval 直接传 async 函数，拒绝无人接管');
    assert.equal((scheduler.match(/runOnce\(\)\.catch\(/g) || []).length, 1);
    assert.equal((scheduler.match(/runner\(\)\.catch\(/g) || []).length, 1);
});

test('网络回调类型必须如实声明可为 async，否则只能靠 eslint-disable 掩盖', () => {
    const network = read('src/utils/network.ts');
    assert.match(network, /callback: \(err: Error \| null, body\?: Buffer, meta\?: any\) => void \| Promise<void>;/);
    assert.match(network, /onLoginSuccess\?: \(\) => void \| Promise<void>/);
});
