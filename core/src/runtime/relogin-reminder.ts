export {};

interface ReloginReminderOptions {
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    log: (tag: string, msg: string, extra?: any) => void;
}

interface OfflineReminderPayload {
    accountId?: string;
    accountName?: string;
    reason?: string;
    offlineMs?: number;
}

/** 同一账号的下线提醒最小间隔：掉线自动重登循环是分钟级的，不节流会刷屏。 */
const OFFLINE_REMINDER_MIN_INTERVAL_MS = 10 * 60_000;

function createReloginReminderService(options: ReloginReminderOptions) {
    const { store, sendPushooMessage, log } = options;
    // 账号 → 最近一次实际推送时间（毫秒）
    const lastReminderAt: Map<string, number> = new Map();

    function getOfflineAutoDeleteMs(): number {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        const sec = Math.max(0, Number.parseInt(cfg?.offlineDeleteSec, 10) || 0);
        return sec === 0 ? Infinity : sec * 1000;
    }

    function resolvePushChannel(): { ok: true; channel: string; endpoint: string; token: string; secret: string } | { ok: false; reason: string } {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        if (!cfg) return { ok: false, reason: '未找到下线提醒配置' };

        const channel = String(cfg.channel || '').trim().toLowerCase();
        const endpoint = String(cfg.endpoint || '').trim();
        const token = String(cfg.token || '').trim();
        const secret = String(cfg.secret || '').trim();
        if (!channel) return { ok: false, reason: '下线提醒配置不完整' };
        if (channel === 'webhook' && !endpoint) return { ok: false, reason: 'Webhook 渠道未设置接口地址' };
        // 钉钉必须有 endpoint：token 单独存在也发不出去，原来用 `&&` 会让这种
        // 必然失败的配置通过校验，只在日志里留下一条「发送失败」。
        if (channel === 'dingtalk' && !endpoint) return { ok: false, reason: '钉钉渠道未设置 Webhook 地址' };
        if (channel !== 'webhook' && channel !== 'dingtalk' && !token) return { ok: false, reason: '下线提醒渠道未设置 Token' };
        return { ok: true, channel, endpoint, token, secret };
    }

    async function sendConfiguredPush(payload: { title?: string; content?: string; accountId?: string; accountName?: string; logLabel?: string } = {}): Promise<void> {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const baseTitle = String(payload.title || '').trim();
        const content = String(payload.content || '').trim();
        const title = accountName ? `${baseTitle} ${accountName}` : baseTitle;
        const logLabel = String(payload.logLabel || '事件提醒').trim() || '事件提醒';
        try {
            const channelCfg = resolvePushChannel();
            if (channelCfg.ok === false) {
                log('错误', channelCfg.reason);
                return;
            }
            if (!title || !content) {
                log('错误', '推送标题或内容为空');
                return;
            }
            const result = await sendPushooMessage({
                channel: channelCfg.channel,
                endpoint: channelCfg.endpoint,
                token: channelCfg.token,
                secret: channelCfg.secret,
                title,
                content,
            });
            if (result?.ok) {
                log('系统', `${logLabel}发送成功: ${accountName || accountId || title}`);
            } else {
                log('错误', `${logLabel}发送失败: ${result?.msg || 'unknown'}`);
            }
        } catch (e: any) {
            log('错误', `${logLabel}发送异常: ${e.message}`);
        }
    }

    /** 把内部原因码翻成人话，拼进推送正文：原来 reason 只进日志，用户收到的永远是固定文案。 */
    function describeOfflineReason(reason: string, offlineMs: number): string {
        const text = String(reason || '');
        if (text === 'offline_timeout') {
            const minutes = Math.max(1, Math.floor(offlineMs / 60000));
            return `持续离线 ${minutes} 分钟，已自动删除账号`;
        }
        if (text.startsWith('kickout:')) return `被服务端踢下线（${text.slice('kickout:'.length) || '未知原因'}）`;
        if (text.startsWith('disconnect:')) {
            const parts = text.split(':');
            return `连接断开（来源 ${parts[1] || 'unknown'}，码 ${parts[3] || 0}）`;
        }
        return text && text !== 'unknown' ? text : '';
    }

    async function triggerOfflineReminder(payload: OfflineReminderPayload = {}): Promise<void> {
        try {
            const accountId = String(payload.accountId || '').trim();
            const accountName = String(payload.accountName || '').trim();
            const reason = String(payload.reason || 'unknown');
            const offlineMs = Math.max(0, Number(payload.offlineMs) || 0);
            log('系统', `触发下线提醒: 账号=${accountName || accountId}, 原因=${reason}`, { accountId, accountName, reason });

            // 按账号做最小间隔节流：开启「掉线自动重登」后，断线 → 补码 → 再断
            // 是分钟级的循环，每断一次就推一条会把用户彻底刷屏。
            const throttleKey = accountId || accountName || '__default__';
            const now = Date.now();
            const last = lastReminderAt.get(throttleKey) || 0;
            if (last && now - last < OFFLINE_REMINDER_MIN_INTERVAL_MS) {
                const waitMin = Math.ceil((OFFLINE_REMINDER_MIN_INTERVAL_MS - (now - last)) / 60000);
                log('系统', `下线提醒已节流：该账号 ${waitMin} 分钟内已推送过，本次跳过`, {
                    accountId, accountName, reason,
                });
                return;
            }
            // 先占位再发，避免并发触发的两次提醒都通过检查
            lastReminderAt.set(throttleKey, now);
            if (lastReminderAt.size > 256) {
                for (const [key, at] of lastReminderAt) {
                    if (now - at > OFFLINE_REMINDER_MIN_INTERVAL_MS) lastReminderAt.delete(key);
                }
            }

            const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
            if (!cfg) {
                log('错误', '未找到下线提醒配置');
                return;
            }

            const baseTitle = String(cfg.title || '').trim();
            const content = String(cfg.msg || '').trim();
            if (!baseTitle || !content) {
                log('错误', '下线提醒配置不完整');
                return;
            }

            // 把具体原因拼进正文，用户不用去翻日志才知道是「被踢」还是「网络断」
            const detail = describeOfflineReason(reason, offlineMs);
            const body = detail ? `${content}\n掉线原因：${detail}` : content;
            await sendConfiguredPush({ title: baseTitle, content: body, accountId, accountName, logLabel: '下线提醒' });
        } catch (e: any) {
            log('错误', `下线提醒发送异常: ${e.message}`);
        }
    }

    return { getOfflineAutoDeleteMs, triggerOfflineReminder, sendConfiguredPush };
}

module.exports = { createReloginReminderService };
