export {};
/**
 * 低级农场 API - protobuf 请求、商店、铲除
 */

const protobuf = require('protobufjs');
const { sendMsgAsync, getUserState } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { toLong, toNum, getServerTimeSec, sleep, randomDelay, log, logWarn } = require('../../utils/utils');

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate: ((limits: any) => void) | null = null;
function setOperationLimitsCallback(callback: (limits: any) => void): void {
    onOperationLimitsUpdate = callback;
}

/**
 * 通用植物操作请求
 */
async function sendPlantRequest(
    RequestType: any,
    ReplyType: any,
    method: string,
    landIds: number[],
    hostGid: number | string,
): Promise<any> {
    const body = RequestType.encode(RequestType.create({
        land_ids: landIds,
        host_gid: toLong(hostGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
    return ReplyType.decode(replyBody);
}

async function getAllLands(): Promise<any> {
    const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
    const reply = types.AllLandsReply.decode(replyBody);
    // 更新操作限制
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}

async function harvest(landIds: number[]): Promise<any> {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

async function waterLand(landIds: number[]): Promise<any> {
    const state = getUserState();
    return sendPlantRequest(types.WaterLandRequest, types.WaterLandReply, 'WaterLand', landIds, state.gid);
}

async function farming(landIds: number[]): Promise<any> {
    const state = getUserState();
    return sendPlantRequest(types.FarmingRequest, types.FarmingReply, 'Farming', landIds, state.gid);
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID: number = 1011;
// 有机肥料 ID
const ORGANIC_FERTILIZER_ID: number = 1012;

/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 游戏中拖动施肥间隔很短，这里用 50ms
 */
async function fertilize(landIds: number[], fertilizerId: number = NORMAL_FERTILIZER_ID): Promise<number> {
    let successCount: number = 0;
    for (const landId of landIds) {
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(fertilizerId),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 施肥失败（可能肥料不足），停止继续
            break;
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

/**
 * 有机肥循环施肥:
 * 按地块顺序 1-2-3-...-1 持续施肥，直到出现失败即停止。
 */
async function fertilizeOrganicLoop(landIds: number[] | any[]): Promise<number> {
    const ids: number[] = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
    if (ids.length === 0) return 0;

    let successCount: number = 0;
    let idx: number = 0;

    while (true) {
        const landId = ids[idx];
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(ORGANIC_FERTILIZER_ID),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 常见是有机肥耗尽，按需求直接停止
            break;
        }

        idx = (idx + 1) % ids.length;
        await randomDelay(1000, 1500);
    }

    return successCount;
}

async function removePlant(landIds: number[]): Promise<any> {
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: landIds.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}

async function upgradeLand(landId: number): Promise<any> {
    const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
        land_id: toLong(landId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
    return types.UpgradeLandReply.decode(replyBody);
}

async function unlockLand(landId: number, doShared: boolean = false): Promise<any> {
    const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
        land_id: toLong(landId),
        do_shared: !!doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
    return types.UnlockLandReply.decode(replyBody);
}

// ============ 商店 API ============

async function getShopInfo(shopId: number): Promise<any> {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}

async function buyGoods(goodsId: number, num: number, price: number): Promise<any> {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}

// ============ 变异图鉴 ============

async function readMutantBook(): Promise<void> {
    const body: Uint8Array = types.ReadMutantBookRequest.encode(types.ReadMutantBookRequest.create({})).finish();
    await sendMsgAsync('gamepb.mutantpb.MutantService', 'ReadMutantBook', body);
}

// ============ 种植编码 ============

function encodePlantRequest(seedId: number | string, landIds: number[]): Uint8Array {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

module.exports = {
    setOperationLimitsCallback,
    sendPlantRequest,
    getAllLands,
    harvest,
    waterLand,
    farming,
    fertilize,
    fertilizeOrganicLoop,
    removePlant,
    upgradeLand,
    unlockLand,
    getShopInfo,
    buyGoods,
    encodePlantRequest,
    readMutantBook,
};
