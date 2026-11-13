/**
 * 外部输入面清单闸门。
 *
 * 为什么单独一组：前几轮的复查都是「读代码找坏味道」，捞回来的永远是同一批；
 * 这一轮换成把「进程外能写进来的每一个字段」列成清单，再让清单本身受测试约束。
 *
 * 清单要解决的三个问题：
 *   1. 新加的路由字段如果不登记，测试直接红 —— 逼着作者当场分类（数值 / 枚举 / 文本 / 布尔）；
 *   2. 危险的强制转换写法（`Number(x) || 0`、`toNum(req...)`）在控制器与 worker 层被禁止；
 *   3. 已修的具体漏洞（地块编号、狗粮 itemId、背包道具、化肥数量）逐个钉死，防止回潮。
 *
 * 这套闸门能证明什么、不能证明什么：
 *   能 —— 清单与源码一致；没有任何一条路径把未经整数性检查的请求值当作数值使用；
 *        极端值（1e400 → Infinity、'1e400' 文本、NaN、负数、小数、布尔、数组）会被拒绝。
 *   不能 —— 每个转发点都在本地校验。本仓库的约定是「路由转发、服务层校验」，
 *          大量数值在下游由 positiveDecimal / positiveInteger / safePositiveNumber 拦，
 *          清单里把这类标成 service 并钉住校验器仍在，但不能证明是逐字段覆盖的。
 *          真正的逐字段证明只能靠服务层自己的测试。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const guards = require('../dist/utils/input-guards');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_DIR = path.join(ROOT, 'src/controllers/admin');
const ADMIN_REL = 'src/controllers/admin';
/** 用字符串构造：字面量 1e400 会让 ESLint 报 no-loss-of-precision。 */
const OVERFLOW = Number('1e400');

function readSource(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 注释里出现的示例代码不该被当成违规写法。 */
function isCommentLine(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function listAdminFiles() {
    const out = [];
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(full, rel);
            else if (entry.name.endsWith('.ts')) out.push(rel);
        }
    };
    walk(ADMIN_DIR, '');
    return out;
}

/** 路由层算作「已校验」的标记：统一的 read* 守卫，以及历史遗留但仍严格的若干校验器。 */
const ROUTE_VALIDATOR_MARKERS = [
    'readId(', 'readIdOr(', 'readIdList(', 'readInt(', 'readIntOr(',
    'readCount(', 'readCountOr(', 'readNonNegativeInt(', 'readNonNegativeIntOr(',
    'parseLogLimit(', 'positiveInteger(', 'boundedInteger(', 'positiveDecimal(', 'safePositiveNumber(',
    'normalizeLandIds(', 'scanFriendGids(',
    'Number.isInteger(', 'Number.isSafeInteger(', 'Number.isFinite(',
    '/^[1-9]\\d*$/.test(',
];

const ACCESS_PATTERN = /req\.(body|query|params)(?:\?\.|\.)([A-Za-z_$][\w$]*)/g;

/**
 * 输入面清单。每行 = 一个「文件 + 字段 + 来源」的接入点。
 *   kind: int / int-list 需要数值边界；enum 已被白名单收敛；bool 是开关；
 *         text 是文本过滤条件或标识符；object 是结构化快照（只做比对）；
 *         ignored 是路由收了但服务层根本没用到的参数。
 *   guard: route = 路由层当场校验；service = 下游命名校验器（第三个元素给出文件与校验器片段）。
 */
const INPUT_SURFACE = [
    // 账号与日志查询：全是文本过滤条件、账号引用或布尔开关。
    ['account-routes.ts', 'accountId', 'query', 'text', 'route'],
    ['account-routes.ts', 'event', 'query', 'text', 'route'],
    ['account-routes.ts', 'id', 'params', 'text', 'route'],
    ['account-routes.ts', 'isWarn', 'query', 'bool', 'route'],
    ['account-routes.ts', 'keyword', 'query', 'text', 'route'],
    ['account-routes.ts', 'limit', 'query', 'int', 'route'],
    ['account-routes.ts', 'module', 'query', 'text', 'route'],
    ['account-routes.ts', 'tag', 'query', 'text', 'route'],
    ['account-routes.ts', 'timeFrom', 'query', 'text', 'route'],
    ['account-routes.ts', 'timeTo', 'query', 'text', 'route'],

    // 商城 / 活动：数量与商品 ID 由 services/commerce.ts 的 positiveInteger 拦，
    // 分页由 boundedInteger 收敛，其余是活动操作名与价格快照。
    ['commerce-routes.ts', 'action', 'body', 'enum', 'service', ['src/services/milk-tea-legacy.ts', 'if (!ACTIONS[action]']],
    ['commerce-routes.ts', 'action', 'params', 'text', 'route'],
    ['commerce-routes.ts', 'activityId', 'params', 'text', 'route'],
    ['commerce-routes.ts', 'count', 'body', 'int', 'service', ['src/services/commerce.ts', 'positiveInteger(countInput']],
    ['commerce-routes.ts', 'expectedOffer', 'body', 'object', 'route'],
    ['commerce-routes.ts', 'expectedPrice', 'body', 'object', 'route'],
    ['commerce-routes.ts', 'goodsId', 'body', 'int', 'service', ['src/services/commerce.ts', 'positiveInteger(goodsIdInput']],
    ['commerce-routes.ts', 'key', 'params', 'text', 'route'],
    ['commerce-routes.ts', 'kind', 'body', 'text', 'route'],
    ['commerce-routes.ts', 'npcId', 'body', 'int', 'service', ['src/services/commerce.ts', 'positiveInteger(npcIdInput']],
    // 奶茶活动的 page 是页签名（'shop' / 'sales'），不是页码。
    ['commerce-routes.ts', 'page', 'query', 'text', 'route'],
    ['commerce-routes.ts', 'params', 'body', 'object', 'route'],
    ['commerce-routes.ts', 'slotType', 'body', 'enum', 'service', ['src/services/commerce.ts', "INVALID_MALL_SLOT"]],
    ['commerce-routes.ts', 'slotType', 'query', 'int', 'service', ['src/services/commerce.ts', 'boundedInteger(slotTypeInput']],
    ['commerce-routes.ts', 'subSlotType', 'query', 'int', 'service', ['src/services/commerce.ts', 'boundedInteger(subSlotTypeInput']],
    ['commerce-routes.ts', 'type', 'body', 'text', 'route'],

    // 农场：本轮修复的重点。地块 / 物品 / 数量全部走 read*。
    ['farm-routes.ts', 'action', 'params', 'text', 'route'],
    ['farm-routes.ts', 'buyNormal', 'body', 'bool', 'route'],
    ['farm-routes.ts', 'buyOrganic', 'body', 'bool', 'route'],
    ['farm-routes.ts', 'count', 'body', 'int', 'route'],
    ['farm-routes.ts', 'cursor', 'body', 'int', 'service', ['src/services/farm/ripen-all.ts', 'cursor !== current.cursor']],
    ['farm-routes.ts', 'dogId', 'body', 'int', 'route'],
    ['farm-routes.ts', 'fertilizerType', 'body', 'enum', 'service', ['src/services/farm/planting.ts', '化肥类型必须是 normal 或 organic']],
    ['farm-routes.ts', 'goodsId', 'body', 'int', 'route'],
    ['farm-routes.ts', 'id', 'params', 'text', 'route'],
    ['farm-routes.ts', 'itemId', 'body', 'int', 'route'],
    ['farm-routes.ts', 'landId', 'body', 'int', 'route'],
    ['farm-routes.ts', 'landIds', 'body', 'int-list', 'route'],
    ['farm-routes.ts', 'normalCount', 'body', 'int', 'route'],
    ['farm-routes.ts', 'normalThresholdHours', 'body', 'int', 'route'],
    ['farm-routes.ts', 'organicCount', 'body', 'int', 'route'],
    ['farm-routes.ts', 'organicThresholdHours', 'body', 'int', 'route'],
    ['farm-routes.ts', 'seedId', 'params', 'int', 'route'],
    ['farm-routes.ts', 'sort', 'query', 'text', 'route'],
    ['farm-routes.ts', 'token', 'body', 'text', 'route'],
    ['farm-routes.ts', 'type', 'body', 'enum', 'route'],
    ['farm-routes.ts', 'type', 'query', 'text', 'route'],
    ['farm-routes.ts', 'uid', 'body', 'int', 'route'],

    // 好友：gid 在 friend-interaction-items 里由 positiveDecimal 收敛，道具与地块有专用校验器。
    ['friend-routes.ts', 'forceSync', 'query', 'bool', 'route'],
    ['friend-routes.ts', 'gid', 'params', 'int', 'service', ['src/services/friend-interaction-items.ts', 'positiveDecimal(friendGidInput']],
    ['friend-routes.ts', 'itemId', 'body', 'int', 'service', ['src/services/friend-interaction-items.ts', 'safePositiveNumber(itemIdInput']],
    ['friend-routes.ts', 'landIds', 'body', 'int-list', 'service', ['src/services/friend-interaction-items.ts', 'normalizeLandIds(landIdsInput']],

    // 登录任务：taskId 是内存表的键，不是数值。
    ['qq-login-routes.ts', 'taskId', 'params', 'text', 'route'],
    ['wx-login-routes.ts', 'app_id', 'body', 'text', 'route'],
    ['wx-login-routes.ts', 'taskId', 'params', 'text', 'route'],

    // 活动中心：统一走 positiveDecimal / scanFriendGids / 动作白名单。
    ['activity-center/charity-routes.ts', 'target', 'body', 'int', 'service', ['src/services/activity-center/charity.ts', 'positiveDecimal(input, \'INVALID_CHARITY_PROGRESS_TARGET\'']],
    ['activity-center/pet-diary-routes.ts', 'action', 'body', 'enum', 'service', ['src/services/activity-center/pet-diary.ts', 'Object.hasOwn(OPERATIONS, actionInput)']],
    ['activity-center/pet-diary-routes.ts', 'gid', 'query', 'int', 'service', ['src/services/activity-center/pet-diary.ts', 'positiveDecimal(']],
    ['activity-center/pet-diary-routes.ts', 'kind', 'query', 'text', 'route'],
    ['activity-center/pet-diary-routes.ts', 'params', 'body', 'object', 'route'],
    ['activity-center/qingmei-routes.ts', 'count', 'body', 'int', 'service', ['src/services/activity-center/qingmei.ts', 'positiveDecimal(input, \'INVALID_QINGMEI_COUNT\'']],
    ['activity-center/qingmei-routes.ts', 'ingredients', 'body', 'int-list', 'service', ['src/services/activity-center/qingmei.ts', 'positiveDecimal(entry?.uid']],
    ['activity-center/qixi-routes.ts', 'friendGid', 'body', 'int', 'service', ['src/services/activity-center/qixi.ts', 'positiveDecimal(friendGidInput']],
    ['activity-center/qixi-routes.ts', 'messageTextId', 'body', 'int', 'service', ['src/services/activity-center/qixi.ts', 'positiveDecimal(']],
    ['activity-center/stellar-routes.ts', 'count', 'body', 'int', 'service', ['src/services/activity-center/stellar.ts', 'positiveDecimal(countInput']],
    ['activity-center/stellar-routes.ts', 'goodsId', 'body', 'int', 'service', ['src/services/activity-center/stellar.ts', 'positiveDecimal(goodsIdInput']],
    ['activity-center/stellar-routes.ts', 'termId', 'params', 'text', 'route'],
    ['activity-center/weather-routes.ts', 'count', 'body', 'ignored', 'route'],
    ['activity-center/weather-routes.ts', 'friendGid', 'body', 'int', 'service', ['src/services/weather-activity.ts', 'positiveDecimal(friendGidInput']],
    ['activity-center/weather-routes.ts', 'friendGids', 'body', 'int-list', 'service', ['src/services/weather-activity.ts', 'scanFriendGids(friendGidsInput']],
    ['activity-center/weather-routes.ts', 'friend_gids', 'body', 'int-list', 'service', ['src/services/weather-activity.ts', 'scanFriendGids(friendGidsInput']],
    ['activity-center/weather-routes.ts', 'gids', 'body', 'int-list', 'service', ['src/services/weather-activity.ts', 'scanFriendGids(friendGidsInput']],
    ['activity-center/weather-routes.ts', 'landId', 'body', 'int', 'service', ['src/services/weather-activity.ts', "positiveDecimal(landIdInput, 'INVALID_WEATHER_LAND_ID'"]],
    ['activity-center/weather-routes.ts', 'nodeId', 'body', 'int', 'service', ['src/services/weather-activity.ts', 'positiveDecimal(nodeIdInput']],
    ['activity-center/weather-routes.ts', 'nodeId', 'params', 'int', 'route'],
    ['activity-center/weather-routes.ts', 'node_id', 'body', 'int', 'service', ['src/services/weather-activity.ts', 'positiveDecimal(nodeIdInput']],
    ['activity-center/weather-routes.ts', 'targetGid', 'body', 'int', 'service', ['src/services/weather-activity.ts', 'positiveDecimal(friendGidInput']],
    ['activity-center/weather-routes.ts', 'target_gid', 'body', 'int', 'service', ['src/services/weather-activity.ts', 'positiveDecimal(friendGidInput']],
];

function collectAccessSites() {
    const sites = new Map();
    for (const file of listAdminFiles()) {
        const source = readSource(`${ADMIN_REL}/${file}`);
        const lines = source.split('\n');
        ACCESS_PATTERN.lastIndex = 0;
        for (let i = 0; i < lines.length; i += 1) {
            ACCESS_PATTERN.lastIndex = 0;
            let match = ACCESS_PATTERN.exec(lines[i]);
            while (match) {
                const key = `${file}|${match[2]}|${match[1]}`;
                const window = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
                const entry = sites.get(key) || { file, field: match[2], source: match[1], lines: [], unguardedLines: [] };
                entry.lines.push(i + 1);
                const hasValidator = ROUTE_VALIDATOR_MARKERS.some(marker => window.includes(marker));
                if (!hasValidator) entry.unguardedLines.push(i + 1);
                sites.set(key, entry);
                match = ACCESS_PATTERN.exec(lines[i]);
            }
        }
    }
    return sites;
}

test('输入面清单与源码完全一致（新增字段必须先登记分类）', () => {
    const declared = new Set(INPUT_SURFACE.map(([file, field, source]) => `${file}|${field}|${source}`));
    const sites = collectAccessSites();

    const missing = [...sites.keys()].filter(key => !declared.has(key)).sort();
    assert.deepEqual(missing, [], `以下请求字段没有登记到 INPUT_SURFACE，先判断它是数值还是文本：\n${missing.join('\n')}`);

    const stale = [...declared].filter(key => !sites.has(key)).sort();
    assert.deepEqual(stale, [], `INPUT_SURFACE 里有已经不存在的字段，删掉它们：\n${stale.join('\n')}`);
});

test('标记为 route 的数值字段必须在接入点当场校验', () => {
    const sites = collectAccessSites();
    const failures = [];
    for (const [file, field, source, kind, guard] of INPUT_SURFACE) {
        if (guard !== 'route') continue;
        if (kind !== 'int' && kind !== 'int-list' && kind !== 'enum') continue;
        const entry = sites.get(`${file}|${field}|${source}`);
        assert.ok(entry, `${file} ${field} 的接入点消失了，同步删掉清单条目`);
        if (entry.unguardedLines.length) failures.push(`${file}:${entry.unguardedLines.join(',')} ${source}.${field}`);
    }
    assert.deepEqual(failures, [], `以下数值接入点没有走任何校验器：\n${failures.join('\n')}`);
});

test('标记为 service 的字段，下游校验器仍然存在', () => {
    const failures = [];
    for (const entry of INPUT_SURFACE) {
        const [file, field, source, , guard, target] = entry;
        if (guard !== 'service') continue;
        assert.ok(Array.isArray(target), `${file} ${field} 标了 service 但没给校验器位置`);
        const sourceText = readSource(target[0]);
        if (!sourceText.includes(target[1])) failures.push(`${file}:${source}.${field} -> ${target[0]} 缺少 "${target[1]}"`);
    }
    assert.deepEqual(failures, [], `下游校验器被改动或删除：\n${failures.join('\n')}`);
});

test('守卫函数拒绝一切非有限整数（含 1e400 解析出的 Infinity）', () => {
    const hostile = [
        ['1e400', '字符串指数'],
        [OVERFLOW, '数值溢出'],
        [Number.POSITIVE_INFINITY, '正无穷'],
        [Number.NEGATIVE_INFINITY, '负无穷'],
        [Number.NaN, 'NaN'],
        [-5, '负数'],
        [1.5, '小数'],
        [true, '布尔'],
        [false, '布尔假'],
        [[1], '数组'],
        [{}, '对象'],
        [null, 'null'],
        [undefined, 'undefined'],
        ['abc', '非数字文本'],
        ['  ', '空白'],
        ['12abc', '尾随字符'],
        ['9007199254740993', '超过安全整数'],
    ];
    for (const [value, label] of hostile) {
        assert.throws(() => guards.readId(value, 'sample'), guards.InputError, `readId 不该接受${label}`);
        assert.throws(() => guards.readCount(value, 'sample'), guards.InputError, `readCount 不该接受${label}`);
        assert.throws(() => guards.readInt(value, { field: 'sample', min: 0, max: 100 }), guards.InputError, `readInt 不该接受${label}`);
    }
    // 零只在 readNonNegativeInt 里合法，readId / readCount 都不该放行。
    assert.equal(guards.readNonNegativeInt(0, 'sample'), 0);
    assert.throws(() => guards.readId(0, 'sample'), guards.InputError);
    assert.throws(() => guards.readCount(0, 'sample'), guards.InputError);
    assert.throws(() => guards.readIdList([1, OVERFLOW], 'list'), guards.InputError, '数组里混入 Infinity 必须拒绝');
    assert.throws(() => guards.readIdList('1,2,3', 'list'), guards.InputError, '字符串不是数组');
    assert.throws(() => guards.readIdList(Array.from({ length: 201 }, (_, i) => i + 1), 'list'), guards.InputError, '超长数组必须拒绝');
});

test('守卫函数的静默变体回落到 fallback，而不是把 Infinity 传下去', () => {
    assert.equal(guards.readIdOr(OVERFLOW, 'x', 7), 7);
    assert.equal(guards.readCountOr(OVERFLOW, 3, 'x'), 3);
    assert.equal(guards.readNonNegativeIntOr(Number.POSITIVE_INFINITY, 5, 'x'), 5);
    assert.equal(guards.readIntOr('1e400', 9, { field: 'x', min: 0, max: 10 }), 9);
    assert.equal(guards.readIdOr('12', 'x', 0), 12, '合法数字文本要照常接受');
    assert.equal(guards.readEnumOr('ORGANIC', 'normal', 'type', ['normal', 'organic']), 'organic', '枚举大小写归一');
    assert.equal(guards.readEnumOr('bogus', 'normal', 'type', ['normal', 'organic']), 'normal');
});

test('控制器里不允许再把请求值直接做数值强转', () => {
    const offenders = new Set();
    for (const file of listAdminFiles()) {
        const source = readSource(`${ADMIN_REL}/${file}`);
        const lines = source.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (isCommentLine(line)) continue;
            if (/Number\(req\.(?:body|query|params)/.test(line) && /\|\|/.test(line)) {
                offenders.add(`${file}:${i + 1} ${line.trim()}`);
            }
            if (/Math\.(?:max|min|trunc|round|floor)\([^)]*Number\(req\./.test(line)) {
                offenders.add(`${file}:${i + 1} ${line.trim()}`);
            }
            if (/toNum\(req\./.test(line)) {
                offenders.add(`${file}:${i + 1} ${line.trim()}`);
            }
        }
    }
    const list = [...offenders].sort();
    assert.deepEqual(list, [], `请求值必须先过 read* 守卫再做运算：\n${list.join('\n')}`);
});

test('worker 分发不再对 IPC 参数做 Number(x) || 0', () => {
    const source = readSource('src/core/worker.ts');
    const offenders = new Set();
    source.split('\n').forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (/Number\(args\[\d*\]?\)\s*\|\|/.test(line)) offenders.add(`src/core/worker.ts:${index + 1} ${line.trim()}`);
        if (/Number\(args\[/.test(line) && !/isFinite|isInteger|isSafeInteger/.test(line)) {
            offenders.add(`src/core/worker.ts:${index + 1} ${line.trim()}`);
        }
    });
    const list = [...offenders].sort();
    assert.deepEqual(list, [], `worker 侧的 IPC 参数也要过 read* 守卫：\n${list.join('\n')}`);
});

test('本轮修掉的四个漏洞各自钉一条断言', () => {
    const farm = readSource(`${ADMIN_REL}/farm-routes.ts`);
    const worker = readSource('src/core/worker.ts');
    const planting = readSource('src/services/farm/planting.ts');
    const warehouse = readSource('src/services/warehouse.ts');

    // 1. 狗粮的 itemId 之前只修了 count / uid，itemId 仍是 Math.max(0, Math.trunc(Number(...))).
    assert.match(farm, /const itemId = readId\(req\.body\?\.itemId, 'itemId'\)/);
    assert.doesNotMatch(farm, /Math\.max\(0, Math\.trunc\(Number\(req\.body\?\.itemId/);

    // 2. 铲除作物在 worker 侧是 removePlant([Number(args[0]) || 0])，Infinity 会直接进 int64。
    assert.match(worker, /removePlant\(\[readId\(args\[0\], 'landId'\)\]\)/);
    assert.doesNotMatch(worker, /removePlant\(\[Number\(args\[0\]\) \|\| 0\]\)/);

    // 3. 施肥走 toNum，`!landId || landId <= 0` 拦不住 Infinity。
    assert.match(planting, /const landId = readIdOr\(landIdInput, 'landId', 0\)/);
    assert.doesNotMatch(planting, /const landId = toNum\(landIdInput\)/);

    // 4. 背包使用 / 出售的 itemId 与数量。
    assert.match(worker, /const itemId = readId\(args\[0\], 'itemId'\)/);
    assert.match(warehouse, /readIdOr\(item && item\.id, 'id', 0\)/);
    assert.match(warehouse, /readCountOr\(item && item\.count, 0, 'count'/);
});

test('toNum 仍然只用于把 Long 转成 number，不承担校验职责', () => {
    const utils = readSource('src/utils/utils.ts');
    // 保留原有语义：服务端返回的 Long 必须能转；这里锁的是「别把校验塞进 toNum 又指望它」。
    assert.match(utils, /if \(LongModule\.isLong\(val\)\) return \(val as Long\)\.toNumber\(\);/);
    assert.match(utils, /return \(val as number\) \|\| 0;/);
});
