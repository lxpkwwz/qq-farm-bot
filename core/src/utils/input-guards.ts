/**
 * 外部输入的统一边界校验（HTTP 请求体 / 查询串 / 路径参数 / worker IPC 参数）。
 *
 * 存在的理由：下面两种写法都不构成校验。
 *   1. `Number(x) || 0` —— `JSON.parse('{"n":1e400}')` 得到 Infinity，它是 truthy，
 *      `||` 不生效，`Math.max(0, Infinity)` 仍是 Infinity。
 *   2. `if (v <= 0) throw` —— Infinity 大于 0，同样拦不住。
 *
 * Infinity 编进 protobuf 的 int64 字段既不报错也不落日志，只是让这次请求静默失效：
 * 派宠永远匹配不上、地块编号永远对不上、购买数量永远算不完。
 *
 * 规则：凡是来自进程外的数值，先过这里的函数再往下传。
 */

export const MAX_INPUT_ID = Number.MAX_SAFE_INTEGER;
export const MAX_INPUT_COUNT = 9999;
export const MAX_INPUT_LIST = 200;

export class InputError extends Error {
    readonly code = 'INVALID_INPUT';
    readonly field: string;

    constructor(field: string, message: string) {
        super(message);
        this.name = 'InputError';
        this.field = field;
    }
}

export function isInputError(error: unknown): error is InputError {
    return error instanceof InputError;
}

export interface IntRange {
    field: string;
    max: number;
    min: number;
}

/** 严格取整：只认整数与纯整数文本，布尔 / 对象 / 数组 / 小数 / NaN / ±Infinity 一律返回 null。 */
export function toFiniteInteger(input: unknown): number | null {
    if (typeof input === 'number') {
        return Number.isSafeInteger(input) ? input : null;
    }
    if (typeof input === 'string') {
        const text = input.trim();
        if (!/^-?\d+$/.test(text)) {
            return null;
        }
        const value = Number(text);
        return Number.isSafeInteger(value) ? value : null;
    }
    return null;
}

export function readInt(input: unknown, range: IntRange): number {
    const value = toFiniteInteger(input);
    if (value === null) {
        throw new InputError(range.field, `${range.field} 必须是整数`);
    }
    if (value < range.min || value > range.max) {
        throw new InputError(range.field, `${range.field} 必须在 ${range.min}~${range.max} 之间`);
    }
    return value;
}

/** 正数 ID（地块 / 物品 / 宠物 / NPC / 商品 / 好友 gid）。 */
export function readId(input: unknown, field: string, max: number = MAX_INPUT_ID): number {
    return readInt(input, { field, min: 1, max });
}

/** 购买或使用的数量，默认 1~9999。 */
export function readCount(input: unknown, field: string, max: number = MAX_INPUT_COUNT, min: number = 1): number {
    return readInt(input, { field, min, max });
}

/** 允许 0 的整数（宠物槽位、背包 uid、目标数量等「0 = 未指定」的语义）。 */
export function readNonNegativeInt(input: unknown, field: string, max: number = MAX_INPUT_ID): number {
    return readInt(input, { field, min: 0, max });
}

/** 可选参数的静默变体：非法值回落 fallback，不抛错。 */
export function readIntOr(input: unknown, fallback: number, range: IntRange): number {
    try {
        return readInt(input, range);
    }
    catch {
        return fallback;
    }
}

export function readIdOr(input: unknown, field: string, fallback: number = 0, max: number = MAX_INPUT_ID): number {
    return readIntOr(input, fallback, { field, min: 1, max });
}

export function readCountOr(input: unknown, fallback: number, field: string, max: number = MAX_INPUT_COUNT, min: number = 1): number {
    return readIntOr(input, fallback, { field, min, max });
}

export function readNonNegativeIntOr(input: unknown, fallback: number, field: string, max: number = MAX_INPUT_ID): number {
    return readIntOr(input, fallback, { field, min: 0, max });
}

/** ID 数组：逐项校验，同时卡长度上限（避免一次请求把所有地块都塞进来）。 */
export function readIdList(input: unknown, field: string, maxLength: number = MAX_INPUT_LIST, minLength: number = 1): number[] {
    if (!Array.isArray(input)) {
        throw new InputError(field, `${field} 必须是数组`);
    }
    if (input.length < minLength) {
        throw new InputError(field, `${field} 至少 ${minLength} 项`);
    }
    if (input.length > maxLength) {
        throw new InputError(field, `${field} 最多 ${maxLength} 项`);
    }
    return input.map((entry, index) => readId(entry, `${field}[${index}]`));
}

/** 枚举值：只接受白名单内的字符串，其余情况回落 fallback 或抛错。 */
export function readEnumOr<T extends string>(input: unknown, fallback: T, field: string, allowed: readonly T[]): T {
    const text = typeof input === 'string' ? input.trim().toLowerCase() : '';
    return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}
