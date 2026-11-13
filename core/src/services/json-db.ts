export {};
const fs = require('node:fs');
const path = require('node:path');
function ensureParentDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function readTextFile(filePath: string, fallback = ''): string {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return fallback;
    }
}

function readJsonFile(filePath: string, fallbackFactory: () => any = () => ({})): any {
    const fallback = typeof fallbackFactory === 'function' ? fallbackFactory() : (fallbackFactory || {});
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

// Configuration reads must distinguish a missing file from a damaged or unreadable one.
// Keep the existing tolerant readers unchanged for their current callers.
function storageError(action: string, filePath: string, cause: any): Error {
    if (String(cause?.code || '').startsWith('STORAGE_')) return cause;
    const code = action === '读取' ? 'STORAGE_READ_FAILED'
        : action === '迁移' ? 'STORAGE_MIGRATION_FAILED' : 'STORAGE_WRITE_FAILED';
    return Object.assign(new Error(`${action} ${path.basename(filePath)} 失败，请检查数据文件、目录权限和磁盘空间`, { cause }), {
        code, filePath,
    });
}

function readJsonFileStrict(filePath: string, fallbackFactory?: () => any): any {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error: any) {
        if (error.code === 'ENOENT' && fallbackFactory) return fallbackFactory();
        throw storageError('读取', filePath, error);
    }
    try {
        return JSON.parse(raw);
    } catch (error: any) {
        throw storageError('读取', filePath, error);
    }
}

/** 同步睡一小会儿（不烧 CPU）：只在 rename 重试之间用。 */
function sleepSync(ms: number): void {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        const until = Date.now() + ms;
        while (Date.now() < until) { /* 退化路径：极少数环境没有 SharedArrayBuffer */ }
    }
}

const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

/**
 * 原子替换文件，对 Windows 特有的瞬时占用做重试。
 *
 * 实测：在 Windows 上只要目标文件被别的进程（杀毒软件、Everything、同步盘、
 * 编辑器）持有读句柄，`renameSync` 就稳定报 `EPERM`——本机验证持有句柄时
 * 200/200 全部失败、放开后 200/200 全部成功。这些占用通常只有几十毫秒，
 * 直接抛出会让配置写盘、每日状态记录偶发失败（表现为「刚改的设置重启后没了」）。
 *
 * 只对 EPERM / EACCES / EBUSY 重试；其它错误（磁盘满、路径不存在）立刻抛出。
 */
function renameWithRetry(from: string, to: string): void {
    let lastError: any = null;
    for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (error: any) {
            const code = String(error?.code || '');
            lastError = error;
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
            const delay = RENAME_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) break;
            sleepSync(delay);
        }
    }
    throw lastError;
}

function writeJsonFileAtomic(filePath: string, data: any, space = 2): void {
    const json = JSON.stringify(data, null, space);
    writeTextFileAtomic(filePath, json);
}

function writeTextFileAtomic(filePath: string, text = ''): void {
    ensureParentDir(filePath);
    // 临时名带随机后缀：worker 与主进程同 pid，同一毫秒写同一路径时只靠
    // pid+毫秒会撞名，后写者覆盖前者的临时文件，先 rename 的会带走对方的内容。
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

    let fd: number | null = null;
    try {
        fd = fs.openSync(tmpPath, 'w');
        fs.writeFileSync(fd, String(text), 'utf8');
        // rename 之前必须 fsync：否则断电或容器被 kill 时，目录项已切换但数据还在页缓存里，
        // 结果是一个 0 字节的「新」文件——对配置类文件等于整份配置归零。
        try {
            fs.fsyncSync(fd);
        } catch {
            // 少数文件系统（部分网络卷）不支持 fsync，退化为原来的行为
        }
        fs.closeSync(fd);
        fd = null;
        renameWithRetry(tmpPath, filePath);
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            // ignore cleanup errors
        }
    }
}

module.exports = {
    renameWithRetry,
    readTextFile,
    readJsonFile,
    readJsonFileStrict,
    storageError,
    writeTextFileAtomic,
    writeJsonFileAtomic,
};
