export {};
const { Buffer } = require('node:buffer');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { CONFIG } = require('../config/config');
const { createScheduler } = require('../services/scheduler');
const { updateStatusFromLogin, updateStatusGold, updateStatusLevel } = require('../services/status');
const { recordOperation } = require('../services/stats');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, log, logWarn } = require('./utils');
const cryptoWasm = require('./crypto-wasm');
const { startAntiDataLoop, stopAntiDataLoop } = require('../services/ace');

// 延迟加载 warehouse 模块避免循环依赖
let warehouseModule: any = null;
function getWarehouseModule(): any {
    if (!warehouseModule) {
        warehouseModule = require('../services/warehouse');
    }
    return warehouseModule;
}

// ============ 事件发射器 (用于推送通知) ============
const networkEvents = new EventEmitter();

// ============ 内部状态 ============
let ws: WebSocket | null = null;
let clientSeq: number = 1;
let serverSeq: number = 0;
const pendingCallbacks = new Map<number, (err: Error | null, body?: Buffer, meta?: any) => void>();
let wsErrorState = { code: 0, at: 0, message: '' };
const networkScheduler = createScheduler('network');

function rejectAllPendingRequests(reason = '请求被中断'): number {
    const entries = Array.from(pendingCallbacks.entries());
    pendingCallbacks.clear();
    for (const [, callback] of entries) {
        try {
            callback(new Error(reason));
        } catch {
            // ignore callback failure
        }
    }
    return entries.length;
}

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    coupon: 0,
    goldBean: 0,
};

function getUserState() { return userState; }
function getWsErrorState() { return { ...wsErrorState }; }
function setWsErrorState(code: number, message: string): void {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: message || '' };
}
function clearWsErrorState(): void {
    wsErrorState = { code: 0, at: 0, message: '' };
}

// 登录后从背包获取金豆豆数量
async function fetchGoldBeanFromBag(): Promise<void> {
    try {
        const warehouse = getWarehouseModule();
        const bagReply = await warehouse.getBag();
        const items = warehouse.getBagItems(bagReply);
        for (const item of (items || [])) {
            const id = toNum(item && item.id);
            const count = toNum(item && item.count);
            if (id === 1005 && count > 0) {
                userState.goldBean = count;
                log('系统', `金豆豆数量: ${count}`);
                break;
            }
        }
    } catch (e) {
        // 忽略获取失败
    }
}

function hasOwn(obj: any, key: string): boolean {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// 登录后获取用户设置
async function fetchUserSettings(): Promise<void> {
    try {
        const body = types.GetUserSettingsRequest.encode(types.GetUserSettingsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'GetUserSettings', body);
        const reply = types.GetUserSettingsReply.decode(replyBody);
        if (reply.settings) {
            log('系统', `用户设置已同步`);
        }
    } catch (e) {
        // 忽略获取失败
    }
}

// ============ 消息编解码 ============
async function encodeMsg(serviceName: string, methodName: string, bodyBytes: Buffer, clientSeqValue: number): Promise<Buffer> {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        finalBody = await cryptoWasm.encryptBuffer(finalBody);
    }
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeqValue),
            server_seq: toLong(serverSeq),
        },
        body: finalBody,
    });
    return types.GateMessage.encode(msg).finish();
}

async function sendMsg(serviceName: string, methodName: string, bodyBytes: Buffer, callback?: (err: Error | null, body?: Buffer, meta?: any) => void): Promise<boolean> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        log('系统', '[WS] 连接未打开');
        return false;
    }
    const seq = clientSeq;
    clientSeq += 1;
    const encoded = await encodeMsg(serviceName, methodName, bodyBytes, seq);
    if (callback) pendingCallbacks.set(seq, callback);
    try {
        ws.send(encoded);
    } catch (err: any) {
        if (callback) {
            pendingCallbacks.delete(seq);
            callback(err);
        }
        return false;
    }
    return true;
}

/** Promise 版发送 */
function sendMsgAsync(serviceName: string, methodName: string, bodyBytes: Buffer, timeout = 20000): Promise<{ body: Buffer; meta: any }> {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error(`连接未打开: ${methodName}`));
            return;
        }

        if (pendingCallbacks.size >= 5) {
            reject(new Error(`请求队列已满: ${methodName} (pending=${pendingCallbacks.size})`));
            return;
        }

        const seq = clientSeq;
        const timeoutKey = `request_timeout_${seq}`;
        networkScheduler.setTimeoutTask(timeoutKey, timeout, () => {
            pendingCallbacks.delete(seq);
            const pending = pendingCallbacks.size;
            reject(new Error(`请求超时: ${methodName} (seq=${seq}, pending=${pending})`));
        });

        const sent = sendMsg(serviceName, methodName, bodyBytes, (err, body, meta) => {
            networkScheduler.clear(timeoutKey);
            if (err) reject(err);
            else resolve({ body: body!, meta });
        });

        if (!sent) {
            networkScheduler.clear(timeoutKey);
            reject(new Error(`发送失败: ${methodName}`));
        }
    });
}

// ============ 消息处理 ============
function handleMessage(data: Buffer): void {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const cb = pendingCallbacks.get(clientSeqVal);
            if (cb) {
                pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    cb(new Error(`${meta.service_name}.${meta.method_name} 错误: code=${errorCode} ${meta.error_message || ''}`));
                } else {
                    cb(null, msg.body, meta);
                }
                return;
            }

            if (errorCode !== 0) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }
        }
    } catch (err: any) {
        logWarn('解码', err.message);
    }
}

function handleNotify(msg: any): void {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        const eventBody = event.body;

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = types.KickoutNotify.decode(eventBody);
                log('推送', `原因: ${notify.reason_message || '未知'}`);
                networkEvents.emit('kickout', {
                    type,
                    reason: notify.reason_message || '未知',
                });
            } catch {}
            return;
        }

        // 土地状态变化
        if (type.includes('LandsNotify')) {
            try {
                const notify = types.LandsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = notify.lands || [];
                if (lands.length > 0) {
                    if (hostGid === userState.gid || hostGid === 0) {
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch {}
            return;
        }

        // 物品变化通知
        if (type.includes('ItemNotify')) {
            try {
                const notify = types.ItemNotify.decode(eventBody);
                const items = notify.items || [];
                for (const itemChg of items) {
                    const item = itemChg.item;
                    if (!item) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);

                    if (id === 1101) {
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        if (count > 0) {
                            userState.gold = count;
                        } else if (delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    } else if (id === 1005) {
                        if (count > 0) {
                            userState.goldBean = count;
                        } else if (delta !== 0) {
                            userState.goldBean = Math.max(0, Number(userState.goldBean || 0) + delta);
                        }
                    }
                }
            } catch {}
            return;
        }

        // 基本信息变化
        if (type.includes('BasicNotify')) {
            try {
                const notify = types.BasicNotify.decode(eventBody);
                if (notify.basic) {
                    const oldLevel = userState.level;
                    if (hasOwn(notify.basic, 'level')) {
                        const nextLevel = toNum(notify.basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(notify.basic, 'gold')) {
                        const nextGold = toNum(notify.basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(notify.basic, 'exp')) {
                        const exp = toNum(notify.basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch {}
            return;
        }

        // 好友申请通知
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                const applications = notify.applications || [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch {}
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = types.FriendAddedNotify.decode(eventBody);
                const friends = notify.friends || [];
                if (friends.length > 0) {
                    const names = friends.map((f: any) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                }
            } catch {}
            return;
        }

        // 商品解锁通知
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = types.GoodsUnlockNotify.decode(eventBody);
                const goods = notify.goods_list || [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch {}
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = types.TaskInfoNotify.decode(eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info);
                }
            } catch {}
            return;
        }

        // VIP信息更新通知
        if (type.includes('VipInfoUpdatedNTF')) {
            try {
                const notify = types.VipInfoUpdatedNTF.decode(eventBody);
                networkEvents.emit('vipInfoUpdated', notify);
            } catch {}
            return;
        }

        // 商城需求通知
        if (type.includes('NeedNotify')) {
            try {
                const notify = types.NeedNotify.decode(eventBody);
                networkEvents.emit('mallNeedNotify', notify);
            } catch {}
            return;
        }

        // 商品变更通知
        if (type.includes('ProductsHasChangedNotify')) {
            try {
                const notify = types.ProductsHasChangedNotify.decode(eventBody);
                networkEvents.emit('productsChanged', notify);
            } catch {}
            return;
        }

        // 活动变更通知
        if (type.includes('ActiviesChangeNotify')) {
            try {
                const notify = types.ActiviesChangeNotify.decode(eventBody);
                networkEvents.emit('activitiesChanged', notify);
            } catch {}
            return;
        }

        // 头像框红点通知
        if (type.includes('AvatarFrameRedDotNotify')) {
            try {
                networkEvents.emit('avatarFrameRedDot');
            } catch {}
            return;
        }

        // 图鉴奖励红点通知
        if (type.includes('IllustratedRewardRedDotNotifyV2')) {
            try {
                networkEvents.emit('illustratedRewardRedDot');
            } catch {}
            return;
        }

        // 充值信息变更通知
        if (type.includes('RechargeInfoNotify')) {
            try {
                const notify = types.RechargeInfoNotify.decode(eventBody);
                networkEvents.emit('rechargeInfoChanged', notify);
            } catch {}
            return;
        }
    } catch (e: any) {
        logWarn('推送', `解码失败: ${e.message}`);
    }
}

// ============ 登录 ============
async function sendLogin(onLoginSuccess?: () => void): Promise<void> {
    const di = CONFIG.deviceInfo || {};
    const body = types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: {
            client_version: di.clientVersion || CONFIG.clientVersion,
            sys_software: di.sysSoftware || 'iOS 26.2.1',
            network: di.network || 'wifi',
            memory: di.memory || '7672',
            device_id: di.deviceId || 'iPhone X<iPhone18,3>',
        },
        share_cfg_id: toLong(0),
        scene_id: '1256',
        report_data: {
            callback: '', cd_extend_info: '', click_id: '', clue_token: '',
            minigame_channel: 'other', minigame_platid: 2, req_id: '', trackid: '',
        },
    })).finish();

    await sendMsg('gamepb.userpb.UserService', 'Login', body, (err, bodyBytes, _meta) => {
        if (err) {
            log('登录', `失败: ${err.message}`);
            if (err.message.includes('code=')) {
                log('系统', '账号验证失败，即将停止运行...');
                networkScheduler.setTimeoutTask('login_error_exit', 1000, () => process.exit(0));
            }
            return;
        }
        try {
            const reply = types.LoginReply.decode(bodyBytes!);
            if (reply.basic) {
                clearWsErrorState();
                userState.gid = toNum(reply.basic.gid);
                userState.name = reply.basic.name || '未知';
                userState.level = toNum(reply.basic.level);
                userState.gold = toNum(reply.basic.gold);
                userState.exp = toNum(reply.basic.exp);

                updateStatusFromLogin({
                    name: userState.name,
                    level: userState.level,
                    gold: userState.gold,
                    exp: userState.exp,
                });

                log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);

                console.warn('');
                console.warn('========== 登录成功 ==========');
                console.warn(`  GID:    ${userState.gid}`);
                console.warn(`  昵称:   ${userState.name}`);
                console.warn(`  等级:   ${userState.level}`);
                console.warn(`  金币:   ${userState.gold}`);
                if (reply.time_now_millis) {
                    syncServerTime(toNum(reply.time_now_millis));
                    console.warn(`  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`);
                }
                console.warn('===============================');
                console.warn('');

                fetchGoldBeanFromBag();
                fetchUserSettings();
                startAntiDataLoop();
            }

            startHeartbeat();
            if (onLoginSuccess) onLoginSuccess();
        } catch (e: any) {
            log('登录', `解码失败: ${e.message}`);
        }
    });
}

// ============ 心跳 ============
let lastHeartbeatResponse = Date.now();
let heartbeatMissCount = 0;
const HEARTBEAT_TIMEOUT = 30000;
const MAX_HEARTBEAT_MISS = 1;

function startHeartbeat(): void {
    networkScheduler.clear('heartbeat_interval');
    lastHeartbeatResponse = Date.now();
    heartbeatMissCount = 0;

    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, () => {
        if (!userState.gid) return;

        const timeSinceLastResponse = Date.now() - lastHeartbeatResponse;
        if (timeSinceLastResponse > HEARTBEAT_TIMEOUT) {
            heartbeatMissCount++;
            logWarn('心跳', `连接可能已断开 (${Math.round(timeSinceLastResponse / 1000)}s 无响应, pending=${pendingCallbacks.size})`);
            if (heartbeatMissCount >= MAX_HEARTBEAT_MISS) {
                log('心跳', '心跳超时，立即重连...');
                rejectAllPendingRequests('连接超时，已清理');
                reconnect(null);
                return;
            }
        }

        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(userState.gid),
            client_version: CONFIG.clientVersion,
        })).finish();
        sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', body).then(({ body: replyBody }) => {
            lastHeartbeatResponse = Date.now();
            heartbeatMissCount = 0;
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                if (reply.server_time) syncServerTime(toNum(reply.server_time));
            } catch {}
        }).catch(() => {});
    });
}

// ============ WebSocket 连接 ============
let savedLoginCallback: (() => void) | null = null;
let savedCode: string | null = null;

function connect(code: string | null, onLoginSuccess?: () => void): void {
    savedLoginCallback = onLoginSuccess || null;
    if (code) savedCode = code;
    const url = `${CONFIG.serverUrl}?platform=${CONFIG.platform}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${savedCode}&openID=`;

    const di = CONFIG.deviceInfo || {};
    ws = new WebSocket(url, {
        headers: {
            'User-Agent': di.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
            'Origin': 'https://gate-obt.nqf.qq.com',
        },
    });

    ws.binaryType = 'arraybuffer';

    (ws as any).on('open', () => {
        sendLogin(onLoginSuccess);
    });

    (ws as any).on('message', (data: any, _isBinary: any) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        handleMessage(buf);
    });

    (ws as any).on('close', (code: any, _reason: any) => {
        console.warn(`[WS] 连接关闭 (code=${code})`);
        cleanup();
        if (savedLoginCallback) {
            networkScheduler.setTimeoutTask('auto_reconnect', 2000, () => {
                log('系统', '[WS] 尝试自动重连...');
                reconnect(null);
            });
        }
    });

    (ws as any).on('error', (err: any) => {
        const message = err && err.message ? String(err.message) : '';
        logWarn('系统', `[WS] 错误: ${message}`);
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const code = Number.parseInt(match[1], 10) || 0;
            if (code) {
                setWsErrorState(code, message);
                networkEvents.emit('ws_error', { code, message });
            }
        }
    });
}

function cleanup(reason = '网络清理'): void {
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    stopAntiDataLoop();
}

function reconnect(newCode: string | null): void {
    cleanup('主动重连');
    if (ws) {
        (ws as any).removeAllListeners();
        ws.close();
        ws = null;
    }
    userState.gid = 0;
    connect(newCode || savedCode, savedLoginCallback || undefined);
}

function getWs(): WebSocket | null { return ws; }

module.exports = {
    connect, reconnect, cleanup, getWs,
    sendMsgAsync,
    getUserState,
    getWsErrorState,
    networkEvents,
};
