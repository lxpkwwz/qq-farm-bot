export {};
/**
 * 删除账号时清理它独有的落盘数据。
 *
 * 背景：账号被删掉后 `nextId` 会退回 1（`normalizeAccountsData` 里「没有账号就从头编号」），
 * 于是下一个新建的账号会拿到同一个 id。而各个模块都按账号 id 存文件，如果删号时只清了
 * `account-configs/<id>.json`，新账号就会直接继承旧账号的：
 *   - `known_friend_gids/<id>.json`  已知好友 GID 缓存 → 新号带着旧号的好友去互动
 *   - `stats/<id>.json`              当日统计 → 面板显示「今日偷菜 1439」这种别人的数字
 *   - `friend-pet-<sha256(id)>.json` 好友宠物缓存（可达 20KB+）
 *   - `friend-bad-state-<sha256(id)>.json` 好友当日的「已停手」状态
 *   - `tsdk/<id>/`                   该账号的 TSDK 运行缓存
 *
 * 这里只按固定命名规则拼路径、只删这些具体文件，不做目录遍历删除。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir } = require('../../config/runtime-paths');

/** 与各模块写盘时的归一化保持一致（见 gid-cache 的 `replace(/[^\w-]/g, '_')`）。 */
function safeAccountId(accountId: unknown): string {
    const raw: string = String(accountId ?? '');
    if (!raw || raw !== raw.trim()) return '';
    return raw.replace(/[^\w-]/g, '_');
}

/** 好友宠物缓存与「已停手」状态用 sha256(id) 作文件名。 */
function accountToken(accountId: unknown): string {
    return crypto.createHash('sha256').update(String(accountId ?? ''), 'utf8').digest('hex');
}

function listAccountArtifacts(accountId: unknown): string[] {
    const safeId: string = safeAccountId(accountId);
    const raw: string = String(accountId ?? '');
    if (!safeId || !raw) return [];
    const dir: string = getDataDir();
    const token: string = accountToken(raw);
    return [
        path.join(dir, 'known_friend_gids', `${safeId}.json`),
        path.join(dir, 'stats', `${safeId}.json`),
        // 这两类文件名是 sha256(id)，直接放在 data 根目录下
        path.join(dir, `friend-pet-${token}.json`),
        path.join(dir, `friend-bad-state-${token}.json`),
        path.join(dir, 'tsdk', safeId),
    ];
}

/**
 * 删除账号的全部专属文件。任何一个失败都不阻断其它项（删号本身必须成功）。
 * 返回真正删掉的路径，便于排查与测试断言。
 */
function purgeAccountArtifacts(accountId: unknown): string[] {
    const removed: string[] = [];
    for (const target of listAccountArtifacts(accountId)) {
        try {
            if (!fs.existsSync(target)) continue;
            fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
            removed.push(target);
        } catch {
            // 文件被占用时留给下次启动的清理，不因为一个缓存文件删不掉就阻断删号
        }
    }
    return removed;
}

module.exports = {
    purgeAccountArtifacts,
    listAccountArtifacts,
    safeAccountId,
    accountToken,
};
