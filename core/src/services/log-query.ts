export {};
/**
 * 日志查询参数与多账号日志合并（纯函数，可单测）。
 *
 * 「全部账号」日志是把每个账号各自的最新 N 条拼起来再按时间截取的，这里把
 * 参数边界与排序口径收在一处，避免路由里再写一遍容易写错的时间比较。
 */

const LOG_LIMIT_DEFAULT = 100;
const LOG_LIMIT_MAX = 1000;

/**
 * 日志拉取条数的边界。
 *
 * 直接 `Number.parseInt(limit) || 100` 有两个坑：
 * - `limit=-5` 是负数，下游 `slice(-5)` 会被当成「从尾部取 5 条」，语义完全变了；
 * - `limit=1e9` 会让一次响应把整段历史都吐出来。
 * 这里统一收敛到 1~1000，非法值走默认。
 */
function parseLogLimit(raw: unknown): number {
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(parsed)) return LOG_LIMIT_DEFAULT;
    return Math.min(LOG_LIMIT_MAX, Math.max(1, parsed));
}

/**
 * 日志时间戳（毫秒）。运行日志带数值 `ts`，账号日志只有格式化后的 `time` 文本，
 * 两种都要能参与比较。
 */
function logTimestamp(log: any): number {
    const direct = Number(log?.ts ?? log?.timestamp);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const text = String(log?.time || '').trim();
    if (!text) return 0;
    const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(' ', 'T') : text);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 合并多个账号的日志，按时间升序取最新的 limit 条。
 *
 * 朝向与单账号分支的 `slice(-limit)` 保持一致（旧 → 新），前端不用为两种模式写两套渲染。
 * 旧实现比的是 `time` 字段，而运行日志只有数值 `ts`：两边都取到 undefined，比较结果恒为 0，
 * `sort` 实际什么都没做，`slice(0, limit)` 于是只留下第一个账号的旧日志。
 */
function mergeLogLists(lists: any[], limit: number): any[] {
    const all: any[] = [];
    for (const list of Array.isArray(lists) ? lists : []) {
        if (Array.isArray(list)) all.push(...list);
    }
    const max = parseLogLimit(limit);
    all.sort((a: any, b: any) => logTimestamp(a) - logTimestamp(b));
    return all.slice(-max);
}

module.exports = {
    LOG_LIMIT_DEFAULT,
    LOG_LIMIT_MAX,
    parseLogLimit,
    logTimestamp,
    mergeLogLists,
};
