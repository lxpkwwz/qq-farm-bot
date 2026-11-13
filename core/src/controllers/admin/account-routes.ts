import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Account CRUD routes, account-logs, logs, and settings routes.
 */

const store = require('../../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef } = require('../../services/account-resolver');
const { toPublicAccountsData } = require('../../services/account-visibility');
const { parseLogLimit, mergeLogLists } = require('../../services/log-query');
const { clearAccountRuntimeState } = require('../../services/account-runtime-state');
const { getPreflightStatsSnapshot } = require('../../services/preflight-stats');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig, getDevicePresets, getTimeZoneOptions } = require('../../config/config');

const {
    getAccId,
    getAccountIds,
    handleApiError,
    getAccountList,
    resolveAccId,
} = require('./middleware');

/** 账号 Code 自动监听：聚合微信凭证到期与 QQ 掉线日志，给出每账号的补 Code 状态。 */
function buildProviderCodeHealth(ctx: AdminContext): any {
    const { buildCodeHealthSnapshot } = require('../../services/code-watch');
    const accounts = ctx.provider.getAccounts().accounts || [];
    const rawLogs = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(200) : [];
    return buildCodeHealthSnapshot(accounts, {
        accountLogs: Array.isArray(rawLogs) ? rawLogs : [],
        isAccountRunning: (id: string) => !!(ctx.provider.isAccountRunning && ctx.provider.isAccountRunning(id)),
    });
}

function mountAccountRoutes(app: Application, ctx: AdminContext): void {

    // API: 账号管理
    app.get('/api/accounts', (req: Request, res: Response) => {
        try {
            const data = ctx.provider.getAccounts();
            // 只把「能不能免扫码恢复」的判定结果发给浏览器，不下发长效凭证明文。
            // 两个口径都要发：wxPreflightSupported = 能滚 token（wxid + refreshtoken），
            // wxCanRecover = 掉线后能免扫码换 Code（再加上只有 loginBuffer 的情况），
            // 后者与 wx-keepalive 的 canRecoverAccount 完全同一个函数。
            // 同时附带自动续期账本快照（仅时间戳与次数），供卡片显示无人值守结果。
            const { hasWxCredential } = require('../../services/wx-credential');
            const { canRecoverAccount } = require('../../services/wx-keepalive');
            res.json({ ok: true, data: toPublicAccountsData(data, hasWxCredential, getPreflightStatsSnapshot(), canRecoverAccount) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: Code 自动监听快照（账号管理页 10 秒轮询；路由必须在 :id 之前注册）
    app.get('/api/accounts/code-health', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: buildProviderCodeHealth(ctx) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 自动补 Code（微信免扫码换码 / QQ 尽力重签），失败则引导重新扫码或手填 Code
    app.post('/api/accounts/:id/auto-fix-code', async (req: Request, res: Response) => {
        try {
            const { autoFixAccountCode } = require('../../services/code-watch');
            const { ensureFreshGameCode } = require('../../services/wx-credential');
            const { tryRefreshQqGameCode } = require('../../services/qq-credential');
            const { appendPanelNotification } = require('../../services/panel-notification');
            const accountId = resolveAccId(ctx, req.params.id) || String(req.params.id || '');
            const accounts = ctx.provider.getAccounts().accounts || [];
            const health = buildProviderCodeHealth(ctx);
            const target = health.items.find((entry: any) => String(entry.accountId) === accountId);
            const result = await autoFixAccountCode(accountId, {
                getAccount: (id: string) => accounts.find((account: any) => String(account.id) === id) || null,
                latestLogAction: String(target?.latestLogAction || ''),
                ensureFreshGameCode,
                tryRefreshQqGameCode,
                isAccountRunning: (id: string) => !!(ctx.provider.isAccountRunning && ctx.provider.isAccountRunning(id)),
                restartAccount: (id: string) => ctx.provider.restartAccount(id),
                addAccountLog: (...args: any[]) => {
                    if (ctx.provider.addAccountLog) ctx.provider.addAccountLog(...args);
                },
                notify: (id: string, entry: any) => {
                    try { appendPanelNotification(id, entry); } catch { /* 通知落盘失败不阻断补码结果 */ }
                },
            });
            res.json({ ok: result.ok, ...(result.ok ? {} : { error: result.error }), data: result });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList(ctx);
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (ctx.provider && typeof ctx.provider.setRuntimeAccountName === 'function') {
                ctx.provider.setRuntimeAccountName(accountId, remark);
            }
            if (ctx.provider && ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/accounts', (req: Request, res: Response) => {
        try {
            const rawBody = (req.body && typeof req.body === 'object') ? req.body : {};
            const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
            const body = typeof rawBody.name === 'string' ? { ...rawBody, name: requestedName } : rawBody;
            if (!requestedName) {
                return res.status(400).json({ ok: false, error: '账号备注不能为空' });
            }
            const visibleAccounts = getAccountList(ctx);
            const remarkMatchedAccount = !body.id && requestedName
                ? visibleAccounts.find((account: any) => String(account.name || '').trim() === requestedName)
                : null;
            const isRemarkRelogin = !!remarkMatchedAccount;
            const updateRef = body.id || (remarkMatchedAccount && remarkMatchedAccount.id) || '';
            const isUpdate = !!updateRef;

            const resolvedUpdateId = isUpdate ? resolveAccId(ctx, updateRef) : '';
            const payload = isUpdate ? { ...body, id: resolvedUpdateId || String(updateRef) } : body;
            let wasRunning = false;
            if (isUpdate && ctx.provider.isAccountRunning) {
                wasRunning = ctx.provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = ctx.provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find((a: any) => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            /**
             * 是否属于「重新登录」。
             *
             * 以前只能靠备注名碰巧匹配到已有账号来识别（isRemarkRelogin），
             * 那条分支会无条件 restartAccount，所以停止中的账号重扫后也会被拉起来。
             * 现在前端编辑态重扫/填新 Code 会显式带上账号 id（为了把新凭据写回原账号、
             * 不再产生重复账号），带 id 就不再走备注匹配，于是掉进
             * `wasRunning && !onlyRemarkChanged` 分支 —— 账号本来是停止状态时
             * wasRunning 为 false，结果既不重启也不启动，用户看到的就是
             * 「重新扫码/填完新 Code 后不会直接登录」。
             *
             * 因此这里把「带 id 且携带新登录凭据」也认定为重新登录。
             */
            const hasLoginCredential = !!(payload.code || payload.refreshtoken || payload.loginBuffer);
            const isRelogin = isRemarkRelogin
                || (isUpdate && !onlyRemarkChanged && hasLoginCredential);

            const data = addOrUpdateAccount(payload);
            if (ctx.provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts.at(-1) || {}).id || '');
                const accountName = payload.name || '';
                ctx.provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isRelogin
                        ? `通过备注重新登录账号: ${accountName || accountId}`
                        : isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 新增账号直接启动；重新登录无论此前是否在跑都要用新凭据上线。
            if (!isUpdate) {
                const newAcc = data.accounts.at(-1);
                if (newAcc) Promise.resolve(ctx.provider.startAccount(newAcc.id)).catch(() => {});
            } else if (isRelogin) {
                // 在跑：重建 worker 让新凭据立即生效；已停止：直接启动（启动前会先换码）。
                if (wasRunning) ctx.provider.restartAccount(payload.id);
                else Promise.resolve(ctx.provider.startAccount(payload.id)).catch(() => {});
            } else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                ctx.provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 续期微信授权（批量）。返回每个账号的结果，前端据此提示成功/失败数量。
    // 与启动前换码一致：优先用长效 loginBuffer 直接换 Code，只有失效时才滚动
    // refreshtoken，避免每次点按钮都消耗一次性滚动凭证导致失败。
    async function refreshWxCredentials(req: Request, res: Response): Promise<any> {
        try {
            const { hasRenewableCredential, ensureFreshGameCode } = require('../../services/wx-credential');
            const accounts = (ctx.provider.getAccounts().accounts || []);
            const wxAccounts = accounts.filter((account: any) => String(account.platform || '') === 'wx');
            const targetAccounts = wxAccounts.filter((account: any) => hasRenewableCredential(account));
            if (targetAccounts.length === 0) {
                return res.json({
                    ok: false,
                    error: wxAccounts.length === 0 ? '当前没有微信账号' : '没有可续期的微信账号，请重新扫码登录',
                    data: { total: 0, success: 0, failed: 0, skipped: wxAccounts.length },
                });
            }

            const results: any[] = [];
            for (const account of targetAccounts) {
                const result = await ensureFreshGameCode(account.id);
                results.push({
                    accountId: String(account.id),
                    name: result.accountName,
                    ok: result.ok,
                    error: result.ok ? '' : (result.error || '续期失败'),
                });
            }

            const success = results.filter(item => item.ok).length;
            const failed = results.length - success;
            if (ctx.provider.addAccountLog) {
                const detail = results.map(item => `${item.name}${item.ok ? '✓' : '✗'}`).join('、');
                ctx.provider.addAccountLog(
                    failed === 0 ? 'refresh_wx_credentials' : 'refresh_wx_credentials_failed',
                    `续期微信授权：成功 ${success} 个，失败 ${failed} 个（${detail}）`,
                    '',
                    '',
                );
            }
            res.json({
                ok: failed === 0,
                ...(failed > 0 ? { error: `${failed} 个账号续期失败` } : {}),
                data: {
                    total: results.length,
                    success,
                    failed,
                    skipped: wxAccounts.length - targetAccounts.length,
                    results,
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    }

    app.post('/api/accounts/refresh-wx-credentials', refreshWxCredentials);
    app.post('/api/accounts/refresh-wx-codes', refreshWxCredentials);

    app.post('/api/accounts/:id/refresh-wx-credential', async (req: Request, res: Response) => {
        try {
            const { ensureFreshGameCode } = require('../../services/wx-credential');
            const accountId = resolveAccId(ctx, req.params.id) || String(req.params.id || '');
            const result = await ensureFreshGameCode(accountId);
            res.status(result.ok ? 200 : 400).json({
                ok: result.ok,
                ...(result.ok ? {} : { error: result.error || '续期失败' }),
                data: result,
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/accounts/:id', (req: Request, res: Response) => {
        try {
            const resolvedId = resolveAccId(ctx, req.params.id) || String(req.params.id || '');

            const before = ctx.provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            ctx.provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            // 账号已删除，状态账本里的记录也要一起摘掉：否则同 id 的账号重新
            // 加回来时会先继承上一次的「已掉线 / 停止中」，面板闪一下错误状态。
            clearAccountRuntimeState(resolvedId);
            if (ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req: Request, res: Response) => {
        try {
            const limit = parseLogLimit(req.query.limit);
            let list: any[] = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list)) list = [];

            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 日志
    app.get('/api/logs', (req: Request, res: Response) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(ctx, queryAccountIdRaw)) : getAccId(ctx, req);
        // 如果没有指定账号ID，获取所有账号的日志
        if (!id) {
            const accountIds = getAccountIds(ctx);
            const perAccountLogs: any[][] = [];
            const options = {
                limit: parseLogLimit(req.query.limit),
                tag: req.query.tag || '',
                module: req.query.module || '',
                event: req.query.event || '',
                keyword: req.query.keyword || '',
                isWarn: req.query.isWarn,
                timeFrom: req.query.timeFrom || '',
                timeTo: req.query.timeTo || '',
            };

            for (const accId of accountIds) {
                const logs = ctx.provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    perAccountLogs.push(logs);
                }
            }

            // 按时间升序合并，再取最新的 limit 条（与单账号分支 slice(-limit) 的朝向一致）。
            const limitedLogs = mergeLogLists(perAccountLogs, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 指定了账号ID且通过权限检查，返回该账号的日志
        const options = {
            limit: parseLogLimit(req.query.limit),
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        const list = ctx.provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = ctx.provider.clearLogs(id);

            if (ctx.io && ctx.provider && typeof ctx.provider.getLogs === 'function') {
                const accountLogs = ctx.provider.getLogs(id, { limit: 100 });
                ctx.io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = ctx.provider.getLogs('', { limit: 100 });
                ctx.io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置页统一保存（单次写入；运行中账号等待 worker revision ACK）
    app.post('/api/settings/save', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        try {
            const data = await ctx.provider.saveSettings(id, req.body || {});
            const unconfirmed = data && data.status === 'unconfirmed';
            res.status(unconfirmed ? 202 : 200).json({
                ok: !unconfirmed,
                saved: !!(data && data.saved),
                stopped: !!(data && data.status === 'stopped'),
                confirmed: !!(data && data.confirmed),
                unconfirmed: !!unconfirmed,
                status: data?.status,
                code: unconfirmed ? data.confirmationError?.code : undefined,
                error: unconfirmed ? (data.confirmationError?.message || '配置已保存，但 worker 尚未确认应用') : undefined,
                data: data || {},
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', async (req: Request, res: Response) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await ctx.provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 保存下线提醒配置
    app.post('/api/settings/offline-reminder', async (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const channel = String(body.channel || '').trim().toLowerCase();
            if (channel === 'dingtalk') {
                try {
                    const { buildDingTalkWebhook } = require('../../services/push');
                    buildDingTalkWebhook(body.endpoint, body.token, body.secret);
                } catch (error: any) {
                    return res.status(400).json({ ok: false, error: error?.message || '钉钉 Webhook 地址格式无效' });
                }
            }
            const data = store.setOfflineReminder ? store.setOfflineReminder(body) : {};
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', async (req: Request, res: Response) => {
        try {
            const saved = store.getOfflineReminder ? store.getOfflineReminder() : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const secret = String(cfg.secret || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 渠道需要填写接口地址' });
            }
            if (channel === 'dingtalk' && !endpoint && !token) {
                return res.status(400).json({ ok: false, error: '钉钉渠道需要填写 Webhook 地址' });
            }
            if (channel !== 'webhook' && channel !== 'dingtalk' && !token) {
                return res.status(400).json({ ok: false, error: '当前推送渠道需要填写 Token' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const { sendPushooMessage } = require('../../services/push');
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                secret,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
            });

            if (!ret) {
                return res.status(400).json({ ok: false, error: '推送失败：无返回结果' });
            }

            const isSuccess = ret.ok ||
                ret.code === 'ok' ||
                ret.code === '0' ||
                String(ret.msg || '').includes('成功') ||
                String(ret.raw?.status || '').toLowerCase() === 'success';

            if (!isSuccess && ret.msg && !String(ret.msg).includes('成功')) {
                return res.status(400).json({ ok: false, error: ret.msg || '推送失败', data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '推送成功' });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = id ? store.getIntervals(id) : {};
            const strategy = id ? store.getPlantingStrategy(id) : null;
            const preferredSeed = id ? store.getPreferredSeed(id) : null;
            const friendQuietHours = id ? store.getFriendQuietHours(id) : null;
            const automation = id ? store.getAutomation(id) : {};
            const stealDelaySeconds = id && (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = id && (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = id && (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const fertilizerBuyOrganicCount = id && (typeof store.getFertilizerBuyOrganicCount === 'function') ? store.getFertilizerBuyOrganicCount(id) : 0;
            const fertilizerBuyOrganicThresholdHours = id && (typeof store.getFertilizerBuyOrganicThresholdHours === 'function') ? store.getFertilizerBuyOrganicThresholdHours(id) : 10;
            const fertilizerBuyNormalCount = id && (typeof store.getFertilizerBuyNormalCount === 'function') ? store.getFertilizerBuyNormalCount(id) : 0;
            const fertilizerBuyNormalThresholdHours = id && (typeof store.getFertilizerBuyNormalThresholdHours === 'function') ? store.getFertilizerBuyNormalThresholdHours(id) : 10;
            const fertilizerBuyCheckIntervalMinutes = id && (typeof store.getFertilizerBuyCheckIntervalMinutes === 'function') ? store.getFertilizerBuyCheckIntervalMinutes(id) : 30;
            const bagSeedPriority = id && (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedMultiLandReservationEnabled = id && (typeof store.getBagSeedMultiLandReservationEnabled === 'function') ? store.getBagSeedMultiLandReservationEnabled(id) : false;
            const bagSeedLandTypes = id && (typeof store.getBagSeedLandTypes === 'function') ? store.getBagSeedLandTypes(id) : {};
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const prioritize2x2Crops = id && (typeof store.getPrioritize2x2Crops === 'function') ? store.getPrioritize2x2Crops(id) : false;
            const autoAcceptFriendMinLevel = id && (typeof store.getAutoAcceptFriendMinLevel === 'function') ? store.getAutoAcceptFriendMinLevel(id) : 0;
            const autoAcceptRequireOwnLevel = id && (typeof store.getAutoAcceptRequireOwnLevel === 'function') ? store.getAutoAcceptRequireOwnLevel(id) : false;
            const autoAcceptHarvestStealEnabled = id && (typeof store.getAutoAcceptHarvestStealEnabled === 'function') ? store.getAutoAcceptHarvestStealEnabled(id) : true;
            const autoAcceptHarvestStealHarvest = id && (typeof store.getAutoAcceptHarvestStealHarvest === 'function') ? store.getAutoAcceptHarvestStealHarvest(id) : 8;
            const autoAcceptHarvestStealSteal = id && (typeof store.getAutoAcceptHarvestStealSteal === 'function') ? store.getAutoAcceptHarvestStealSteal(id) : 1;
            // 邮箱时刻与黄金虫策略也必须随 GET 下发：只靠保存接口回传的话，
            // 刷新页面后输入框会退回默认值，看起来像「保存没生效」。
            const accountConfig = id ? store.getConfigSnapshot(id) : null;
            const emailClaimHour = accountConfig ? accountConfig.emailClaimHour : 10;
            const goldenBugKeepCount = accountConfig ? accountConfig.goldenBugKeepCount : 0;
            const goldenBugRoundLimit = accountConfig ? accountConfig.goldenBugRoundLimit : 24;
            const ui = store.getUI();
            const offlineReminder = store.getOfflineReminder
                ? store.getOfflineReminder()
                : { channel: 'webhook', endpoint: '', token: '', secret: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedMultiLandReservationEnabled, bagSeedLandTypes, bagSeedFallbackStrategy, prioritize2x2Crops, autoAcceptFriendMinLevel, autoAcceptRequireOwnLevel, autoAcceptHarvestStealEnabled, autoAcceptHarvestStealHarvest, autoAcceptHarvestStealSteal, ui, offlineReminder, emailClaimHour, goldenBugKeepCount, goldenBugRoundLimit } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取默认配置
    app.get('/api/settings/default', (_req: Request, res: Response) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/device-presets', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: getDevicePresets() });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/system-config', (_req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                data: {
                    saved: store.getSystemConfig(),
                    default: getDefaultSystemConfig(),
                    current: getRuntimeConfig(),
                    timeZones: getTimeZoneOptions(),
                    loginSettings: store.getLoginSettings
                        ? store.getLoginSettings()
                        : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' },
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/login-config', (_req: Request, res: Response) => {
        try {
            const loginSettings = store.getLoginSettings
                ? store.getLoginSettings()
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/login-config', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const loginSettings = store.setLoginSettings
                ? store.setLoginSettings({
                    wechatQrLogin: body.wechatQrLogin,
                    qqQrLogin: body.qqQrLogin,
                    napCatEndpoint: body.napCatEndpoint,
                    napCatSignature: body.napCatSignature,
                })
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config', (req: Request, res: Response) => {
        try {
            const { serverUrl, clientVersion, wxClientVersion, platform, os, timeZone, deviceInfo, autoCodeRefresh, autoStartAccounts } = req.body || {};
            const saved = store.setSystemConfig({ serverUrl, clientVersion, wxClientVersion, platform, os, timeZone, deviceInfo, autoCodeRefresh, autoStartAccounts });
            updateRuntimeConfig(saved);
            if (autoCodeRefresh !== undefined && ctx.provider.applyAccountKeepAliveConfig) {
                ctx.provider.applyAccountKeepAliveConfig();
            }
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            // Keep live sessions intact. A new login must use a fresh one-time Code.
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config/reset', (_req: Request, res: Response) => {
        try {
            const saved = getDefaultSystemConfig();
            store.setSystemConfig(saved);
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            // Keep live sessions intact. A new login must use a fresh one-time Code.
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountAccountRoutes };
