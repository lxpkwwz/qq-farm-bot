// 数据目录指向临时区：否则测试会通过真实 logger 往 core/data/logs 里追加日志。
require('./helpers/isolate-data');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const {
    decideMysteryShopTick,
    isMysteryShopWatchEnabled,
    isCurrencyAllowed,
    mysteryShopConfigChanged,
    resolveMysteryShopPushFlags,
    buildMysteryShopPush,
    checkMysteryShopTick,
    createMysteryShopAutoState,
    DIAMOND_ITEM_ID,
} = require('../dist/services/mystery-shop-auto');

const diamondOffer = {
    active: true,
    npc: { id: 9, reward: { count: 1 }, price: { id: DIAMOND_ITEM_ID, name: '钻石', count: 10, balance: 100 } },
};

test('自动购买总开关与货币开关共同决定是否巡查、是否购买', () => {
    assert.equal(isMysteryShopWatchEnabled({}), false, '全部关闭时不启动巡查');
    assert.equal(isMysteryShopWatchEnabled({ mystery_shop_auto_buy: true }), true);
    assert.equal(isMysteryShopWatchEnabled({ mystery_shop_arrival_notify: true }), true);
    // 购买通知是附属开关，单独开启不会启动巡查（依赖自动购买 / 到货提醒）。
    assert.equal(isMysteryShopWatchEnabled({ mystery_shop_purchase_notify: true }), false);

    const off = decideMysteryShopTick(diamondOffer, { mystery_shop_allow_diamond: true });
    assert.equal(off.shouldBuy, false);
    assert.equal(off.skipBuyReason, 'auto_buy_off');

    const currencyOff = decideMysteryShopTick(diamondOffer, { mystery_shop_auto_buy: true });
    assert.equal(currencyOff.shouldBuy, false);
    assert.equal(currencyOff.skipBuyReason, 'currency_not_allowed');

    assert.equal(isCurrencyAllowed(DIAMOND_ITEM_ID, { mystery_shop_allow_diamond: true }), true, '钻石开关已接入判定');
    const on = decideMysteryShopTick(diamondOffer, { mystery_shop_auto_buy: true, mystery_shop_allow_diamond: true });
    assert.equal(on.shouldBuy, true, '总开关 + 钻石开关同时开启才会买钻石货品');

    const poor = decideMysteryShopTick({
        ...diamondOffer,
        npc: { ...diamondOffer.npc, price: { ...diamondOffer.npc.price, balance: 1 } },
    }, { mystery_shop_auto_buy: true, mystery_shop_allow_diamond: true });
    assert.equal(poor.shouldBuy, false);
    assert.equal(poor.skipBuyReason, 'insufficient');
});

test('开关从 UI 到 worker 的完整链路都有消费点', () => {
    const sharedState = read('src/models/store/shared-state.ts');
    const autoSrc = read('src/services/mystery-shop-auto.ts');
    const workerSrc = read('src/core/worker.ts');
    const settings = read('../web/src/components/settings/AccountFeatureSettings.vue');

    for (const key of [
        'mystery_shop_auto_buy',
        'mystery_shop_allow_gold',
        'mystery_shop_allow_coupon',
        'mystery_shop_allow_gold_bean',
        'mystery_shop_allow_diamond',
        'mystery_shop_arrival_notify',
        'mystery_shop_purchase_notify',
    ]) {
        assert.match(sharedState, new RegExp(`${key}:`), `${key} 在默认配置中，自动进入 ALLOWED_AUTOMATION_KEYS 白名单`);
    }
    assert.match(sharedState, /ALLOWED_AUTOMATION_KEYS.*Object\.keys\(DEFAULT_ACCOUNT_CONFIG\.automation\)/);
    assert.match(autoSrc, /\[DIAMOND_ITEM_ID\]: 'mystery_shop_allow_diamond'/);
    assert.match(autoSrc, /isCurrencyAllowed\(npc\.price\?\.id, automation\)/);
    assert.match(workerSrc, /startMysteryShopTimer\(\)/, '登录启动巡查定时器');
    assert.match(workerSrc, /mystery_shop_after_save/, '改开关后立即重查一次');
    assert.match(settings, /mystery_shop_allow_diamond/, '功能模块有钻石开关入口');
});

test('购买通知确实生成推送，且只在自动购买成功时生成', () => {
    const state = { lastArrivalKey: '', lastPurchaseKey: '' };
    const auto = {
        mystery_shop_auto_buy: true,
        mystery_shop_allow_diamond: true,
        mystery_shop_purchase_notify: true,
    };
    const decision = decideMysteryShopTick(diamondOffer, auto, state);
    assert.equal(decision.shouldBuy, true);

    const notBoughtFlags = resolveMysteryShopPushFlags(decision, false, auto, state);
    assert.deepEqual(notBoughtFlags, { arrival: false, purchase: false }, '未购买成功不推送');
    assert.equal(buildMysteryShopPush(diamondOffer, notBoughtFlags), null);

    const flags = resolveMysteryShopPushFlags(decision, true, auto, state);
    assert.equal(flags.purchase, true, '购买成功且开启购买通知时推送');
    const push = buildMysteryShopPush(diamondOffer, flags);
    assert.equal(push.title, '神秘商人已自动购买');
    assert.match(push.content, /购买 神秘商品 x1/);
    assert.match(push.content, /花费 10 钻石/);

    const repeated = resolveMysteryShopPushFlags(decision, true, auto, {
        lastArrivalKey: '', lastPurchaseKey: decision.visitKey,
    });
    assert.equal(repeated.purchase, false, '同一批货不重复推送');

    assert.equal(resolveMysteryShopPushFlags(decision, true, {
        ...auto, mystery_shop_purchase_notify: false,
    }, state).purchase, false, '关掉购买通知不推送');
});

test('面板内消息不依赖提醒开关和外部推送渠道', async () => {
    // 只开自动购买 + 货币，两个提醒开关全关：不发外部推送，但站内消息照常生成。
    const bought = await checkMysteryShopTick({
        getAutomation: () => ({ mystery_shop_auto_buy: true, mystery_shop_allow_diamond: true }),
        getShop: async () => diamondOffer,
        buy: async () => ({}),
        state: createMysteryShopAutoState(),
    });
    assert.equal(bought.bought, true);
    assert.equal(bought.push, undefined, '没开提醒开关就不发外部推送');
    assert.equal(bought.event?.type, 'mystery_purchase', '购买事件仍写入面板内消息');
    assert.match(bought.event.dedupeKey, /^purchase:/);
    assert.match(bought.event.content, /花费 10 钻石/);

    // 巡查时未买成功（货币不允许）：记到货事件，不需要任何通知开关或渠道。
    const arrival = await checkMysteryShopTick({
        getAutomation: () => ({ mystery_shop_auto_buy: true }),
        getShop: async () => diamondOffer,
        buy: async () => ({}),
        state: createMysteryShopAutoState(),
    });
    assert.equal(arrival.bought, false);
    assert.equal(arrival.event?.type, 'mystery_arrival');
    assert.equal(arrival.event?.title, '神秘商人到货');
});

test('配置变更检测覆盖全部神秘商人开关，worker 保存后立即重查', () => {
    for (const key of [
        'mystery_shop_auto_buy',
        'mystery_shop_allow_gold',
        'mystery_shop_allow_coupon',
        'mystery_shop_allow_gold_bean',
        'mystery_shop_allow_diamond',
        'mystery_shop_arrival_notify',
        'mystery_shop_purchase_notify',
    ]) {
        assert.equal(mysteryShopConfigChanged({}, { [key]: true }), true, `${key} 变化应触发立即巡查`);
    }
    assert.equal(isMysteryShopWatchEnabled({ mystery_shop_arrival_notify: true }), true, '只开到货提醒也要巡查');
    assert.equal(isMysteryShopWatchEnabled({ mystery_shop_purchase_notify: true }), false, '购买通知是附属开关');

    const workerSrc = read('src/core/worker.ts');
    assert.match(workerSrc, /isMysteryShopWatchEnabled\(nextAuto\) && mysteryShopConfigChanged\(prevAuto, nextAuto\)/);
    assert.doesNotMatch(workerSrc, /const mysteryKeys = \[/, '不再手写容易漏键的列表');
    assert.match(workerSrc, /sendToMaster\(\{ type: 'push_notify'/, 'worker 把推送发给主进程');
    const managerSrc = read('src/runtime/worker-manager.ts');
    assert.match(managerSrc, /msg\.type === 'push_notify'/);
    assert.match(managerSrc, /sendConfiguredPush\(\{/, '主进程走已配置的推送渠道');
});
