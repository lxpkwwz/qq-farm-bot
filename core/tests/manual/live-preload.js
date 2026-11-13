/**
 * 用「真实数据的一份副本」启动真实服务。
 *
 * 目的：验证「服务真的能跑起来」这类问题，必须在真进程上做；但直接对着
 * `core/data` 跑等于拿用户真实账号冒险（实测脚本里一条 DELETE 就把账号删了）。
 *
 * 做法：在业务模块加载之前把 runtime-paths 指向临时目录，并把 `core/data`
 * 整份复制进去。服务的读路径、写路径、落盘逻辑全部照常工作，只是落在副本上。
 *
 * 用法：
 *   cd core
 *   FARM_AUTO_START_ACCOUNTS=0 ADMIN_PORT=3010 \
 *     node -r ./tests/manual/live-preload.js client.js
 *
 * 默认保留副本便于排查；`LIVE_KEEP_DATA=0` 时进程退出后删除。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realDataDir = path.resolve(__dirname, '../../data');
const stamp = `${Date.now()}-${process.pid}`;
const tempRoot = path.join(os.tmpdir(), `qq-farm-live-${stamp}`);
const tempDataDir = path.join(tempRoot, 'data');

fs.mkdirSync(tempRoot, { recursive: true });
if (fs.existsSync(realDataDir)) {
    fs.cpSync(realDataDir, tempDataDir, { recursive: true });
} else {
    fs.mkdirSync(tempDataDir, { recursive: true });
}

const target = require.resolve('../../dist/config/runtime-paths');
const real = require(target);

require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: {
        ...real,
        getDataDir: () => tempDataDir,
        getDataFile: (filename) => path.join(tempDataDir, filename),
        ensureDataDir: () => {
            if (!fs.existsSync(tempDataDir)) fs.mkdirSync(tempDataDir, { recursive: true });
            return tempDataDir;
        },
        // 分享链接文件也不写到真实目录
        getShareFilePath: () => path.join(tempRoot, 'share.txt'),
    },
};

console.log(`[live-preload] 真实数据目录 : ${realDataDir}`);
console.log(`[live-preload] 本次运行数据 : ${tempDataDir}`);
console.log(`[live-preload] 副本根目录   : ${tempRoot}`);

if (process.env.LIVE_KEEP_DATA === '0') {
    process.on('exit', () => {
        try {
            fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch {
            // 清理失败不影响退出码
        }
    });
}
