import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function config(ctx) {
  try {
    return JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
  } catch (error) {
    // 文件不存在 = 首次安装、没配 token，按插件既有约定保持本地免鉴权。
    // 但「文件在、却读不出 / JSON 损坏」不能再静默当成 {}：那会让 /miniapp、
    // /logout 这些 NoAuth 路由在本该有 token 时全部敞开，授权 Code 可被任意取走。
    if (error?.code === 'ENOENT') return {};
    console.error('[qq-miniapp-openauth] 配置文件不可读，插件路由将拒绝服务：', error?.message || error);
    return { __configError: String(error?.message || error) };
  }
}
function safe(value, seen = new WeakSet(), depth = 0) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (depth > 8 || typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safe(item, seen, depth + 1));
  return Object.fromEntries(Object.keys(value).slice(0, 100).map(key => {
    try { return [key, safe(value[key], seen, depth + 1)]; } catch { return [key, '[unreadable]']; }
  }));
}
function misc(ctx) { return ctx?.core?.context?.session?.getNodeMiscService?.(); }
function selfProfile(ctx) {
  const info = ctx?.core?.selfInfo || ctx?.core?.context?.selfInfo || ctx?.selfInfo || {};
  return {
    uin: String(info.uin || info.user_id || info.qq || '').trim(),
    nickname: String(info.nickname || info.nickName || info.nick || info.name || '').trim(),
  };
}
function loginService(ctx) {
  return ctx?.core?.context?.session?.getLoginService?.()
    || ctx?.core?.context?.wrapper?.NodeIKernelLoginService?.get?.()
    || ctx?.core?.wrapper?.NodeIKernelLoginService?.get?.();
}
function offlineArg(ctx, service) {
  const core = ctx?.core;
  const info = core?.selfInfo || {};
  const basic = core?.context?.basicInfoWrapper;
  const platform = process.platform === 'darwin' ? 4 : process.platform === 'linux' ? 5 : 3;
  const read = (fn, fallback = '') => {
    try { return fn() ?? fallback; } catch { return fallback; }
  };
  const accountPath = String(read(() => core.dataPath));
  const clientVer = String(read(() => basic?.getFullQQVersion?.()));
  const appid = String(read(() => basic?.QQVersionAppid));
  const platformName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return {
    selfUin: String(info.uin || info.user_id || info.qq || ''),
    selfUid: String(info.uid || info.userUid || ''),
    desktopPathConfig: { account_path: accountPath },
    clientVer,
    a2: '', d2: '', d2Key: '', machineId: '', platform, platVer: platformName, appid,
    rdeliveryConfig: { appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform, language: '', sdkVersion: '', userId: '', appVersion: '', osVersion: '', bundleId: '', serverUrl: '', fixedAfterHitKeys: [''] },
    defaultFileDownloadPath: path.join(accountPath, 'NapCat', 'temp'),
    deviceInfo: { guid: String(read(() => service?.getMachineGuid?.())), buildVer: clientVer, localId: 2052, devName: os.hostname(), devType: platformName, vendorName: '', osVer: platformName, vendorOsName: platformName, vendorType: 0, setMute: false },
    deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
  };
}
function extractCode(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const direct = String(value.code || value.authorizationCode || value.authCode || '').trim();
  return direct || extractCode(value.result) || extractCode(value.data);
}
function codeFrom(operation, value) {
  const err = Number(value?.errCode ?? value?.errorCode ?? value?.result?.errCode ?? 0);
  if (err !== 0) return '';
  return extractCode(operation === 'loginWithAppId' ? value?.result : value);
}
function authorized(req, res, token) {
  if (!token || req.headers.authorization === `Bearer ${token}`) return true;
  res.status(401).json({ ok: false, error: 'Unauthorized' });
  return false;
}

export async function plugin_init(ctx) {
  const loaded = config(ctx);
  const token = String(loaded.token || '');
  const configError = String(loaded.__configError || '');
  // 配置损坏时宁可 503，也不能退回「无 token = 免鉴权」。
  const guard = (req, res) => {
    if (configError) {
      res.status(503).json({ ok: false, error: 'plugin config unreadable' });
      return false;
    }
    return authorized(req, res, token);
  };
  ctx.router.getNoAuth('/status', async (req, res) => {
    if (!guard(req, res)) return;
    const service = misc(ctx);
    res.json({ ok: true, ready: Boolean(service), ...selfProfile(ctx), methods: ['checkSessionForMiniApp', 'loginWithAppId', 'getOpenCodeWithAppId', 'getOpenAuth'].filter(name => typeof service?.[name] === 'function') });
  });
  ctx.router.postNoAuth('/miniapp', async (req, res) => {
    if (!guard(req, res)) return;
    const appId = String(req.body?.appId || '');
    if (!/^\d{6,20}$/.test(appId)) return res.status(400).json({ ok: false, error: 'Invalid appId' });
    const service = misc(ctx);
    if (!service) return res.status(503).json({ ok: false, error: 'QQ NodeMiscService is not ready' });
    const attempts = [];
    // 顺序有讲究：`getOpenAuth` 必须排第一。
    //   1. 它是 NapCat 4.18.x / QQ 9.9.37 上唯一确认存在的入口
    //      （NodeIKernelNodeMiscService 的接口声明里只有它，其余三个名字在当前版本上不存在）；
    //   2. 它的第一个参数传 true 表示「要新的 Code」，而 `checkSessionForMiniApp`
    //      语义是查已有会话，很可能返回上一轮已经被 worker 消费掉的旧 Code —— 那种
    //      Code 写进账号后连接会被网关拒绝，要等下一轮才能自愈。
    // 后三个是更早版本 NapCat 的命名，保留为兜底，但不再优先。
    for (const operation of ['getOpenAuth', 'checkSessionForMiniApp', 'loginWithAppId', 'getOpenCodeWithAppId']) {
      if (typeof service[operation] !== 'function') continue;
      try {
        const value = operation === 'getOpenAuth' ? await service[operation](true, appId) : await service[operation](appId);
        const code = codeFrom(operation, value);
        attempts.push({ operation, result: safe(value) });
        if (code) return res.json({ ok: true, operation, code, ...selfProfile(ctx) });
      } catch (error) { attempts.push({ operation, error: error?.message || String(error) }); }
    }
    res.status(502).json({ ok: false, error: 'QQNT OpenAuth methods returned no authorization code', attempts });
  });
  ctx.router.postNoAuth('/logout', async (req, res) => {
    if (!guard(req, res)) return;
    const service = loginService(ctx);
    try {
      for (const method of ['offline', 'logout', 'logOut', 'signOut']) {
        if (typeof service?.[method] === 'function') {
          const result = await service[method]();
          return res.json({ ok: true, loggedOut: true, method, result: safe(result) });
        }
      }
      const session = ctx?.core?.context?.session;
      for (const method of ['offLine', 'offLineSync']) {
        if (typeof session?.[method] === 'function') {
          const result = await session[method](offlineArg(ctx, service));
          return res.json({ ok: true, loggedOut: true, method, result: safe(result) });
        }
      }
      res.status(503).json({ ok: false, error: 'NapCat logout method is unavailable' });
    } catch (error) { res.status(500).json({ ok: false, error: error?.message || String(error) }); }
  });
}

export async function plugin_cleanup() {}
