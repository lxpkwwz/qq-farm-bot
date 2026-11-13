export {};
const { createScheduler } = require('../services/scheduler');
// 账号维度的运行状态账本：面板据此显示「登录中 / 等待重登（倒计时）/ 停止中」。
// 只在这里和 wx-keepalive 写，data-provider 读。
const {
    setAccountRuntimeState,
    getAccountRuntimeState,
    clearAccountRuntimeState,
} = require('../services/account-runtime-state');

const DEFAULT_API_CALL_TIMEOUT_MS = 10000;
// 好友现场天气需要逐个 Enter/Leave，单批最多 5 位好友；
// 好友列表只读缓存或拉一次名单，给的余量少一些。
const API_CALL_TIMEOUTS_MS: Record<string, number> = {
    getPetDiary: 90000,
    operatePetDiary: 180000,
    getPetDiaryRecords: 30000,
    getPetDiaryFriend: 30000,
    scanWeatherFriends: 60000,
    getWeatherFriends: 30000,
};

/**
 * 断线来源的中文说明。账号日志直接带上这句，用户不用翻英文 source
 * 就能判断这次掉线是「服务端关的连接」还是「Code 失效/心跳静默」。
 */
const DISCONNECT_SOURCE_LABELS: Record<string, string> = {
    ws_close: '服务端关闭连接',
    ws_error: '连接被拒绝（Code 或版本不符）',
    login_failed: '登录验证失败（Code 失效）',
    login_timeout: '登录响应超时',
    login_send_failed: '登录请求发送失败',
    login_init_failed: '登录后初始化失败',
    heartbeat_timeout: '心跳超时（连接已静默）',
};

function describeDisconnectSource(source: string, code: number): string {
    const label = DISCONNECT_SOURCE_LABELS[String(source || '')] || `连接中断（${source || '未知来源'}）`;
    return code ? `${label}，关闭码 ${code}` : label;
}

interface WorkerManagerOptions {
    fork: any;
    WorkerThread: any;
    runtimeMode?: string;
    processRef: any;
    mainEntryPath: string;
    workerScriptPath: string;
    workers: Record<string, any>;
    globalLogs: any[];
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    normalizeStatusForPanel: (data: any, accountId: string, accountName: string) => any;
    buildConfigSnapshotForAccount: (accountId: string) => any;
    getOfflineAutoDeleteMs: () => number;
    triggerOfflineReminder: (payload: any) => void;
    sendConfiguredPush?: (payload: any) => Promise<void> | void;
    addOrUpdateAccount: (acc: any) => any;
    deleteAccount: (id: string) => void;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onWorkerLog?: (entry: any, accountId: string, accountName?: string) => void;
    /** 账号掉线（断开 / 被踢下线）时回调，供账号保活安排自动重登。 */
    onAccountOffline?: (accountId: string, accountName: string, reason: string) => void;
}

/**
 * 向 worker 子进程发消息，失败返回 false。
 *
 * `process.send` 在 IPC 通道已关闭时是**同步抛错**（ERR_IPC_CHANNEL_CLOSED），
 * 而不少调用点在 `child.on('message')` 的事件回调里——那里抛出去等价于
 * uncaughtException，会把主进程带走，所有账号一起掉线。子进程发不出消息只说明
 * 它已经不可用了，交给调用方按「进程已死」处理即可。
 */
function safeSend(proc: any, payload: any): boolean {
    try {
        if (!proc || typeof proc.send !== 'function') return false;
        if (proc.connected === false) return false;
        proc.send(payload);
        return true;
    }
    catch {
        return false;
    }
}

function createWorkerManager(options: WorkerManagerOptions) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount,
        deleteAccount,
        onStatusSync,
        onWorkerLog,
        onAccountOffline,
    } = options;

    function reportAccountOffline(accountId: string, accountName: string, reason: string): void {
        if (typeof onAccountOffline !== 'function') return;
        try {
            onAccountOffline(accountId, accountName, reason);
        } catch {
            // 保活回调失败不能影响账号停止流程
        }
    }
    const managerScheduler = createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !(processRef as any).pkg && typeof WorkerThread === 'function';

    function createThreadWorker(account: any): any {
        const workerOptions: any = {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
            },
        };
        // When running from source with tsx, configure worker to use tsx
        if (workerScriptPath.endsWith('.ts')) {
            workerOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        const worker = new WorkerThread(workerScriptPath, workerOptions);
        worker.send = (payload: any) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }

    function createForkWorker(account: any): any {
        if ((processRef as any).pkg) {
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || '') },
            });
        }
        const forkOptions: any = {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || '') },
        };
        if (workerScriptPath.endsWith('.ts')) {
            forkOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        return fork(workerScriptPath, [], forkOptions);
    }

    function createWorkerProcess(account: any): any {
        if (useThreadRuntime) return createThreadWorker(account);
        return createForkWorker(account);
    }

    function startWorker(account: any): boolean {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false;

        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child: any = null;
        try {
            child = createWorkerProcess(account);
        }         catch (err: any) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            // 连子进程都没建起来：不会有 exit 事件来收尾，状态必须自己落定，
            // 否则会停在「登录中」/「等待重登」这种「马上就好」的假象里。
            setAccountRuntimeState(account.id, 'offline');
            return false;
        }

        workers[account.id] = {
            process: child,
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            nick: account.nick || '',
            avatar: account.avatar || '',
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            terminalHandled: false,
            wsError: null,
        };
        // 子进程已创建但还没连上游戏服：这段时间面板要显示「登录中」，
        // 而不是跟着 `running=true` 一起显示「运行中」。
        setAccountRuntimeState(account.id, 'logging_in');

        const initialConfigSnapshot = buildConfigSnapshotForAccount(account.id);
        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
                systemTimeZone: initialConfigSnapshot.systemTimeZone,
                systemServerUrl: initialConfigSnapshot.systemServerUrl,
                systemClientVersion: initialConfigSnapshot.systemClientVersion,
                systemWxClientVersion: initialConfigSnapshot.systemWxClientVersion,
                systemDeviceInfo: initialConfigSnapshot.systemDeviceInfo,
            },
        });
        child.send({ type: 'config_sync', config: initialConfigSnapshot });

        child.on('message', (msg: any) => {
            // 消息处理里会写账号 / 好友库（落盘失败会抛 storageError），也会再往子进程
            // send。这些都在事件回调里同步执行，不兜住就是 uncaughtException ——
            // 一次磁盘写入失败会连带打死主进程，所有账号同时掉线。
            try {
                handleWorkerMessage(account.id, child, msg);
            }
            catch (error: any) {
                log('错误', `账号 ${account.name} 消息处理失败: ${error && error.message ? error.message : error}`, { accountId: String(account.id), accountName: account.name });
            }
        });

        child.on('error', (err: any) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code: number, signal: string) => {
            const current = workers[account.id];
            if (!current || current.process !== child) return;
            const displayName = current.name || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            if (current && current.process === child) {
                delete workers[account.id];
                // 只从「停止中 / 登录中 / 运行中」收尾。
                // 断开流程是「先停进程、再排重登」，进程 exit 是异步的，会在
                // notifyAccountOffline 把状态改成「等待重登」之后才到——不加
                // onlyFrom 就会把刚写好的倒计时覆盖成「已停止」，用户看不到自愈。
                //
                // 收尾成什么也有区别：用户主动停止 → 「已停止」；进程自己挂掉
                // （崩溃 / 被 OOM 杀掉）→ 「已掉线」，否则面板会把它显示成用户
                // 自己停的，实际是异常退出等人处理。
                const previous = getAccountRuntimeState(account.id);
                setAccountRuntimeState(account.id, previous && previous.state === 'stopping' ? 'stopped' : 'offline', {
                    onlyFrom: ['stopping', 'logging_in', 'running'],
                });
            }
        });
        return true;
    }

    function stopWorker(accountId: string): void {
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        // send 失败说明子进程已经不可用了。此时若不收口，force_kill 定时器根本不会
        // 注册，workers[accountId] 会残留一个死条目 —— 而 startWorker 用
        // `if (workers[account.id]) return false` 判重，账号从此再也起不来，
        // 面板上却仍显示运行中。
        if (!safeSend(proc, { type: 'stop' })) {
            try { proc.kill(); } catch { /* 进程早已退出 */ }
            delete workers[accountId];
            setAccountRuntimeState(accountId, 'stopped');
            return;
        }
        // 停止指令已送达，子进程正在退出（最多 1 秒强杀）：面板显示「停止中」，
        // 并把停止按钮置灰，避免用户在退出间隙连点。
        setAccountRuntimeState(accountId, 'stopping');
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
                // 条目已被摘掉，进程 exit 回调会因为 `workers[id]` 不存在而提前返回，
                // 这里必须自己收尾，否则面板会卡在「停止中」直到 30 秒兜底过期。
                setAccountRuntimeState(accountId, 'stopped');
            }
        });
    }

    function restartWorker(account: any): void {
        if (!account) return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) { startWorker(account); return; }
        const proc = worker.process;
        let started = false;
        const startOnce = () => {
            if (started) return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) { startWorker(account); return; }
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(account);
        };
        const killIfStale = () => {
            const current = workers[accountId];
            if (!current || current.process !== proc) return false;
            try {
                current.process.kill();
            } catch {}
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            startOnce();
            return;
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started) return;
            killIfStale();
            startOnce();
        });
    }

    function errorFromWorkerPayload(payload: any): Error & { code?: string | number; errorMessage?: string } {
        if (!payload || typeof payload !== 'object') return new Error(String(payload || 'Worker API error'));
        const error: Error & { code?: string | number; errorMessage?: string } = new Error(String(payload.message || 'Worker API error'));
        if (payload.name) error.name = String(payload.name);
        if (payload.code !== undefined && payload.code !== null && payload.code !== '') error.code = payload.code;
        const protocolMessage = payload.errorMessage ?? payload.error_message;
        if (protocolMessage !== undefined && protocolMessage !== null) error.errorMessage = String(protocolMessage);
        return error;
    }

    function handleWorkerMessage(accountId: string, sourceProcess: any, msg: any): void {
        const worker = workers[accountId];
        if (!worker || worker.process !== sourceProcess) return;

        if (msg.type === 'status_sync') {
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            const profile = msg.data && msg.data.status && typeof msg.data.status === 'object'
                ? msg.data.status
                : {};
            const accountUpdate: any = { id: accountId };
            let profileChanged = false;

            if (profile.name) {
                const newNick = String(profile.name).trim();
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        accountUpdate.nick = newNick;
                        profileChanged = true;
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            const newAvatar = String(profile.avatarUrl || profile.avatar_url || '').trim();
            if (newAvatar && worker.avatar !== newAvatar) {
                worker.avatar = newAvatar;
                accountUpdate.avatar = newAvatar;
                profileChanged = true;
            }

            if (profileChanged) {
                addOrUpdateAccount(accountUpdate);
            }

            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
                // 只有真正连上游戏服才算「运行中」。登录中的子进程同样按 10 秒
                // 周期上报状态，但 connection.connected 仍是 false，不能提前转态。
                if (!worker.stopping) setAccountRuntimeState(accountId, 'running');
            } else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs();
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                        clearAccountRuntimeState(accountId);
                    } catch (e: any) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'error') {
            const workerError = errorFromWorkerPayload(msg.error);
            log('错误', `账号[${accountId}]进程报错: ${workerError.message}`, {
                accountId: String(accountId),
                accountName: worker.name,
                errorCode: workerError.code,
                errorName: workerError.name,
            });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                addAccountLog(
                    'ws_400',
                    `账号 ${worker.name} 登录失效，请更新 Code`,
                    accountId,
                    worker.name,
                );
            }
        } else if (msg.type === 'account_kicked') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const reason = msg.reason || '未知';
            const reasonCode = Number(msg.reasonCode) || 0;
            const diagnostics = msg.diagnostics || null;
            log('系统', `账号 ${worker.name} 被踢下线（原因: ${reason}${reasonCode ? `，码 ${reasonCode}` : ''}），已自动停止账号`, { accountId: String(accountId), accountName: worker.name, reasonCode, diagnostics });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} 被踢下线（原因: ${reason}${reasonCode ? `，码 ${reasonCode}` : ''}），已自动停止`, accountId, worker.name, { reason, reasonCode, diagnostics });
            stopWorker(accountId);
            reportAccountOffline(accountId, worker.name, `kickout:${reason}`);
        } else if (msg.type === 'account_disconnected') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const source = String(msg.source || 'ws_close');
            const code = Number(msg.code) || 0;
            const reason = String(msg.reason || '连接已断开');
            const phase = String(msg.phase || 'unknown');
            if (worker.status?.connection) worker.status.connection.connected = false;
            if (worker.requests.size > 0) {
                for (const [reqId, req] of worker.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${accountId}_${reqId}`);
                    try { req.reject(new Error('账号连接已断开')); } catch {}
                }
                worker.requests.clear();
            }
            log('系统', `账号 ${worker.name} 连接已断开（${describeDisconnectSource(source, code)}），已停止运行，开启「掉线自动重登」时会自动补 Code 后重试`, {
                accountId: String(accountId),
                accountName: worker.name,
                source,
                disconnectCode: code,
                phase,
                reason,
                diagnostics: msg.diagnostics || null,
            });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `disconnect:${source}:${phase}:${code}`,
                offlineMs: 0,
            });
            addAccountLog(
                'disconnect_stop',
                `账号 ${worker.name} 连接已断开（${describeDisconnectSource(source, code)}），已停止运行，开启「掉线自动重登」时会自动补 Code 后重试`,
                accountId,
                worker.name,
                { source, disconnectCode: code, reason, phase, connectionId: Number(msg.connectionId) || 0, diagnostics: msg.diagnostics || null },
            );
            stopWorker(accountId);
            reportAccountOffline(accountId, worker.name, `disconnect:${source}:${phase}:${code}`);
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(errorFromWorkerPayload(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    safeSend(worker_process.process, { type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        } else if (msg.type === 'known_friend_gids_sync') {
            const { setKnownFriendGids } = require('../models/store');
            const gids: number[] = Array.isArray(msg.gids)
                ? msg.gids.map(Number).filter((gid: number) => Number.isFinite(gid) && gid > 0)
                : [];
            const saved: number[] = setKnownFriendGids(accountId, gids);
            safeSend(worker.process, {
                type: 'config_sync',
                config: buildConfigSnapshotForAccount(accountId),
            });
            log('好友', `已同步并持久化 ${saved.length} 个好友 GID`, {
                accountId: String(accountId),
                accountName: worker.name,
                friendCount: saved.length,
            });
        } else if (msg.type === 'push_notify') {
            const title = String(msg.title || '').trim();
            const content = String(msg.content || '').trim();
            if (!title || !content || typeof sendConfiguredPush !== 'function') return;
            Promise.resolve(sendConfiguredPush({
                title,
                content,
                accountId,
                accountName: worker.name,
            })).catch((e: any) => {
                log('错误', `事件提醒发送异常: ${e && e.message ? e.message : e}`);
            });
        } else if (msg.type === 'known_friend_gid_remove') {
            const { getKnownFriendGids, setKnownFriendGids } = require('../models/store');
            const gid: number = Number(msg.gid) || 0;
            if (gid > 0) {
                const current: number[] = getKnownFriendGids(accountId);
                setKnownFriendGids(accountId, current.filter((item: number) => Number(item) !== gid));
                safeSend(worker.process, {
                    type: 'config_sync',
                    config: buildConfigSnapshotForAccount(accountId),
                });
            }
        }
    }

    function callWorkerApi(accountId: string, method: string, ...args: any[]): Promise<any> {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));
        if (worker.stopping || worker.terminalHandled) return Promise.reject(new Error('账号已离线'));

        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });

            const timeoutMs = API_CALL_TIMEOUTS_MS[method] || DEFAULT_API_CALL_TIMEOUT_MS;
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, timeoutMs, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });

            if (!safeSend(worker.process, { type: 'api_call', id, method, args })) {
                // 子进程已经不可用：立刻失败，别让调用方白等 10~180 秒的 API 超时，
                // 也顺手把定时器摘掉，免得它继续挂在 scheduler 里。
                worker.requests.delete(id);
                managerScheduler.clear(`api_timeout_${accountId}_${id}`);
                reject(new Error('Worker exited'));
            }
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
    };
}

module.exports = {
    createWorkerManager,
};
