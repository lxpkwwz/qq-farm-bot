export {};
/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */
const path = require('node:path');
const fs = require('node:fs');

// tsx/bun 直接跑 client.ts 时用 src，避免 stale dist 缺新路由。
// node client.js / 打包产物仍优先加载已编译的 dist。
const runningFromSource = /\.[cm]?tsx?$/.test(__filename);
const distDir = path.join(__dirname, 'dist');
const baseDir = !runningFromSource && fs.existsSync(distDir) ? './dist' : './src';

const {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
} = require(`${baseDir}/controllers/admin`);
const { createRuntimeEngine } = require(`${baseDir}/runtime/runtime-engine`);
const { createModuleLogger } = require(`${baseDir}/services/logger`);
const mainLogger = createModuleLogger('main');

// 最后一道网：漏到进程级的 Promise 拒绝只记日志，不让进程退出。
//
// 主进程管着所有账号，因为一次 HTTP 请求里的意外抛错导致全部掉线是不划算的
// （实测 `/api/friend-blacklist` 在 provider 返回非数组时会一击打死服务）。
// 真正的修法在 controllers/admin/index.ts 的 guardAsyncRoutes：把路由抛错转成 500。
// 这里只兜住「还没被兜住」的残余，避免一个未预料的拒绝直接终止服务。
process.on('unhandledRejection', (reason: any) => {
    mainLogger.error('unhandled rejection at process level', {
        error: String((reason && reason.message) || reason),
        stack: String((reason && reason.stack) || '').split('\n').slice(0, 4).join(' | '),
    });
});

// 未捕获的同步异常会让进程处于未知状态，继续跑风险更大：记录完整堆栈后退出，
// 交给容器重启，至少日志里能查到真正原因（默认行为只会打到 stdout）。
process.on('uncaughtException', (error: any) => {
    mainLogger.error('uncaught exception, exiting', {
        error: String((error && error.message) || error),
        stack: String((error && error.stack) || '').split('\n').slice(0, 8).join(' | '),
    });
    process.exit(1);
});

// 打包后 worker 由当前可执行文件以 --worker 模式启动
const isWorkerProcess: boolean = process.env.FARM_WORKER === '1';
if (isWorkerProcess) {
    require(`${baseDir}/core/worker`);
} else {
    // 服务启动自动登录：默认开启，可用 FARM_AUTO_START_ACCOUNTS=0 或系统设置关闭。
    const store = require(`${baseDir}/models/store`);
    const { resolveAutoStartAccounts } = require(`${baseDir}/config/config`);
    const savedSystemConfig = typeof store.getSystemConfig === 'function' ? store.getSystemConfig() : null;
    const autoStartAccounts = resolveAutoStartAccounts(savedSystemConfig?.autoStartAccounts);
    mainLogger.info('auto login on boot', { autoStartAccounts });

    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId: string, status: any) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry: any, accountId?: string) => {
            // 确保日志条目包含 accountId
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry: any) => {
            emitRealtimeAccountLog(entry);
        },
    });

    runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts,
    }).catch((err: any) => {
        mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
    });
}
