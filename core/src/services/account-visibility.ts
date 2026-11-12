export {};
/**
 * 账号列表接口（/api/accounts）的对外投影。
 *
 * 该接口被浏览器每 10 秒轮询一次，历史上直接把 store 里的账号对象整个
 * 返回，等于把 refreshtoken / accesstoken / loginBuffer 这些能直接换游戏
 * 登录 Code 的长效凭证明文送到浏览器（F12 网络面板可见）。这里改成只对外
 * 暴露一个布尔能力标记 wxPreflightSupported，判定由调用方注入，与
 * wx-keepalive 使用的 hasWxCredential 保持同一口径，浏览器既拿不到明文，
 * 又能直接显示「免扫码续期：支持 / 不支持」。
 *
 * 另外附带每个微信账号的「自动续期账本」快照（只有时间戳与次数，没有任何
 * 凭证内容），供账号卡片显示「上次自动续期 / 今日失败次数」。字段始终存在，
 * 前端据此区分「旧版服务（字段缺失）」与「新版服务但还没有记录（全 0）」。
 *
 * 注意：只作用于 HTTP 响应副本，provider.getAccounts() 及其他后端调用方
 * 仍然拿到完整账号对象，续期 / 补 Code / 启动换码逻辑不受影响。
 */

const PRIVATE_CREDENTIAL_KEYS = ['refreshtoken', 'accesstoken', 'loginBuffer'] as const;

type CanPreflight = (account: any) => boolean;
type StatsSnapshot = Record<string, any>;

/** 账本里没有该账号时给的全 0 形状，避免前端出现 undefined 分支。 */
function emptyPublicStats(): any {
    return { date: '', lastSuccessAt: 0, lastFailureAt: 0, successesToday: 0, failuresToday: 0 };
}

function toPublicAccount(account: any, canPreflight: CanPreflight, statsSnapshot?: StatsSnapshot, canRecover?: CanPreflight): any {
    const safe: any = { ...(account || {}) };
    for (const key of PRIVATE_CREDENTIAL_KEYS) delete safe[key];
    safe.wxPreflightSupported = typeof canPreflight === 'function' ? !!canPreflight(account) : false;
    // QQ 账号不走微信续期机制，不下发这个字段，避免面板误渲染。
    if (String(safe.platform || '') === 'wx') {
        // 「能不能滚 token」和「掉线后能不能免扫码自愈」不是同一件事：只有
        // loginBuffer 的账号滚不了 token（wxPreflightSupported=false），但换 Code
        // 完全没问题，掉线重登照样会成功并写进自动续期账本。两个标记分开下发，
        // 面板才不会把「有账本但滚不了 token」的账号整段隐藏。
        if (typeof canRecover === 'function') safe.wxCanRecover = !!canRecover(account);
        const recorded = statsSnapshot?.[String(safe.id ?? '')];
        safe.wxPreflightStats = recorded && typeof recorded === 'object'
            ? { ...emptyPublicStats(), ...recorded }
            : emptyPublicStats();
    }
    return safe;
}

function toPublicAccountsData(data: any, canPreflight: CanPreflight, statsSnapshot?: StatsSnapshot, canRecover?: CanPreflight): any {
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    return {
        ...(data || {}),
        accounts: accounts.map((account: any) => toPublicAccount(account, canPreflight, statsSnapshot, canRecover)),
    };
}

module.exports = {
    PRIVATE_CREDENTIAL_KEYS,
    toPublicAccount,
    toPublicAccountsData,
};
