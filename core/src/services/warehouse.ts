export {};
/**
 * 仓库系统 - 自动出售果实
 * 协议说明：BagReply 使用 item_bag（ItemBag），item_bag.items 才是背包物品列表
 */
import type protobuf from 'protobufjs';

const protobufModule = require('protobufjs');
const { getFruitName, getPlantByFruitId, getPlantBySeedId, getItemById, getItemImageById, getSeedImageBySeedId } = require('../config/gameConfig');
const { isAutomationOn } = require('../models/store');
const { sendMsgAsync, networkEvents, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');
const { updateStatusGold } = require('./status');

const SELL_BATCH_SIZE: number = 15;
const FERTILIZER_RELATED_IDS: Set<number> = new Set([
    100003, // 化肥礼包
    100004, // 有机化肥礼包
    80001, 80002, 80003, 80004, // 普通化肥道具
    80011, 80012, 80013, 80014, // 有机化肥道具
]);
const FERTILIZER_CONTAINER_LIMIT_HOURS: number = 990;
const NORMAL_CONTAINER_ID: number = 1011;
const ORGANIC_CONTAINER_ID: number = 1012;
const NORMAL_FERTILIZER_ITEM_HOURS: Map<number, number> = new Map([
    [80001, 1], [80002, 4], [80003, 8], [80004, 12],
]);
const ORGANIC_FERTILIZER_ITEM_HOURS: Map<number, number> = new Map([
    [80011, 1], [80012, 4], [80013, 8], [80014, 12],
]);
let fertilizerGiftDoneDateKey: string = '';
let fertilizerGiftLastOpenAt: number = 0;

function getDateKey(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ============ API ============

async function getBag(): Promise<any> {
    const body: Uint8Array = types.BagRequest.encode(types.BagRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Bag', body);
    return types.BagReply.decode(replyBody);
}

function toSellItem(item: any): any {
    const idNum: number = toNum(item && item.id);
    const countNum: number = toNum(item && item.count);
    const uidNum: number = toNum(item && item.uid);
    const payload: any = {
        id: toLong(idNum),
        count: toLong(countNum),
    };
    // SellRequest 通常只需要 id + count；仅在 uid 有效时携带
    if (uidNum > 0) payload.uid = toLong(uidNum);
    return payload;
}

async function sellItems(items: any[]): Promise<any> {
    const payload: any[] = items.map(toSellItem);
    const body: Uint8Array = types.SellRequest.encode(types.SellRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Sell', body);
    return types.SellReply.decode(replyBody);
}

async function useItem(itemId: number, count: number = 1, landIds: number[] = []): Promise<any> {
    const body: Uint8Array = types.UseRequest.encode(types.UseRequest.create({
        item_id: toLong(itemId),
        count: toLong(count),
        land_ids: (landIds || []).map((id: number) => toLong(id)),
    })).finish();
    try {
        const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
        return types.UseReply.decode(replyBody);
    } catch (e: any) {
        const msg: string = String((e && e.message) || '');
        const isParamError: boolean = msg.includes('code=1000020') || msg.includes('请求参数错误');
        if (!isParamError) throw e;

        // 兼容另一种 UseRequest 编码: { item: { id, count } }
        const writer: protobuf.Writer = protobufModule.Writer.create();
        const itemWriter: protobuf.Writer = writer.uint32(10).fork(); // field 1: item
        itemWriter.uint32(8).int64(toLong(itemId));  // item.id
        itemWriter.uint32(16).int64(toLong(count));  // item.count
        itemWriter.ldelim();
        const fallbackBody: Uint8Array = writer.finish();

        const { body: fallbackReplyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', fallbackBody);
        return types.UseReply.decode(fallbackReplyBody);
    }
}

async function batchUseItems(items: any[]): Promise<any> {
    const payload: any[] = (items || []).map((it: any) => ({
        id: toLong(it.itemId),
        count: toLong(it.count || 1),
        uid: toLong(it.uid || 0),
    }));
    const body: Uint8Array = types.BatchUseRequest.encode(types.BatchUseRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', body);
    return types.BatchUseReply.decode(replyBody);
}

function isFruitItemId(id: number): boolean {
    return !!getPlantByFruitId(Number(id));
}

function getBagItems(bagReply: any): any[] {
    if (bagReply && bagReply.item_bag && bagReply.item_bag.items && bagReply.item_bag.items.length) {
        return bagReply.item_bag.items;
    }
    return bagReply && bagReply.items ? bagReply.items : [];
}

function isFertilizerRelatedItemId(itemId: number): boolean {
    const id: number = Number(itemId) || 0;
    if (id <= 0) return false;
    // 禁止对容器道具执行使用，避免触发 1011/1012 补充逻辑
    if (id === 1011 || id === 1012) return false;
    if (FERTILIZER_RELATED_IDS.has(id)) return true;
    const info: any = getItemById(id);
    if (!info || typeof info !== 'object') return false;
    const interactionType: string = String(info.interaction_type || '').toLowerCase();
    return interactionType === 'fertilizer' || interactionType === 'fertilizerpro';
}

function collectFertilizerUsePayload(items: any[]): Array<{ id: number; count: number }> {
    const merged: Map<number, number> = new Map();
    for (const it of (items || [])) {
        const id: number = toNum(it && it.id);
        const count: number = Math.max(0, toNum(it && it.count));
        if (id <= 0 || count <= 0) continue;
        if (!isFertilizerRelatedItemId(id)) continue;
        merged.set(id, (merged.get(id) || 0) + count);
    }
    return Array.from(merged.entries()).map(([id, count]) => ({ id, count }));
}

function getContainerHoursFromBagItems(items: any[]): { normal: number; organic: number } {
    let normalSec: number = 0;
    let organicSec: number = 0;
    for (const it of (items || [])) {
        const id: number = toNum(it && it.id);
        const count: number = Math.max(0, toNum(it && it.count));
        if (id === NORMAL_CONTAINER_ID) normalSec = count;
        if (id === ORGANIC_CONTAINER_ID) organicSec = count;
    }
    return {
        normal: normalSec / 3600,
        organic: organicSec / 3600,
    };
}

function getFertilizerItemTypeAndHours(itemId: number): { type: string; perItemHours: number } {
    const id: number = Number(itemId) || 0;
    if (NORMAL_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'normal', perItemHours: NORMAL_FERTILIZER_ITEM_HOURS.get(id) as number };
    }
    if (ORGANIC_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'organic', perItemHours: ORGANIC_FERTILIZER_ITEM_HOURS.get(id) as number };
    }
    const info: any = getItemById(id) || {};
    const interactionType: string = String(info.interaction_type || '').toLowerCase();
    if (interactionType === 'fertilizer') return { type: 'normal', perItemHours: 1 };
    if (interactionType === 'fertilizerpro') return { type: 'organic', perItemHours: 1 };
    return { type: 'other', perItemHours: 0 };
}

function isFertilizerContainerFullError(err: any): boolean {
    const msg: string = String((err && err.message) || '');
    return msg.includes('code=1003002')
        || msg.includes('普通化肥容器已达到上限')
        || msg.includes('普通化肥容器已满')
        || msg.includes('有机化肥容器已达到上限')
        || msg.includes('有机化肥容器已满');
}

async function autoOpenFertilizerGiftPacks(): Promise<number> {
    try {
        const bagReply: any = await getBag();
        const bagItems: any[] = getBagItems(bagReply);
        const payloads: Array<{ id: number; count: number }> = collectFertilizerUsePayload(bagItems);
        if (payloads.length <= 0) {
            return 0;
        }
        const containerHours: { normal: number; organic: number } = getContainerHoursFromBagItems(bagItems);

        let opened: number = 0;
        const details: string[] = [];
        // 按条目 BatchUse，避免数量大时逐个 Use 造成请求风暴
        for (const row of payloads) {
            const itemId: number = Number(row.id) || 0;
            const rawCount: number = Math.max(1, Number(row.count) || 0);
            const { type, perItemHours } = getFertilizerItemTypeAndHours(itemId);
            let useCount: number = rawCount;

            // 容器达到 990h 后不再使用对应化肥道具；未达到时也按剩余可用小时裁剪数量
            if (type === 'normal' || type === 'organic') {
                const currentHours: number = type === 'normal' ? containerHours.normal : containerHours.organic;
                if (currentHours >= FERTILIZER_CONTAINER_LIMIT_HOURS) {
                    continue;
                }
                if (perItemHours > 0) {
                    const remainHours: number = Math.max(0, FERTILIZER_CONTAINER_LIMIT_HOURS - currentHours);
                    const maxCountByHours: number = Math.floor(remainHours / perItemHours);
                    useCount = Math.max(0, Math.min(rawCount, maxCountByHours));
                    if (useCount <= 0) continue;
                }
            }
            const itemInfo: any = getItemById(itemId);
            const itemName: string = itemInfo && itemInfo.name ? String(itemInfo.name) : `物品#${itemId}`;
            let used: number = 0;
            try {
                await batchUseItems([{ itemId, count: useCount, uid: 0 }]);
                used = useCount;
            } catch {
                // BatchUse 失败时直接跳过该条目
                used = 0;
            }
            if (used > 0) {
                opened += used;
                details.push(`${itemName}x${used}`);
                if (type === 'normal' && perItemHours > 0) containerHours.normal += used * perItemHours;
                if (type === 'organic' && perItemHours > 0) containerHours.organic += used * perItemHours;
            }
            await sleep(100);
        }

        if (opened > 0) {
            fertilizerGiftDoneDateKey = getDateKey();
            fertilizerGiftLastOpenAt = Date.now();
            log('仓库', `自动使用化肥类道具 x${opened}${details.length ? ` [${details.join('，')}]` : ''}`, {
                module: 'warehouse',
                event: '开启化肥礼包',
                result: 'ok',
                count: opened,
            });
        }
        return opened;
    } catch (e: any) {
        if (isFertilizerContainerFullError(e)) {
            return 0;
        }
        logWarn('仓库', `开启化肥礼包失败: ${e.message}`, {
            module: 'warehouse',
            event: '开启化肥礼包',
            result: 'error',
        });
        return 0;
    }
}

async function openFertilizerGiftPacksSilently(): Promise<number> {
    return autoOpenFertilizerGiftPacks();
}

function getGoldFromItems(items: any[]): number {
    for (const item of (items || [])) {
        const id: number = toNum(item.id);
        if (id === 1 || id === 1001) {
            const count: number = toNum(item.count);
            if (count > 0) return count;
        }
    }
    return 0;
}

function deriveGoldGainFromSellReply(reply: any, lastKnownGold: number): { gain: number; nextKnownGold: number } {
    const gainFromGetItems: number = getGoldFromItems((reply && reply.get_items) || []);
    if (gainFromGetItems > 0) {
        // get_items 通常就是本次获得值
        return { gain: gainFromGetItems, nextKnownGold: lastKnownGold };
    }

    // 兼容旧 proto/旧结构
    const currentOrDelta: number = getGoldFromItems((reply && (reply.items || reply.sell_items)) || []);
    if (currentOrDelta <= 0) return { gain: 0, nextKnownGold: lastKnownGold };

    // 协议在不同场景下可能返回"当前总金币"或"本次变化值"
    if (lastKnownGold > 0 && currentOrDelta >= lastKnownGold) {
        return { gain: currentOrDelta - lastKnownGold, nextKnownGold: currentOrDelta };
    }
    return { gain: currentOrDelta, nextKnownGold: lastKnownGold };
}

function getCurrentTotals(): { gold: number; exp: number } {
    const state: any = getUserState() || {};
    return {
        gold: Number(state.gold || 0),
        exp: Number(state.exp || 0),
    };
}

async function getCurrentTotalsFromBag(): Promise<{ gold: number | null; exp: number | null }> {
    const bagReply: any = await getBag();
    const items: any[] = getBagItems(bagReply);
    let gold: number | null = null;
    let exp: number | null = null;
    for (const item of items) {
        const id: number = toNum(item.id);
        const count: number = toNum(item.count);
        if (id === 1 || id === 1001) gold = count;       // 金币
        if (id === 1101) exp = count;     // 累计经验
    }
    return { gold, exp };
}

async function getBagDetail(): Promise<any> {
    const bagReply: any = await getBag();
    const rawItems: any[] = getBagItems(bagReply);

    // 保留原始物品列表（用于出售等操作）
    const originalItems: any[] = [];
    for (const it of (rawItems || [])) {
        const id: number = toNum(it.id);
        const count: number = toNum(it.count);
        const uid: number = toNum(it.uid);
        if (id <= 0 || count <= 0) continue;
        originalItems.push({ id, count, uid });
    }

    // 合并展示
    const merged: Map<number, any> = new Map();
    for (const it of (rawItems || [])) {
        const id: number = toNum(it.id);
        const count: number = toNum(it.count);
        if (id <= 0 || count <= 0) continue;
        const info: any = getItemById(id) || null;
        let name: string = info && info.name ? String(info.name) : '';
        let category: string = 'item';
        if (id === 1 || id === 1001) {
            name = '金币';
            category = 'gold';
        } else if (id === 1101) {
            name = '经验';
            category = 'exp';
        } else if (getPlantByFruitId(id)) {
            if (!name) name = `${getFruitName(id)}果实`;
            category = 'fruit';
        } else if (getPlantBySeedId(id)) {
            const p: any = getPlantBySeedId(id);
            if (!name) name = `${p && p.name ? p.name : '未知'}种子`;
            category = 'seed';
        }
        if (!name) name = `物品${id}`;
        const interactionType: string = info && info.interaction_type ? String(info.interaction_type) : '';
        const priceId: number = info ? (Number(info.price_id) || 0) : 0;
        const priceUnit: string = priceId === 1005 ? '金豆豆' : priceId === 1002 ? '点券' : '金';

        if (!merged.has(id)) {
            merged.set(id, {
                id,
                count: 0,
                name,
                image: getItemImageById(id),
                category,
                itemType: info ? (Number(info.type) || 0) : 0,
                priceId,
                price: info ? (Number(info.price) || 0) : 0,
                priceUnit,
                level: info ? (Number(info.level) || 0) : 0,
                interactionType,
                hoursText: '',
            });
        }
        const row: any = merged.get(id);
        row.count += count;
    }

    const items: any[] = Array.from(merged.values()).map((row: any) => {
        if (row.interactionType === 'fertilizerbucket' && row.count > 0) {
            // 游戏显示更接近截断到 1 位小数（非四舍五入）
            const hoursFloor1: number = Math.floor((row.count / 3600) * 10) / 10;
            row.hoursText = `${hoursFloor1.toFixed(1)}小时`;
        } else {
            row.hoursText = '';
        }
        return row;
    });
    items.sort((a: any, b: any) => {
        const taRaw: number = Number(a.itemType || 0);
        const tbRaw: number = Number(b.itemType || 0);
        const typePriority: Map<number, number> = new Map([
            [17, 0],
            [5, 1],
            [6, 2],
        ]);
        const ta: number = typePriority.has(taRaw) ? typePriority.get(taRaw) as number : (taRaw > 0 ? (1000 + taRaw) : Number.MAX_SAFE_INTEGER);
        const tb: number = typePriority.has(tbRaw) ? typePriority.get(tbRaw) as number : (tbRaw > 0 ? (1000 + tbRaw) : Number.MAX_SAFE_INTEGER);
        if (ta !== tb) return ta - tb;
        const ca: number = Number(a.count || 0);
        const cb: number = Number(b.count || 0);
        if (cb !== ca) return cb - ca;
        return Number(a.id || 0) - Number(b.id || 0);
    });
    return { totalKinds: items.length, items, originalItems };
}

// ============ 出售逻辑 ============

/**
 * 检查并出售所有果实
 */
async function sellAllFruits(): Promise<void> {
    const sellEnabled: boolean = isAutomationOn('sell');
    if (!sellEnabled) {
        return;
    }
    try {
        const bagReply: any = await getBag();
        const items: any[] = getBagItems(bagReply);

        const toSell: any[] = [];
        const names: string[] = [];
        for (const item of items) {
            const id: number = toNum(item.id);
            const count: number = toNum(item.count);
            if (isFruitItemId(id) && count > 0) {
                toSell.push(item);
                names.push(`${getFruitName(id)}x${count}`);
            }
        }

        if (toSell.length === 0) {
            log('仓库', '无果实可出售');
            return;
        }

        const totalsBefore: { gold: number; exp: number } = getCurrentTotals();
        const goldBefore: number = totalsBefore.gold;
        let serverGoldTotal: number = 0;
        let knownGold: number = goldBefore;
        for (let i = 0; i < toSell.length; i += SELL_BATCH_SIZE) {
            const batch: any[] = toSell.slice(i, i + SELL_BATCH_SIZE);
            try {
                const reply: any = await sellItems(batch);
                const inferred: { gain: number; nextKnownGold: number } = deriveGoldGainFromSellReply(reply, knownGold);
                const gained: number = Math.max(0, toNum(inferred.gain));
                knownGold = inferred.nextKnownGold;
                if (gained > 0) serverGoldTotal += gained;
            } catch (batchErr: any) {
                // 某个条目可能参数非法，降级为逐个出售，跳过错误条目
                logWarn('仓库', `批量出售失败，改为逐个重试: ${batchErr.message}`);
                for (const it of batch) {
                    try {
                        const singleReply: any = await sellItems([it]);
                        const inferred: { gain: number; nextKnownGold: number } = deriveGoldGainFromSellReply(singleReply, knownGold);
                        const gained: number = Math.max(0, toNum(inferred.gain));
                        knownGold = inferred.nextKnownGold;
                        if (gained > 0) serverGoldTotal += gained;
                    } catch (singleErr: any) {
                        const sid: number = toNum(it.id);
                        const sc: number = toNum(it.count);
                        logWarn('仓库', `跳过不可售物品: ID=${sid} x${sc} (${singleErr.message})`, {
                            module: 'warehouse',
                            event: '跳过不可售物品',
                            result: 'skip',
                            itemId: sid,
                            count: sc,
                        });
                    }
                }
            }
            if (i + SELL_BATCH_SIZE < toSell.length) await sleep(300);
        }
        // 等待金币通知更新（最多 2s）
        let goldAfter: number = goldBefore;
        const startWait: number = Date.now();
        while (Date.now() - startWait < 2000) {
            const currentGold: number = (getUserState() && getUserState().gold) ? getUserState().gold : goldAfter;
            if (currentGold !== goldBefore) {
                goldAfter = currentGold;
                break;
            }
            await sleep(200);
        }
        const totalsAfter: { gold: number; exp: number } = getCurrentTotals();
        const totalGoldDelta: number = goldAfter > goldBefore ? (goldAfter - goldBefore) : 0;
        const totalsDeltaGold: number = totalsAfter.gold - totalsBefore.gold;
        const totalsDeltaExp: number = totalsAfter.exp - totalsBefore.exp;

        // 通知缺失时，尝试从背包读取金币做最终兜底
        let bagDelta: number = 0;
        if (totalGoldDelta <= 0 && serverGoldTotal <= 0) {
            try {
                const bagAfter: any = await getBag();
                const bagGold: number = getGoldFromItems(getBagItems(bagAfter));
                if (bagGold > goldBefore) bagDelta = bagGold - goldBefore;
            } catch {}
        }

        const totalGoldEarned: number = Math.max(serverGoldTotal, totalGoldDelta, bagDelta);
        if (totalGoldDelta <= 0 && totalGoldEarned > 0) {
            // 某些情况下 ItemNotify 丢失，使用出售回包做金币兜底同步
            const state: any = getUserState();
            if (state) {
                state.gold = Number(state.gold || 0) + totalGoldEarned;
                updateStatusGold(state.gold);
            }
        }
        log('仓库', `出售 ${names.join(', ')}${totalGoldEarned > 0 ? `，获得 ${totalGoldEarned} 金币` : ''}`, {
            module: 'warehouse',
            event: totalGoldEarned > 0 ? 'sell_success' : 'sell_done',
            result: totalGoldEarned > 0 ? 'ok' : 'unknown_gain',
            count: toSell.length,
            gold: totalGoldEarned,
            totalsBefore,
            totalsAfter,
            totalsDeltaGold,
            totalsDeltaExp,
        });

        // 发送出售事件，用于统计金币收益
        if (totalGoldEarned > 0) {
            networkEvents.emit('sell', totalGoldEarned);
        }
    } catch (e: any) {
        logWarn('仓库', `出售失败: ${e.message}`);
    }
}

async function getBagSeeds(): Promise<any[]> {
    const bagReply: any = await getBag();
    const rawItems: any[] = getBagItems(bagReply);
    const merged: Map<number, any> = new Map();

    for (const item of (rawItems || [])) {
        const seedId: number = toNum(item && item.id);
        const count: number = toNum(item && item.count);
        if (seedId <= 0 || count <= 0) continue;

        const plant: any = getPlantBySeedId(seedId);
        if (!plant) continue;

        const current: any = merged.get(seedId) || {
            seedId,
            name: String(plant.name || `种子#${seedId}`),
            count: 0,
            requiredLevel: (() => { const si = getItemById(seedId); return si ? Math.max(0, Number(si.level || 0)) : Math.max(0, Number(plant.land_level_need || 0)); })(),
            image: getSeedImageBySeedId(seedId) || getItemImageById(seedId),
            plantSize: Math.max(1, Number(plant.size || 1)),
        };
        current.count += count;
        merged.set(seedId, current);
    }

    return Array.from(merged.values());
}

module.exports = {
    getBag,
    getBagDetail,
    sellItems,
    useItem,
    batchUseItems,
    openFertilizerGiftPacksSilently,
    getFertilizerGiftDailyState: () => ({
        key: 'fertilizer_gift_open',
        doneToday: fertilizerGiftDoneDateKey === getDateKey(),
        lastOpenAt: fertilizerGiftLastOpenAt,
    }),
    sellAllFruits,
    getBagItems,
    getCurrentTotalsFromBag,
    getBagSeeds,
    getContainerHoursFromBagItems,
};
