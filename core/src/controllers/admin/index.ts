import type { AdminContext } from './context';
export {};

/**
 * Admin panel HTTP server orchestrator.
 * Thin wrapper that wires up Express, routes, Socket.IO, and shared context.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { CONFIG, DEFAULT_ADMIN_PORT } = require('../../config/config');
const { getResourcePath } = require('../../config/runtime-paths');
const { createModuleLogger } = require('../../services/logger');

const { createAdminContext } = require('./context');
const { mountAuthRoutes } = require('./auth-routes');
const { mountAccountRoutes } = require('./account-routes');
const { mountFarmRoutes } = require('./farm-routes');
const { mountFriendRoutes } = require('./friend-routes');
const { mountActivityCenterRoutes } = require('./activity-center-routes');
const { mountCommerceRoutes } = require('./commerce-routes');
const { mountCareerRoutes } = require('./career-routes');
const { mountPanelNotificationRoutes } = require('./panel-notification-routes');
const { mountWxLoginRoutes } = require('./wx-login-routes');
const { mountQqLoginRoutes } = require('./qq-login-routes');
const {
    setupSocketIO,
    emitRealtimeStatus: _emitStatus,
    emitRealtimeLog: _emitLog,
    emitRealtimeAccountLog: _emitAccountLog,
} = require('./socket');

const adminLogger = createModuleLogger('admin');

let ctx: AdminContext | null = null;

/**
 * Express 4 不会捕获 async handler 的 Promise 拒绝。
 *
 * 后果不是「这个请求失败」，而是**整个主进程退出**：拒绝变成 unhandledRejection，
 * Node 默认以非零码结束进程，所有账号的 worker 一起掉线。实测 `/api/friend-blacklist`
 * 在 provider 返回非数组时就能一击打死服务。
 *
 * 这里在注册阶段把所有路由 handler 包一层：同步抛错和 Promise 拒绝统一转成 next(err)，
 * 再由文件末尾的 JSON 错误中间件返回 500。改动集中在一处，覆盖全部现有与将来的路由。
 */
function guardAsyncRoutes(app: any): void {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
        const original = app[method];
        if (typeof original !== 'function') continue;
        app[method] = function guardedRegister(routePath: any, ...handlers: any[]) {
            // `app.get('env')` 这种取设置的调用没有 handler，原样透传。
            if (handlers.length === 0) return original.call(this, routePath);
            const wrapped = handlers.map((handler: any) => {
                if (typeof handler !== 'function') return handler;
                return function guardedHandler(req: any, res: any, next: any) {
                    let result: any;
                    try {
                        result = handler(req, res, next);
                    } catch (error: any) {
                        next(error);
                        return;
                    }
                    if (result && typeof result.then === 'function') {
                        Promise.resolve(result).catch((error: any) => {
                            next(error);
                        });
                    }
                };
            });
            return original.call(this, routePath, ...wrapped);
        };
    }
}

function startAdminServer(dataProvider: any): void {
    if (ctx) return;

    ctx = createAdminContext(dataProvider);

    const app = express();
    guardAsyncRoutes(app);
    app.set('trust proxy', true);
    app.use(express.json());

    ctx.app = app;

    app.use((req: any, res: any, next: any) => {
        const allowedOrigins: string[] = CONFIG.ALLOWED_ORIGINS || ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
        const origin = req.headers.origin;

        if (origin && allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        } else if (!origin) {
            res.header('Access-Control-Allow-Origin', '*');
        }

        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PUT');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token, x-proxy-api-key, x-proxy-api-url, x-proxy-app-id');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Max-Age', '86400');

        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    const webDist = path.join(__dirname, '../../../../web/dist');
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist));
    } else {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (_req: any, res: any) => res.send('web build not found. Please build the web project.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // Mount route modules
    mountAuthRoutes(app, ctx);
    mountWxLoginRoutes(app, ctx);
    mountQqLoginRoutes(app, ctx);
    mountFarmRoutes(app, ctx);
    mountFriendRoutes(app, ctx);
    mountAccountRoutes(app, ctx);
    mountActivityCenterRoutes(app, ctx);
    mountCommerceRoutes(app, ctx);
    mountCareerRoutes(app, ctx);
    mountPanelNotificationRoutes(app, ctx);

    // SPA fallback
    app.get('*', (req: any, res: any) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        if (fs.existsSync(webDist)) {
            res.sendFile(path.join(webDist, 'index.html'));
        } else {
            res.status(404).send('web build not found. Please build the web project.');
        }
    });

    // 统一错误出口：上面 guardAsyncRoutes 转过来的错误最终都从这里返回。
    //
    // 需要区分两类：请求体解析失败（express.json 抛的 SyntaxError 带 status=400）
    // 是**客户端**把 JSON 拼错了，返回 500 会让人以为服务端崩了；其余才算真的
    // 服务端异常。响应头已经发出时只能断开连接，否则 Express 会抛 ERR_HTTP_HEADERS_SENT。
    app.use((err: any, _req: any, res: any, _next: any) => {
        if (res.headersSent) {
            try {
                res.end();
            } catch {
                // 连接已经断了，忽略
            }
            return;
        }
        const rawStatus = Number(err?.status ?? err?.statusCode);
        const clientStatus = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 500 ? rawStatus : null;
        if (clientStatus) {
            // 不按 error 记：这类是调用方传错，不是服务异常，否则告警会被噪音淹没。
            adminLogger.warn('admin request rejected', {
                status: clientStatus,
                error: String(err?.message || err),
            });
            const message = err?.type === 'entity.too.large' ? '请求体过大' : '请求体不是合法 JSON';
            res.status(clientStatus).json({ ok: false, error: message });
            return;
        }
        adminLogger.error('admin route crashed', {
            error: String(err?.message || err),
            stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | '),
        });
        res.status(500).json({ ok: false, error: String(err?.message || 'Internal Server Error') });
    });

    const port: number = CONFIG.adminPort || DEFAULT_ADMIN_PORT;
    ctx.server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    // Setup Socket.IO
    setupSocketIO(ctx);

}

function emitRealtimeStatus(accountId: string, status: any): void {
    if (!ctx) return;
    _emitStatus(ctx, accountId, status);
}

function emitRealtimeLog(entry: any): void {
    if (!ctx) return;
    _emitLog(ctx, entry);
}

function emitRealtimeAccountLog(entry: any): void {
    if (!ctx) return;
    _emitAccountLog(ctx, entry);
}

module.exports = {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
