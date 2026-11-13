import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Friend-related routes: friends list, friend lands, friend ops,
 * friend-blacklist, friend-known-gids, interact-records.
 */

const store = require('../../models/store');

const {
    getAccId,
    handleApiError,
    isGatewayProtocolError,
    isSoftRuntimeError,
    buildKnownFriendGidSettings,
} = require('./middleware');

/**
 * 取好友列表用于「附加昵称头像」。返回 null 表示已经写过响应，调用方直接 return。
 *
 * `await x || []` 只兜住 null/undefined：provider 若返回对象（错误包 / 空响应），
 * 调用方的 `for...of` 会抛 TypeError —— 而那段代码在 try 之外，Express 4 不捕获
 * async 拒绝，整个主进程会因此退出，所有账号一起掉线。
 */
async function readFriendsForDisplay(ctx: AdminContext, accountId: any, res: Response): Promise<any[] | null> {
    if (!ctx.provider || typeof ctx.provider.getFriends !== 'function') return [];
    try {
        const raw = await ctx.provider.getFriends(accountId);
        return Array.isArray(raw) ? raw : [];
    } catch (error: any) {
        if (isGatewayProtocolError(error) || isSoftRuntimeError(error)) {
            handleApiError(res, error);
            return null;
        }
        // 非协议错误不影响本地数据展示
        return [];
    }
}

function mountFriendRoutes(app: Application, ctx: AdminContext): void {

    // API: 好友列表
    app.get('/api/friends', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        const forceSync = req.query.forceSync === 'true';

        try {
            const data = await ctx.provider.getFriends(id, forceSync);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 仅读取 Worker 内存中的好友列表缓存，不触发任何游戏协议请求。
    app.get('/api/friends/cache', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await ctx.provider.getFriendsCache(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 清除好友列表缓存
    app.post('/api/friends/clear-cache', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            await ctx.provider.clearFriendsCache(id);
            res.json({ ok: true });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 访客
    app.get('/api/interact-records', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await ctx.provider.getInteractRecords(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 好友农田详情
    app.get('/api/friend/:gid/lands', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        try {
            const data = await ctx.provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 背包中当前可用于好友土地的特殊互动道具。
    app.get('/api/friend-interaction-items', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.getFriendInteractionItems(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 在同一次好友访问会话内，按地块编号顺序使用特殊互动道具。
    app.post('/api/friend/:gid/interaction-items/use-batch', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.useFriendInteractionItemBatch(
                id,
                req.params.gid,
                req.body?.itemId,
                req.body?.landIds,
            );
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友农场使用不需要地块目标的特殊互动道具（例如青蛙使坏瓶）。
    app.post('/api/friend/:gid/interaction-items/use-farm', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.useFriendFarmInteractionItem(id, req.params.gid, req.body?.itemId);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友执行单次操作（偷菜/浇水/除草/捣乱）
    app.post('/api/friend/:gid/op', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const opType = String((req.body || {}).opType || '');
            const data = await ctx.provider.doFriendOp(id, req.params.gid, opType);
            if (data && data.ok === false) {
                return res.json({
                    ok: false,
                    error: data.errorMessage || data.message || data.error || '好友操作失败',
                    ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
                    ...(data.errorCode ? { errorCode: data.errorCode } : {}),
                });
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 游戏内删除好友
    app.post('/api/friend/:gid/delete', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const gid = Number(req.params.gid);
            if (!Number.isFinite(gid) || gid <= 0) {
                return res.status(400).json({ ok: false, error: '无效的好友 GID' });
            }
            const data = await ctx.provider.delFriend(id, gid);
            // provider 用 { ok:false } 表达游戏侧拒绝（不抛异常），同文件 /api/friend/:gid/op
            // 已按这个形状判断。原来无条件写黑名单并回报成功，会让本地与游戏内数据分叉。
            if (data && data.ok === false) {
                return res.status(400).json({ ok: false, error: String(data.error || '游戏内删除好友失败') });
            }
            if (store.addFriendToBlacklist) {
                store.addFriendToBlacklist(id, gid);
            }
            if (store.getKnownFriendGids && store.setKnownFriendGids) {
                const current = store.getKnownFriendGids(id) || [];
                const next = current.filter((item: any) => Number(item) !== gid);
                if (next.length !== current.length) {
                    store.setKnownFriendGids(id, next);
                }
            }
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            res.json({ ok: true, message: '删除好友成功', data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 好友黑名单
    app.get('/api/friend-blacklist', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        let gids: number[] = [];
        try {
            gids = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        } catch (e: any) {
            // Express 4 不捕获 async handler 的拒绝：读盘抛错必须就地转成响应，
            // 否则请求永远挂着，并在 Node 20 上变成未处理拒绝。
            return handleApiError(res, e);
        }

        // 尝试获取好友列表以附加昵称和头像。
        // `await x || []` 只兜住了 null/undefined：provider 若返回对象（错误包 / 空响应），
        // 后面的 for...of 会抛 TypeError，而这段代码在 try 之外 —— Express 4 不捕获 async
        // 拒绝，整个主进程会因此退出，所有账号一起掉线。所以这里必须显式判数组。
        const friendsList = await readFriendsForDisplay(ctx, id, res);
        if (friendsList === null) return;

        // 构建好友信息映射
        const friendMap = new Map<number, { name: string; avatarUrl: string }>();
        for (const f of friendsList) {
            const gid = Number(f && f.gid);
            if (gid > 0) {
                friendMap.set(gid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }

        // 构建带好友信息的黑名单
        const list = gids.map((gid: any) => {
            const info = friendMap.get(Number(gid)) || { name: '', avatarUrl: '' };
            return {
                gid: Number(gid),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });

        res.json({ ok: true, data: list });
    });

    app.post('/api/friend-blacklist/toggle', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gid = Number((req.body || {}).gid);
        // 原来 `!gid` 放行 -1 / Infinity：下游会静默过滤掉，路由却回报 ok:true，
        // 前端以为已拉黑。与删除好友接口用同一套正整数校验。
        if (!Number.isInteger(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: '无效的好友 GID' });
        }
        let savedGids: number[];
        try {
            const current = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
            let next: number[];
            if (current.includes(gid)) {
                next = current.filter((g: number) => g !== gid);
            } else {
                next = [...current, gid];
            }
            savedGids = store.setFriendBlacklist ? store.setFriendBlacklist(id, next) : next;

            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
        } catch (e: any) {
            return handleApiError(res, e);
        }

        // 尝试获取好友列表以附加昵称和头像。
        // `await x || []` 只兜住了 null/undefined：provider 若返回对象（错误包 / 空响应），
        // 后面的 for...of 会抛 TypeError，而这段代码在 try 之外 —— Express 4 不捕获 async
        // 拒绝，整个主进程会因此退出，所有账号一起掉线。所以这里必须显式判数组。
        const friendsList = await readFriendsForDisplay(ctx, id, res);
        if (friendsList === null) return;

        // 构建好友信息映射
        const friendMap = new Map<number, { name: string; avatarUrl: string }>();
        for (const f of friendsList) {
            const fGid = Number(f && f.gid);
            if (fGid > 0) {
                friendMap.set(fGid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }

        // 构建带好友信息的黑名单
        const saved = savedGids.map((g: any) => {
            const info = friendMap.get(Number(g)) || { name: '', avatarUrl: '' };
            return {
                gid: Number(g),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });

        res.json({ ok: true, data: saved });
    });

    // ============ 好友GID管理 API ============

    // 获取已知好友GID设置
    app.get('/api/friend-known-gids', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 保存已知好友GID设置
    app.post('/api/friend-known-gids', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (body.knownFriendGids !== undefined && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, body.knownFriendGids);
            }
            if (body.knownFriendGidSyncCooldownSec !== undefined && store.setKnownFriendGidSyncCooldownSec) {
                store.setKnownFriendGidSyncCooldownSec(id, body.knownFriendGidSyncCooldownSec);
            }
            if (body.friendsListCacheTtlSec !== undefined && store.setFriendsListCacheTtlSec) {
                store.setFriendsListCacheTtlSec(id, body.friendsListCacheTtlSec);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 移除单个好友GID
    app.post('/api/friend-known-gids/remove', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? current.filter((item: any) => Number(item) !== gid) : [];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 批量添加好友GID
    app.post('/api/friend-known-gids/batch-add', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.status(400).json({ ok: false, error: 'GID 列表无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const currentSet = new Set(current.map(Number));
            let addedCount = 0;
            for (const gid of gids) {
                const num = Number(gid);
                if (!Number.isFinite(num) || num <= 0) continue;
                if (!currentSet.has(num)) {
                    currentSet.add(num);
                    addedCount++;
                }
            }
            const next = Array.from(currentSet);
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({
                ok: true,
                data: buildKnownFriendGidSettings(id),
                addedCount,
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 批量删除未同步的好友GID
    app.post('/api/friend-known-gids/batch-remove', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id), removedCount: 0 });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const removeSet = new Set(gids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0));
            const next = current.filter((gid: any) => !removeSet.has(Number(gid)));
            const removedCount = current.length - next.length;

            if (removedCount > 0 && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }

            return res.json({
                ok: true,
                data: buildKnownFriendGidSettings(id),
                removedCount,
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });
}

module.exports = { mountFriendRoutes };
