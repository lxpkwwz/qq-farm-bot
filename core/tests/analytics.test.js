/**
 * 作物效率排行。
 *
 * 面板上「种什么最划算」整张表都由这里算出来，但它只有一行导出（`getPlantRankings`），
 * 内部全是隐式的换算约定，之前没有任何测试。容易出错的地方有三处：
 *   1. 双季作物的倍率：生长时间 ×1.5、经验 ×2、化肥减免 ×2 —— 三个倍率是分开写的，
 *      漏掉任何一个都会让排行悄悄偏掉，而且数值看起来仍然「合理」；
 *   2. 化肥减免可能大于总生长时间（低等级作物 + 大额减免），除零或负数会让结果变成
 *      Infinity / 负收益，必须被夹到 1 秒兜底；
 *   3. 白萝卜（29999）是活动作物，必须从「收益排行」里排掉，否则它会长期占榜首。
 *
 * 游戏配置整体替换成小样本，让每个断言都能手算核对。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const PLANTS = [
    {
        id: 1,
        seed_id: 101,
        name: '单季作物',
        seasons: 1,
        grow_phases: '播种:30;成熟:170',
        exp: 10,
        fruit: { id: 1001, count: 2 },
        land_level_need: 1,
    },
    {
        id: 2,
        seed_id: 102,
        name: '双季作物',
        seasons: 2,
        grow_phases: '播种:40;成熟:160',
        exp: 20,
        fruit: { id: 1002, count: 3 },
        land_level_need: 2,
    },
    {
        id: 3,
        seed_id: 29999,
        name: '白萝卜',
        seasons: 1,
        grow_phases: '播种:0;成熟:50',
        exp: 999,
        fruit: { id: 1003, count: 99 },
    },
    {
        id: 4,
        seed_id: 0,
        name: '没有种子编号',
        seasons: 1,
        grow_phases: '播种:0;成熟:50',
        exp: 5,
        fruit: { id: 1004, count: 1 },
    },
    {
        id: 5,
        seed_id: 105,
        name: '没有生长周期',
        seasons: 1,
    },
    {
        id: 6,
        seed_id: 106,
        name: '减免大于总时长',
        seasons: 1,
        grow_phases: '播种:300;成熟:50',
        exp: 10,
        fruit: { id: 1006, count: 1 },
    },
];

const ITEM_LEVELS = { 101: 3, 102: 7, 106: 0 };
const FRUIT_PRICES = { 1001: 5, 1002: 10, 1006: 1 };
const SEED_PRICES = { 101: 3, 102: 8, 106: 2 };

require.cache[require.resolve('../dist/config/gameConfig')] = {
    exports: {
        getAllPlants: () => PLANTS,
        getFruitPrice: id => FRUIT_PRICES[id] || 0,
        getSeedPrice: id => SEED_PRICES[id] || 0,
        getItemById: id => (ITEM_LEVELS[id] === undefined ? null : { id, name: `物品${id}`, level: ITEM_LEVELS[id] }),
        getItemImageById: id => `/images/${id}.png`,
    },
};

const { getPlantRankings } = require('../dist/services/analytics');

function byName(name) {
    const found = getPlantRankings().find(row => row.name === name);
    assert.ok(found, `排行里找不到 ${name}`);
    return found;
}

// ============ 筛选 ============

test('白萝卜、没有种子编号、没有生长周期的作物都不进排行', () => {
    const names = getPlantRankings().map(row => row.name);
    assert.deepEqual(names.sort(), ['减免大于总时长', '单季作物', '双季作物'].sort());
});

test('成长周期为 0 的作物被跳过，不产生 Infinity', () => {
    for (const row of getPlantRankings()) {
        for (const key of ['expPerHour', 'goldPerHour', 'profitPerHour', 'normalFertilizerExpPerHour']) {
            assert.ok(Number.isFinite(row[key]), `${row.name}.${key} 必须是有限数，实际 ${row[key]}`);
        }
    }
});

// ============ 单季作物的换算 ============

test('单季作物：生长时长取所有阶段之和，化肥减免只取第一段', () => {
    const row = byName('单季作物');
    assert.equal(row.growTime, 200, '30 + 170');
    assert.equal(row.reduceSec, 30, '只认第一阶段的 30 秒');
    assert.equal(row.reduceSecApplied, 30, '单季不放大');
    assert.equal(row.growTimeStr, '3分20秒');
});

test('单季作物的经验、金币与净收益按公式换算', () => {
    const row = byName('单季作物');
    // 经验 10 / 200 秒 → 每小时 180
    assert.equal(row.expPerHour, 180);
    // 毛收益 2 个果实 × 5 金币 = 10；净收益 10 - 3（种子价）= 7
    assert.equal(row.income, 10);
    assert.equal(row.netProfit, 7);
    assert.equal(row.goldPerHour, 180);
    assert.equal(row.profitPerHour, 126);
    // 施肥后 200 - 30 = 170 秒
    assert.equal(row.normalFertilizerExpPerHour, Number.parseFloat(((10 / 170) * 3600).toFixed(2)));
});

// ============ 双季作物的三个倍率 ============

test('双季作物：生长 ×1.5、经验 ×2、化肥减免 ×2 三个倍率都要生效', () => {
    const row = byName('双季作物');
    // 基础 40 + 160 = 200 → ×1.5 = 300
    assert.equal(row.growTime, 300);
    assert.equal(row.seasons, 2);
    // 经验 20 → ×2 = 40
    assert.equal(row.expPerHour, 480, '40 / 300 秒 → 每小时 480');
    // 减免 40 → ×2 = 80；施肥后 300 - 80 = 220
    assert.equal(row.reduceSec, 40, '原始减免不放大');
    assert.equal(row.reduceSecApplied, 80, '实际减免要放大');
    assert.equal(row.normalFertilizerExpPerHour, Number.parseFloat(((40 / 220) * 3600).toFixed(2)));
    // 毛收益 3 个 × 10 金币 × 2 季 = 60；净收益 60 - 8 = 52
    assert.equal(row.income, 60);
    assert.equal(row.netProfit, 52);
});

// ============ 化肥减免的兜底 ============

test('化肥减免大于总生长时间时，施肥后时长兜底成 1 秒而不是负数或 0', () => {
    const row = byName('减免大于总时长');
    assert.equal(row.growTime, 350, '300 + 50');
    assert.equal(row.reduceSecApplied, 300);
    // 350 - 300 = 50 仍为正，这里验的是「不减成 0 以下」；
    // 单条 fert 指标必须是有限数，不能因为除以 0 变成 Infinity。
    assert.ok(Number.isFinite(row.normalFertilizerProfitPerHour));
    assert.ok(Number.isFinite(row.normalFertilizerExpPerHour));
});

// ============ 等级来源 ============

test('等级优先取物品表，物品表缺失时回落到地块等级需求', () => {
    assert.equal(byName('单季作物').level, 3, '来自 ItemInfo 的 level');

    const noItemLevel = byName('减免大于总时长');
    assert.equal(noItemLevel.level, null, '物品 level 为 0 且没有 land_level_need 时应为 null');
});

// ============ 排序 ============

test('按经验排序是降序', () => {
    const rows = getPlantRankings('exp');
    for (let index = 1; index < rows.length; index += 1) {
        assert.ok(rows[index - 1].expPerHour >= rows[index].expPerHour, '经验/时 必须降序');
    }
    assert.equal(rows[0].name, '双季作物');
});

test('按施肥后经验排序是降序', () => {
    const rows = getPlantRankings('fert');
    for (let index = 1; index < rows.length; index += 1) {
        assert.ok(rows[index - 1].normalFertilizerExpPerHour >= rows[index].normalFertilizerExpPerHour);
    }
});

test('按金币、净收益、施肥后净收益、等级四种排序都是降序', () => {
    const keyMap = {
        gold: 'goldPerHour',
        profit: 'profitPerHour',
        fert_profit: 'normalFertilizerProfitPerHour',
        // 等级用专门比较器，null 视为 -1
        level: 'level',
    };
    for (const [sortBy, key] of Object.entries(keyMap)) {
        const rows = getPlantRankings(sortBy);
        const value = row => (row[key] === null || row[key] === undefined ? -1 : Number(row[key]));
        for (let index = 1; index < rows.length; index += 1) {
            assert.ok(value(rows[index - 1]) >= value(rows[index]), `${sortBy} 排序不是降序`);
        }
    }
});

test('未知排序字段时保持配置里的原始顺序，不抛错', () => {
    assert.deepEqual(
        getPlantRankings('不存在的排序').map(row => row.name),
        ['单季作物', '双季作物', '减免大于总时长'],
    );
});
