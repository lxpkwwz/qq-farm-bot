/**
 * 巡查 / 好友任务间隔的合法上限（秒）。
 *
 * 必须与 core 的 `models/store/shared-state.ts` 里的 `INTERVAL_MAX_SEC` 保持一致：
 * 服务端会把超过上限的值夹掉，面板如果允许输入更大的数，用户保存后看到的就不是自己填的值。
 * `web/tests/interval-limits.test.mjs` 会直接比对两边的常量，改一边不改另一边会红。
 */
export const INTERVAL_MAX_SECONDS = 86400

/** 间隔输入框的统一上下限，避免两处表单各写一套。 */
export const INTERVAL_INPUT_MIN = 1
