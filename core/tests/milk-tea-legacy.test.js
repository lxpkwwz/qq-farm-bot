// 数据目录指向临时区：否则测试会通过真实 logger 往 core/data/logs 里追加日志。
require('./helpers/isolate-data');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');

const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/activitypb.proto'), { keepCase: true });
const types = Object.fromEntries(['MilkTeaGetGroupReply', 'MilkTeaOperateReply', 'MilkTeaOperateRequest', 'GetGroupRequest']
    .map(name => [name, root.lookupType(`gamepb.activitypb.${name}`)]));
const encode = (type, data) => Buffer.from(type.encode(type.fromObject(data)).finish());

/**
 * 老版活动页（MilkTeaActivityPanel）吃的是 TeaState 形状。
 * 这里复现 2026-11-05 的手动兑换失败：goods 直接展开 protobuf 解码结果，
 * int64 字段是 Long，序列化成 JSON 后变成 {low,high,unsigned}。
 */
function harness() {
    const calls = [];
    let now = 1792032000;
    const main = {
        head: { activity_id: '2026110101', name: '奶茶热销中', begin_time: 1792029600, end_time: 1794844799, settle_start_time: 1794671999 },
        milk_tea: { summary: { shop_open_at: 1792030000, shop_name: '测试店铺', level: 1, total_revenue: 500 } },
    };
    // 有限限购：24 个，已买 1 个。
    const seed = { id: 339, item: [{ id: 20525, count: 1 }], cost: [{ id: 1001, count: 10000 }], purchase_limit: 24, purchased_count: 1, order: 1, name: '森野甜莓种子', category_tag: 'seed', cond_hints: [] };
    // 官方不限购：purchase_limit = 0。
    const drink = { id: 340, item: [{ id: 1041, count: 5 }], cost: [{ id: 1041, count: 20 }], purchase_limit: 0, purchased_count: 7, order: 2, name: '奶茶券礼包', category_tag: 'other', cond_hints: [] };
    const happy = { head: { activity_id: '2026110104' }, share_reward: { summary: { current_score: 10 } } };
    const shop = {
        goods: [seed, drink],
        share: null,
    };
    const bag = [{ id: 1001, count: 100000 }, { id: 1041, count: 200 }];
    const fields = { 55: 'milk_tea_get_shop', 58: 'milk_tea_get_workshop', 63: 'milk_tea_get_work_page', 1: 'shop_buy' };

    const mock = (name, exports) => {
        const id = require.resolve(`../dist/${name}`);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    const realUtils = require('../dist/utils/utils');
    mock('utils/proto', { types });
    mock('utils/utils', { ...realUtils, getServerTimeSec: () => now });
    mock('config/gameConfig', { getItemById: id => ({ name: `物品${id}` }), getItemImageById: () => '' });
    mock('services/warehouse', { getBag: async () => ({ items: bag }), getBagItems: b => b.items, isItemLocked: () => false });
    mock('utils/network', {
        getUserState: () => ({ gid: 1, gold: 100000 }),
        sendMsgAsync: async (_service, method, body) => {
            if (method === 'GetGroup') {
                return {
                    body: encode(types.MilkTeaGetGroupReply, {
                        group: { head: { activity_id: '2026110100' }, children: [main, { head: { activity_id: '2026110102' }, shop }, happy] },
                    }),
                };
            }
            const req = types.MilkTeaOperateRequest.toObject(types.MilkTeaOperateRequest.decode(body), { longs: String });
            const cmd = Number(req.operate_type);
            calls.push(req);
            let result = {};
            if (cmd === 55) result = { shop: { level: 1, sales_item_id: 1042, drink_cups: {}, slots: [], pending_rewards: [] } };
            else if (cmd === 58) result = { recipes: [] };
            else if (cmd === 63) result = { hire_subscribe_qq_jump_url: 'x' };
            else if (cmd === 1) {
                seed.purchased_count += 1;
                result = { awards: [{ id: 20525, count: 1 }] };
            }
            return { body: encode(types.MilkTeaOperateReply, { activity_id: req.activity_id, operate_type: cmd, [fields[cmd]]: result }) };
        },
    });
    const id = require.resolve('../dist/services/milk-tea-legacy');
    delete require.cache[id];
    return { service: require(id), calls, shop, seed, setTime: v => now = v };
}

test('legacy goods DTO is JSON-safe: id string, limit numbers, unlimited remaining null', async () => {
    const h = harness();
    const state = await h.service.getMilkTea();
    const seed = state.goods.find(v => v.name === '森野甜莓种子');
    const drink = state.goods.find(v => v.name === '奶茶券礼包');

    assert.equal(seed.id, '339');
    assert.equal(typeof seed.purchase_limit, 'number');
    assert.equal(seed.purchase_limit, 24);
    assert.equal(seed.purchased_count, 1);
    assert.equal(seed.remaining, 23);
    assert.equal(seed.order, 1);
    assert.equal(drink.remaining, null, 'purchase_limit=0 表示不限购，不能算成售罄');
    assert.equal(seed.maxPurchasable, 10, '可买上限受金币余额约束');

    // worker IPC / res.json 会走一次 JSON 序列化，这里必须仍然能取回编号。
    const wire = JSON.parse(JSON.stringify(state));
    assert.equal(wire.goods.find(v => v.name === '森野甜莓种子').id, '339');
    assert.equal(wire.goods.find(v => v.name === '奶茶券礼包').remaining, null);
});

test('manual buy sends the normalized goods id and accepts legacy Long-shaped ids', async () => {
    const h = harness();
    await h.service.getMilkTea();

    const result = await h.service.operateMilkTea('buy', { goodsId: '339', count: 1 });
    assert.equal(result.ok, true);
    const buy = h.calls.find(v => Number(v.operate_type) === 1);
    assert.equal(buy.activity_id, '2026110102');
    assert.equal(buy.shop_buy.goods_id, '339');
    assert.equal(Number(buy.shop_buy.count), 1);

    // 旧缓存里 goodsId 可能是 Long 的 JSON 形态（{low,high,unsigned}），也必须认得。
    h.calls.length = 0;
    await h.service.operateMilkTea('buy', { goodsId: { low: 339, high: 0, unsigned: false }, count: 1 });
    assert.equal(h.calls.find(v => Number(v.operate_type) === 1).shop_buy.goods_id, '339');
});

test('manual buy reports precise reasons without sending writes', async () => {
    const h = harness();
    await h.service.getMilkTea();
    await assert.rejects(h.service.operateMilkTea('buy', { goodsId: '999', count: 1 }), /商品不存在/);
    await assert.rejects(h.service.operateMilkTea('buy', { goodsId: '339', count: 99 }), /超过剩余限购/);
    assert.equal(h.calls.filter(v => Number(v.operate_type) === 1).length, 0);
});
