export {};
const fs = require('node:fs');
const path = require('node:path');
const { ensureDataDir } = require('../config/runtime-paths');

let winston: any = null;
try {
    winston = require('winston');
} catch {
    winston = null;
}

const DIAGNOSTIC_CODE_KEY_RE = /^(?:disconnect|close|error|http|status|exit|reason)Code$/i;
const SENSITIVE_KEY_RE = /code|token|password|passwd|auth|ticket|cookie|session/i;

// 日志体积上限：logs 是命名卷，运行期只追加不清理会一直涨。
// 用「定时检查 + 截断」而不是 winston 的 maxsize 轮转 —— 后者在 winston 3.19 +
// Node 20 上实测会写出 0 字节空文件（maxsize / maxsize+maxFiles / maxsize+tailable
// 三种组合都一样），等于静默丢日志。截断时文件句柄依然有效，winston 可继续追加。
const LOG_FILE_NAMES = ['combined.log', 'error.log'];
const LOG_TRIM_INTERVAL_MS = 5 * 60 * 1000;
let logTrimTimer: any = null;

function parsePositiveInt(raw: any, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 超过上限的文件截断为 0 字节，返回被截断的文件名。 */
function trimLogsIfOversize(logDir: string, maxBytes: number): string[] {
    const trimmed: string[] = [];
    for (const name of LOG_FILE_NAMES) {
        const file = path.join(logDir, name);
        try {
            if (fs.statSync(file).size > maxBytes) {
                fs.truncateSync(file, 0);
                trimmed.push(name);
            }
        } catch {
            // 文件还没创建时 stat 会抛 ENOENT，忽略即可
        }
    }
    return trimmed;
}

function startLogSizeGuard(logDir: string, maxBytes: number): void {
    if (logTrimTimer || !(maxBytes > 0)) return;
    logTrimTimer = setInterval(() => {
        trimLogsIfOversize(logDir, maxBytes);
    }, LOG_TRIM_INTERVAL_MS);
    // 不让这个定时器拖住进程退出（测试/CLI 场景很重要）
    if (typeof logTrimTimer.unref === 'function') logTrimTimer.unref();
}

function redactString(input: any): string {
    let text = String(input || '');
    text = text.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
    text = text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
    return text;
}

function sanitizeMeta(value: any, depth = 0): any {
    if (depth > 4) return '[Truncated]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => sanitizeMeta(v, depth + 1));

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        if (DIAGNOSTIC_CODE_KEY_RE.test(k) && typeof v === 'number' && Number.isSafeInteger(v)) {
            out[k] = v;
        } else if (SENSITIVE_KEY_RE.test(String(k))) {
            out[k] = '[REDACTED]';
        } else {
            out[k] = sanitizeMeta(v, depth + 1);
        }
    }
    return out;
}

let fallbackLogDir: string | null = null;

function ensureFallbackLogDir(): string {
    if (fallbackLogDir) return fallbackLogDir;
    const dataDir = ensureDataDir();
    const dir = path.join(dataDir, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 降级模式写的是同一对 combined.log / error.log，也必须受体积上限约束。
    // 原来只有 winston 初始化成功时才启动守卫，可 winston 加载失败恰恰就是
    // 最容易无限追加的场景（容器里依赖被裁剪），logs 是会一直涨的命名卷。
    // startLogSizeGuard 幂等（已有 logTrimTimer 直接返回）。
    startLogSizeGuard(dir, parsePositiveInt(process.env.LOG_MAX_SIZE_MB, 100) * 1024 * 1024);
    fallbackLogDir = dir;
    return fallbackLogDir;
}

function appendFallbackLog(level: string, moduleName: string, message: string, meta: any): void {
    try {
        const dir = ensureFallbackLogDir();
        const payload = {
            ts: new Date().toISOString(),
            level,
            module: moduleName,
            message: redactString(message),
            meta: sanitizeMeta(meta || {}),
        };
        const line = `${JSON.stringify(payload)}\n`;
        fs.appendFileSync(path.join(dir, 'combined.log'), line, 'utf8');
        if (level === 'error') {
            fs.appendFileSync(path.join(dir, 'error.log'), line, 'utf8');
        }
    } catch {
        // ignore file write errors in fallback mode
    }
}

interface ModuleLogger {
    info: (message: string, meta?: any) => void;
    warn: (message: string, meta?: any) => void;
    error: (message: string, meta?: any) => void;
    debug: (message: string, meta?: any) => void;
}

function createConsoleFallback(moduleName: string): ModuleLogger {
    const write = (level: string, message: string, meta: any) => {
        const ts = new Date().toISOString();
        const safeMsg = redactString(message);
        const safeMeta = sanitizeMeta(meta);
        appendFallbackLog(level, moduleName, safeMsg, safeMeta);
        if (safeMeta && Object.keys(safeMeta).length > 0) {
            console.warn(`[${ts}] [${level}] [${moduleName}] ${safeMsg} ${JSON.stringify(safeMeta)}`);
        } else {
            console.warn(`[${ts}] [${level}] [${moduleName}] ${safeMsg}`);
        }
    };
    return {
        info: (message: string, meta?: any) => write('info', message, meta),
        warn: (message: string, meta?: any) => write('warn', message, meta),
        error: (message: string, meta?: any) => write('error', message, meta),
        debug: (message: string, meta?: any) => write('debug', message, meta),
    };
}

let rootLogger: any = null;

function getRootLogger(): any {
    if (rootLogger) return rootLogger;

    if (!winston) {
        rootLogger = null;
        return rootLogger;
    }

    const dataDir = ensureDataDir();
    const logDir = path.join(dataDir, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const level = String(process.env.LOG_LEVEL || 'info').toLowerCase();
    const { combine, timestamp, errors, json, colorize, printf } = winston.format;

    // 日志体积上限：logs 是命名卷，不设上限会一直涨（NAS 上 docker system df 把它
    // 算进 VOLUME，很容易被误当成「构建缓存没清干净」）。
    // 这里刻意不用 winston 自带的 maxsize 轮转：实测 winston 3.19 在 Node 20 下，
    // maxsize / maxsize+maxFiles / maxsize+tailable 三种组合写出来全是 0 字节空文件，
    // 一旦启用等于把日志静默丢掉。改成定时检查 + 截断，见 startLogSizeGuard。
    const maxSizeMb = parsePositiveInt(process.env.LOG_MAX_SIZE_MB, 100);
    startLogSizeGuard(logDir, maxSizeMb * 1024 * 1024);

    rootLogger = winston.createLogger({
        level,
        defaultMeta: { app: 'qq-farm-bot' },
        transports: [
            new winston.transports.Console({
                format: combine(
                    colorize(),
                    timestamp(),
                    errors({ stack: true }),
                    printf((info: any) => {
                        const moduleName = info.module ? `[${info.module}] ` : '';
                        const msg = redactString(info.message || '');
                        const meta = { ...info };
                        delete meta.level;
                        delete meta.message;
                        delete meta.timestamp;
                        delete meta.app;
                        delete meta.module;
                        const safeMeta = sanitizeMeta(meta);
                        const hasMeta = safeMeta && Object.keys(safeMeta).length > 0;
                        return `${info.timestamp} [${info.level}] ${moduleName}${msg}${hasMeta ? ` ${JSON.stringify(safeMeta)}` : ''}`;
                    }),
                ),
            }),
            new winston.transports.File({
                filename: path.join(logDir, 'combined.log'),
                format: combine(timestamp(), errors({ stack: true }), json()),
            }),
            new winston.transports.File({
                filename: path.join(logDir, 'error.log'),
                level: 'error',
                format: combine(timestamp(), errors({ stack: true }), json()),
            }),
        ],
    });

    return rootLogger;
}

function createModuleLogger(moduleName = 'app'): ModuleLogger {
    const moduleTag = String(moduleName || 'app');
    const root = getRootLogger();
    if (!root) return createConsoleFallback(moduleTag);

    const child = root.child({ module: moduleTag });
    return {
        info(message: string, meta = {}) {
            child.info(redactString(message), sanitizeMeta(meta));
        },
        warn(message: string, meta = {}) {
            child.warn(redactString(message), sanitizeMeta(meta));
        },
        error(message: string, meta = {}) {
            child.error(redactString(message), sanitizeMeta(meta));
        },
        debug(message: string, meta = {}) {
            child.debug(redactString(message), sanitizeMeta(meta));
        },
    };
}

module.exports = {
    createModuleLogger,
    sanitizeMeta,
    redactString,
    trimLogsIfOversize,
    parsePositiveInt,
};
