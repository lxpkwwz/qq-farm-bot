export {};
/**
 * Proto 加载与消息类型管理
 */
import type protobuf from 'protobufjs';

const protobufModule = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const { log } = require('./utils');

// Proto 根对象与所有消息类型
let root: protobuf.Root | null = null;
const types: Record<string, protobuf.Type> = {};

async function loadProto(): Promise<void> {
    log('系统', '正在加载 Protobuf 定义...');
    root = new protobufModule.Root();
    await root.load([
        getResourcePath('proto', 'game.proto'),
        getResourcePath('proto', 'userpb.proto'),
        getResourcePath('proto', 'plantpb.proto'),
        getResourcePath('proto', 'corepb.proto'),
        getResourcePath('proto', 'shoppb.proto'),
        getResourcePath('proto', 'friendpb.proto'),
        getResourcePath('proto', 'visitpb.proto'),
        getResourcePath('proto', 'notifypb.proto'),
        getResourcePath('proto', 'taskpb.proto'),
        getResourcePath('proto', 'itempb.proto'),
        getResourcePath('proto', 'emailpb.proto'),
        getResourcePath('proto', 'mallpb.proto'),
        getResourcePath('proto', 'redpacketpb.proto'),
        getResourcePath('proto', 'qqvippb.proto'),
        getResourcePath('proto', 'sharepb.proto'),
        getResourcePath('proto', 'illustratedpb.proto'),
        getResourcePath('proto', 'interactpb.proto'),
        getResourcePath('proto', 'activitypb.proto'),
        getResourcePath('proto', 'randomdroppb.proto'),
        getResourcePath('proto', 'guidepb.proto'),
        getResourcePath('proto', 'acepb.proto'),
        getResourcePath('proto', 'careerpb.proto'),
        getResourcePath('proto', 'dogpb.proto'),
        getResourcePath('proto', 'skinpb.proto'),
        getResourcePath('proto', 'avatarframepb.proto'),
        getResourcePath('proto', 'bulletinboardpb.proto'),
        getResourcePath('proto', 'marqueepb.proto'),
        getResourcePath('proto', 'paypb.proto'),
        getResourcePath('proto', 'rechargebonuspb.proto'),
        getResourcePath('proto', 'uicproxypb.proto'),
        getResourcePath('proto', 'mutantpb.proto'),
    ], { keepCase: true });

    // 网关
    types.GateMessage = root.lookupType('gatepb.Message');
    types.GateMeta = root.lookupType('gatepb.Meta');
    types.EventMessage = root.lookupType('gatepb.EventMessage');

    // 用户
    types.LoginRequest = root.lookupType('gamepb.userpb.LoginRequest');
    types.LoginReply = root.lookupType('gamepb.userpb.LoginReply');
    types.HeartbeatRequest = root.lookupType('gamepb.userpb.HeartbeatRequest');
    types.HeartbeatReply = root.lookupType('gamepb.userpb.HeartbeatReply');
    types.ReportArkClickRequest = root.lookupType('gamepb.userpb.ReportArkClickRequest');
    types.ReportArkClickReply = root.lookupType('gamepb.userpb.ReportArkClickReply');
    types.BatchClientReportFlowRequest = root.lookupType('gamepb.userpb.BatchClientReportFlowRequest');
    types.BatchClientReportFlowReply = root.lookupType('gamepb.userpb.BatchClientReportFlowReply');
    types.SetDisplayInfoRequest = root.lookupType('gamepb.userpb.SetDisplayInfoRequest');
    types.SetDisplayInfoReply = root.lookupType('gamepb.userpb.SetDisplayInfoReply');
    types.SetQQFriendRecommendAuthorizedRequest = root.lookupType('gamepb.userpb.SetQQFriendRecommendAuthorizedRequest');
    types.SetQQFriendRecommendAuthorizedReply = root.lookupType('gamepb.userpb.SetQQFriendRecommendAuthorizedReply');
    types.GetUserSettingsRequest = root.lookupType('gamepb.userpb.GetUserSettingsRequest');
    types.GetUserSettingsReply = root.lookupType('gamepb.userpb.GetUserSettingsReply');
    types.BatchGetBasicInfoRequest = root.lookupType('gamepb.userpb.BatchGetBasicInfoRequest');
    types.BatchGetBasicInfoReply = root.lookupType('gamepb.userpb.BatchGetBasicInfoReply');

    // 农场
    types.AllLandsRequest = root.lookupType('gamepb.plantpb.AllLandsRequest');
    types.AllLandsReply = root.lookupType('gamepb.plantpb.AllLandsReply');
    types.HarvestRequest = root.lookupType('gamepb.plantpb.HarvestRequest');
    types.HarvestReply = root.lookupType('gamepb.plantpb.HarvestReply');
    types.WaterLandRequest = root.lookupType('gamepb.plantpb.WaterLandRequest');
    types.WaterLandReply = root.lookupType('gamepb.plantpb.WaterLandReply');
    types.WeedOutRequest = root.lookupType('gamepb.plantpb.WeedOutRequest');
    types.WeedOutReply = root.lookupType('gamepb.plantpb.WeedOutReply');
    types.InsecticideRequest = root.lookupType('gamepb.plantpb.InsecticideRequest');
    types.InsecticideReply = root.lookupType('gamepb.plantpb.InsecticideReply');
    types.FarmingRequest = root.lookupType('gamepb.plantpb.FarmingRequest');
    types.FarmingReply = root.lookupType('gamepb.plantpb.FarmingReply');
    types.RemovePlantRequest = root.lookupType('gamepb.plantpb.RemovePlantRequest');
    types.RemovePlantReply = root.lookupType('gamepb.plantpb.RemovePlantReply');
    types.PutInsectsRequest = root.lookupType('gamepb.plantpb.PutInsectsRequest');
    types.PutInsectsReply = root.lookupType('gamepb.plantpb.PutInsectsReply');
    types.PutWeedsRequest = root.lookupType('gamepb.plantpb.PutWeedsRequest');
    types.PutWeedsReply = root.lookupType('gamepb.plantpb.PutWeedsReply');
    types.UpgradeLandRequest = root.lookupType('gamepb.plantpb.UpgradeLandRequest');
    types.UpgradeLandReply = root.lookupType('gamepb.plantpb.UpgradeLandReply');
    types.UnlockLandRequest = root.lookupType('gamepb.plantpb.UnlockLandRequest');
    types.UnlockLandReply = root.lookupType('gamepb.plantpb.UnlockLandReply');
    types.CheckCanOperateRequest = root.lookupType('gamepb.plantpb.CheckCanOperateRequest');
    types.CheckCanOperateReply = root.lookupType('gamepb.plantpb.CheckCanOperateReply');
    types.FertilizeRequest = root.lookupType('gamepb.plantpb.FertilizeRequest');
    types.FertilizeReply = root.lookupType('gamepb.plantpb.FertilizeReply');
    types.PutSocialItemRequest = root.lookupType('gamepb.plantpb.PutSocialItemRequest');
    types.PutSocialItemReply = root.lookupType('gamepb.plantpb.PutSocialItemReply');

    // 背包/仓库
    types.BagRequest = root.lookupType('gamepb.itempb.BagRequest');
    types.BagReply = root.lookupType('gamepb.itempb.BagReply');
    types.SellRequest = root.lookupType('gamepb.itempb.SellRequest');
    types.SellReply = root.lookupType('gamepb.itempb.SellReply');
    types.UseRequest = root.lookupType('gamepb.itempb.UseRequest');
    types.UseReply = root.lookupType('gamepb.itempb.UseReply');
    types.BatchUseRequest = root.lookupType('gamepb.itempb.BatchUseRequest');
    types.BatchUseReply = root.lookupType('gamepb.itempb.BatchUseReply');
    types.PlantRequest = root.lookupType('gamepb.plantpb.PlantRequest');
    types.PlantReply = root.lookupType('gamepb.plantpb.PlantReply');

    // 商店
    types.ShopProfilesRequest = root.lookupType('gamepb.shoppb.ShopProfilesRequest');
    types.ShopProfilesReply = root.lookupType('gamepb.shoppb.ShopProfilesReply');
    types.ShopInfoRequest = root.lookupType('gamepb.shoppb.ShopInfoRequest');
    types.ShopInfoReply = root.lookupType('gamepb.shoppb.ShopInfoReply');
    types.BuyGoodsRequest = root.lookupType('gamepb.shoppb.BuyGoodsRequest');
    types.BuyGoodsReply = root.lookupType('gamepb.shoppb.BuyGoodsReply');
    types.GetMonthCardInfosRequest = root.lookupType('gamepb.mallpb.GetMonthCardInfosRequest');
    types.GetMonthCardInfosReply = root.lookupType('gamepb.mallpb.GetMonthCardInfosReply');
    types.ClaimMonthCardRewardRequest = root.lookupType('gamepb.mallpb.ClaimMonthCardRewardRequest');
    types.ClaimMonthCardRewardReply = root.lookupType('gamepb.mallpb.ClaimMonthCardRewardReply');
    types.GetTodayClaimStatusRequest = root.lookupType('gamepb.redpacketpb.GetTodayClaimStatusRequest');
    types.GetTodayClaimStatusReply = root.lookupType('gamepb.redpacketpb.GetTodayClaimStatusReply');
    types.ClaimRedPacketRequest = root.lookupType('gamepb.redpacketpb.ClaimRedPacketRequest');
    types.ClaimRedPacketReply = root.lookupType('gamepb.redpacketpb.ClaimRedPacketReply');
    types.GetMallListBySlotTypeRequest = root.lookupType('gamepb.mallpb.GetMallListBySlotTypeRequest');
    types.GetMallListBySlotTypeResponse = root.lookupType('gamepb.mallpb.GetMallListBySlotTypeResponse');
    types.MallGoods = root.lookupType('gamepb.mallpb.MallGoods');
    types.PurchaseRequest = root.lookupType('gamepb.mallpb.PurchaseRequest');
    types.PurchaseResponse = root.lookupType('gamepb.mallpb.PurchaseResponse');
    types.GetDailyGiftStatusRequest = root.lookupType('gamepb.qqvippb.GetDailyGiftStatusRequest');
    types.GetDailyGiftStatusReply = root.lookupType('gamepb.qqvippb.GetDailyGiftStatusReply');
    types.ClaimDailyGiftRequest = root.lookupType('gamepb.qqvippb.ClaimDailyGiftRequest');
    types.ClaimDailyGiftReply = root.lookupType('gamepb.qqvippb.ClaimDailyGiftReply');
    types.CheckCanShareRequest = root.lookupType('gamepb.sharepb.CheckCanShareRequest');
    types.CheckCanShareReply = root.lookupType('gamepb.sharepb.CheckCanShareReply');
    types.ReportShareRequest = root.lookupType('gamepb.sharepb.ReportShareRequest');
    types.ReportShareReply = root.lookupType('gamepb.sharepb.ReportShareReply');
    types.ClaimShareRewardRequest = root.lookupType('gamepb.sharepb.ClaimShareRewardRequest');
    types.ClaimShareRewardReply = root.lookupType('gamepb.sharepb.ClaimShareRewardReply');
    types.GetIllustratedListV2Request = root.lookupType('gamepb.illustratedpb.GetIllustratedListV2Request');
    types.GetIllustratedListV2Reply = root.lookupType('gamepb.illustratedpb.GetIllustratedListV2Reply');
    types.ClaimAllRewardsV2Request = root.lookupType('gamepb.illustratedpb.ClaimAllRewardsV2Request');
    types.ClaimAllRewardsV2Reply = root.lookupType('gamepb.illustratedpb.ClaimAllRewardsV2Reply');
    types.ClearNewUnlockedFruitsV2Request = root.lookupType('gamepb.illustratedpb.ClearNewUnlockedFruitsV2Request');
    types.ClearNewUnlockedFruitsV2Reply = root.lookupType('gamepb.illustratedpb.ClearNewUnlockedFruitsV2Reply');

    // 好友
    types.GetAllFriendsRequest = root.lookupType('gamepb.friendpb.GetAllRequest');
    types.GetAllFriendsReply = root.lookupType('gamepb.friendpb.GetAllReply');
    types.GetApplicationsRequest = root.lookupType('gamepb.friendpb.GetApplicationsRequest');
    types.GetApplicationsReply = root.lookupType('gamepb.friendpb.GetApplicationsReply');
    types.AcceptFriendsRequest = root.lookupType('gamepb.friendpb.AcceptFriendsRequest');
    types.AcceptFriendsReply = root.lookupType('gamepb.friendpb.AcceptFriendsReply');
    types.SyncAllFriendsRequest = root.lookupType('gamepb.friendpb.SyncAllRequest');
    types.SyncAllFriendsReply = root.lookupType('gamepb.friendpb.SyncAllReply');
    types.GetGameFriendsRequest = root.lookupType('gamepb.friendpb.GetGameFriendsRequest');
    types.GetGameFriendsReply = root.lookupType('gamepb.friendpb.GetGameFriendsReply');
    types.GetShareKeyRequest = root.lookupType('gamepb.friendpb.GetShareKeyRequest');
    types.GetShareKeyReply = root.lookupType('gamepb.friendpb.GetShareKeyReply');

    // 访问
    types.VisitEnterRequest = root.lookupType('gamepb.visitpb.EnterRequest');
    types.VisitEnterReply = root.lookupType('gamepb.visitpb.EnterReply');
    types.VisitLeaveRequest = root.lookupType('gamepb.visitpb.LeaveRequest');
    types.VisitLeaveReply = root.lookupType('gamepb.visitpb.LeaveReply');

    // 任务
    types.TaskInfoRequest = root.lookupType('gamepb.taskpb.TaskInfoRequest');
    types.TaskInfoReply = root.lookupType('gamepb.taskpb.TaskInfoReply');
    types.ClaimTaskRewardRequest = root.lookupType('gamepb.taskpb.ClaimTaskRewardRequest');
    types.ClaimTaskRewardReply = root.lookupType('gamepb.taskpb.ClaimTaskRewardReply');
    types.BatchClaimTaskRewardRequest = root.lookupType('gamepb.taskpb.BatchClaimTaskRewardRequest');
    types.BatchClaimTaskRewardReply = root.lookupType('gamepb.taskpb.BatchClaimTaskRewardReply');
    types.ClaimDailyRewardRequest = root.lookupType('gamepb.taskpb.ClaimDailyRewardRequest');
    types.ClaimDailyRewardReply = root.lookupType('gamepb.taskpb.ClaimDailyRewardReply');

    // 邮箱
    types.GetEmailListRequest = root.lookupType('gamepb.emailpb.GetEmailListRequest');
    types.GetEmailListReply = root.lookupType('gamepb.emailpb.GetEmailListReply');
    types.ClaimEmailRequest = root.lookupType('gamepb.emailpb.ClaimEmailRequest');
    types.ClaimEmailReply = root.lookupType('gamepb.emailpb.ClaimEmailReply');
    types.BatchClaimEmailRequest = root.lookupType('gamepb.emailpb.BatchClaimEmailRequest');
    types.BatchClaimEmailReply = root.lookupType('gamepb.emailpb.BatchClaimEmailReply');
    types.BatchDeleteEmailRequest = root.lookupType('gamepb.emailpb.BatchDeleteEmailRequest');
    types.BatchDeleteEmailReply = root.lookupType('gamepb.emailpb.BatchDeleteEmailReply');

    // 服务器推送通知
    types.LandsNotify = root.lookupType('gamepb.plantpb.LandsNotify');
    types.BasicNotify = root.lookupType('gamepb.userpb.BasicNotify');
    types.KickoutNotify = root.lookupType('gatepb.KickoutNotify');
    types.FriendApplicationReceivedNotify = root.lookupType('gamepb.friendpb.FriendApplicationReceivedNotify');
    types.FriendAddedNotify = root.lookupType('gamepb.friendpb.FriendAddedNotify');
    types.InteractRecordsRequest = root.lookupType('gamepb.interactpb.InteractRecordsRequest');
    types.InteractRecordsReply = root.lookupType('gamepb.interactpb.InteractRecordsReply');
    types.GetInteractInfoRequest = root.lookupType('gamepb.interactpb.GetInteractInfoRequest');
    types.GetInteractInfoReply = root.lookupType('gamepb.interactpb.GetInteractInfoReply');
    types.GetInteractSummaryRequest = root.lookupType('gamepb.interactpb.GetInteractSummaryRequest');
    types.GetInteractSummaryReply = root.lookupType('gamepb.interactpb.GetInteractSummaryReply');

    // 分享
    types.GetInviteInfoRequest = root.lookupType('gamepb.sharepb.GetInviteInfoRequest');
    types.GetInviteInfoReply = root.lookupType('gamepb.sharepb.GetInviteInfoReply');

    // 活动
    types.ActivityListRequest = root.lookupType('gamepb.activitypb.ListRequest');
    types.ActivityListReply = root.lookupType('gamepb.activitypb.ListReply');
    types.ActivityGetGroupRequest = root.lookupType('gamepb.activitypb.GetGroupRequest');
    types.ActivityGetGroupReply = root.lookupType('gamepb.activitypb.GetGroupReply');
    types.ActivityOperateRequest = root.lookupType('gamepb.activitypb.OperateRequest');
    types.ActivityOperateReply = root.lookupType('gamepb.activitypb.OperateReply');

    // 随机掉落
    types.RandomDropGetActivityInfoRequest = root.lookupType('gamepb.randomdroppb.GetActivityInfoRequest');
    types.RandomDropGetActivityInfoReply = root.lookupType('gamepb.randomdroppb.GetActivityInfoReply');

    // 引导
    types.SetWeakGuideNodeCompleteRequest = root.lookupType('gamepb.guidepb.SetWeakGuideNodeCompleteRequest');
    types.SetWeakGuideNodeCompleteReply = root.lookupType('gamepb.guidepb.SetWeakGuideNodeCompleteReply');
    types.ClaimWeakGuideRewardRequest = root.lookupType('gamepb.guidepb.ClaimWeakGuideRewardRequest');
    types.ClaimWeakGuideRewardReply = root.lookupType('gamepb.guidepb.ClaimWeakGuideRewardReply');

    // 反作弊
    types.AntiDataRequest = root.lookupType('gamepb.acepb.AntiDataRequest');
    types.AntiDataReply = root.lookupType('gamepb.acepb.AntiDataReply');

    // 变异
    types.ReadMutantBookRequest = root.lookupType('gamepb.mutantpb.ReadMutantBookRequest');
    types.ReadMutantBookReply = root.lookupType('gamepb.mutantpb.ReadMutantBookReply');

    // 职业
    types.CareerInfoGetRequest = root.lookupType('gamepb.careerpb.CareerInfoGetRequest');
    types.CareerInfoGetReply = root.lookupType('gamepb.careerpb.CareerInfoGetReply');

    // 狗狗
    types.GetDogInfoRequest = root.lookupType('gamepb.dogpb.GetDogInfoRequest');
    types.GetDogInfoReply = root.lookupType('gamepb.dogpb.GetDogInfoReply');

    // 皮肤
    types.SkinsOwnedRequest = root.lookupType('gamepb.skinpb.SkinsOwnedRequest');
    types.SkinsOwnedReply = root.lookupType('gamepb.skinpb.SkinsOwnedReply');
    types.SkinsEquippedRequest = root.lookupType('gamepb.skinpb.SkinsEquippedRequest');
    types.SkinsEquippedReply = root.lookupType('gamepb.skinpb.SkinsEquippedReply');

    // 头像框
    types.AvatarFramesOwnedRequest = root.lookupType('gamepb.avatarframepb.AvatarFramesOwnedRequest');
    types.AvatarFramesOwnedReply = root.lookupType('gamepb.avatarframepb.AvatarFramesOwnedReply');

    // 公告板
    types.GetBulletinListRequest = root.lookupType('gamepb.bulletinboardpb.GetBulletinListRequest');
    types.GetBulletinListReply = root.lookupType('gamepb.bulletinboardpb.GetBulletinListReply');

    // 跑马灯
    types.GetMarqueeRequest = root.lookupType('gamepb.marqueepb.GetMarqueeRequest');
    types.GetMarqueeReply = root.lookupType('gamepb.marqueepb.GetMarqueeReply');

    // 充值
    types.GetRechargeInfoRequest = root.lookupType('gamepb.paypb.GetRechargeInfoRequest');
    types.GetRechargeInfoReply = root.lookupType('gamepb.paypb.GetRechargeInfoReply');
    types.RechargeInfoNotify = root.lookupType('gamepb.paypb.RechargeInfoNotify');

    // 充值奖励
    types.GetRechargeBonusConfigRequest = root.lookupType('gamepb.rechargebonuspb.GetConfigRequest');
    types.GetRechargeBonusConfigReply = root.lookupType('gamepb.rechargebonuspb.GetConfigReply');

    // 文本审核
    types.BatchModerateTextRequest = root.lookupType('gamepb.uicproxypb.BatchModerateTextRequest');
    types.BatchModerateTextReply = root.lookupType('gamepb.uicproxypb.BatchModerateTextReply');

    // 取消"新"标记
    types.CannelNewRequest = root.lookupType('gamepb.itempb.CannelNewRequest');
    types.CannelNewReply = root.lookupType('gamepb.itempb.CannelNewReply');

    // 通知
    types.ItemNotify = root.lookupType('gamepb.itempb.ItemNotify');
    types.GoodsUnlockNotify = root.lookupType('gamepb.shoppb.GoodsUnlockNotify');
    types.TaskInfoNotify = root.lookupType('gamepb.taskpb.TaskInfoNotify');
    types.NeedNotify = root.lookupType('gamepb.mallpb.NeedNotify');
    types.VipInfoUpdatedNTF = root.lookupType('gamepb.qqvippb.VipInfoUpdatedNTF');
    types.ProductsHasChangedNotify = root.lookupType('gamepb.mallpb.ProductsHasChangedNotify');
    types.ActiviesChangeNotify = root.lookupType('gamepb.activitypb.ActiviesChangeNotify');

    // Proto 加载完成
    log('系统', 'Protobuf 定义加载完成');
}

module.exports = { loadProto, types };
