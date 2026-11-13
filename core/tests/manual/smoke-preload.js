/**
 * 冒烟测试专用预加载：把「可写数据目录」整体重定向到临时目录。
 *
 * 必须用 `node -r` 在业务代码之前加载——`runtime-paths` 是很多模块在 require 阶段
 * 就要读的（`KNOWN_FRIEND_GIDS_DIR`、logger 的日志目录、admin.json 路径都在那时算好）。
 * 只在事后改就来不及了。
 *
 * 这样跑冒烟测试不会碰到 core/data 里的真实账号数据。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL_PATH = require.resolve('../../dist/config/runtime-paths');
const real = require(REAL_PATH);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-smoke-'));

require.cache[REAL_PATH] = {
    exports: {
        ...real,
        getDataDir: () => tmpDir,
        ensureDataDir: () => {
            fs.mkdirSync(tmpDir, { recursive: true });
            return tmpDir;
        },
        getDataFile: name => path.join(tmpDir, name),
        getShareFilePath: () => path.join(tmpDir, 'share.txt'),
    },
};

process.env.QQ_FARM_SMOKE_DATA_DIR = tmpDir;
