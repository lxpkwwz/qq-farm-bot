/**
 * 把「可写数据目录」指向系统临时区，供单元测试使用。
 *
 * 必须**在 require 任何业务模块之前** require 本文件：logger、各 store 的
 * 文件路径在模块加载阶段就算好了，晚一步就指不回去了。
 *
 * 为什么需要它：单元测试会通过真实 logger 打日志、通过 json-db 落盘。如果数据
 * 目录还指向 `core/data`，跑一次测试就往用户真实日志里追加几十 KB（实测
 * `capital-mode.test.js` 一次 21KB），既污染日志、又会干扰日志轮转的判断。
 *
 * 用法：
 *   const { tempRoot } = require('./helpers/isolate-data');
 *   const capitalMode = require('../dist/services/capital-mode');
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-test-data-'));
const tempData = path.join(tempRoot, 'data');
fs.mkdirSync(tempData, { recursive: true });

const target = require.resolve('../../dist/config/runtime-paths');
const real = require(target);

require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: {
        ...real,
        getDataDir: () => tempData,
        getDataFile: (filename) => path.join(tempData, filename),
        ensureDataDir: () => {
            if (!fs.existsSync(tempData)) fs.mkdirSync(tempData, { recursive: true });
            return tempData;
        },
        getShareFilePath: () => path.join(tempRoot, 'share.txt'),
    },
};

// Windows 上 rmSync 遇到仍被打开的文件会抛 EPERM/EBUSY，force 并不重试。
process.on('exit', () => {
    try {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
        // 清理失败不影响测试结果
    }
});

module.exports = { tempRoot, tempData };
