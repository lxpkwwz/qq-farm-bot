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
        fs.renameSync(tmpPath, filePath);
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
    readTextFile,
    readJsonFile,
    readJsonFileStrict,
    storageError,
    writeTextFileAtomic,
    writeJsonFileAtomic,
};
