export {};
import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Farm-related routes: status, automation, fertilizer, lands, seeds, bag,
 * daily-gifts, accounts start/stop, farm operate, analytics, plant-blacklist.
 */

const { getLevelExpProgress } = require('../../config/gameConfig');
const store = require('../../models/store');

const {
    createAuthRequired,
    getAccId,
    checkAccountAccess,
    handleApiError,
    resolveAccId,
} = require('./middleware');

function mountFarmRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);

    // API: 完整状态
    app.get('/api/status', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = ctx.provider.getStatus(id);
            if (data && data.status) {
                const { level, exp } = data.status;
                const progress = getLevelExpProgress(level, exp);
                data.levelProgress = progress;
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.post('/api/automation', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            let lastData = null;
            for (const [k, v] of Object.entries(req.body)) {
                lastData = await ctx.provider.setAutomation(id, k, v);
            }
            res.json({ ok: true, data: lastData || {} });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/fertilizer/buy', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const type = String(req.body?.type || 'organic');
            const count = Number(req.body?.count) || 0;
            const bought = await ctx.provider.buyFertilizer(id, type, count);
            res.json({ ok: true, bought });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 检测化肥容器并自动购买
    app.post('/api/fertilizer/check-and-buy', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const buyOrganic = req.body?.buyOrganic ?? false;
            const buyNormal = req.body?.buyNormal ?? false;
            const organicCount = Number(req.body?.organicCount) || 0;
            const organicThresholdHours = Number(req.body?.organicThresholdHours) || 0;
            const normalCount = Number(req.body?.normalCount) || 0;
            const normalThresholdHours = Number(req.body?.normalThresholdHours) || 0;

            const result = await ctx.provider.checkAndBuyFertilizer(id, {
                buyOrganic,
                buyNormal,
                organicCount,
                organicThresholdHours,
                normalCount,
                normalThresholdHours,
            });
            res.json({ ok: true, ...result });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农田详情
    app.get('/api/lands', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await ctx.provider.getLands(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 蔬菜黑名单
    app.get('/api/plant-blacklist', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(ctx, req as any, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const list = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: list });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/plant-blacklist', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(ctx, req as any, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const seedId = Number((req.body || {}).seedId);
            if (!seedId) return res.status(400).json({ ok: false, error: 'Missing seedId' });

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];

            if (!current.includes(seedId)) {
                const next = [...current, seedId];
                if (store.setPlantBlacklist) {
                    store.setPlantBlacklist(accountId, next);
                }
            }

            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/plant-blacklist/:seedId', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(ctx, req as any, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const seedId = Number(req.params.seedId);
            if (!seedId) return res.status(400).json({ ok: false, error: 'Missing seedId' });

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            const next = current.filter((id: number) => id !== seedId);

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, next);
            }

            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 批量添加蔬菜黑名单
    app.post('/api/plant-blacklist/batch', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(ctx, req as any, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const seedIds = (req.body || {}).seedIds || [];
            if (!Array.isArray(seedIds)) {
                return res.status(400).json({ ok: false, error: 'seedIds must be an array' });
            }

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            const merged = [...new Set([...current, ...seedIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)])];

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, merged);
            }

            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 清空蔬菜黑名单
    app.delete('/api/plant-blacklist', authRequired, (req: Request, res: Response) => {
        try {
            const accountId = getAccId(ctx, req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(ctx, req as any, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, []);
            }

            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(accountId);
            }

            res.json({ ok: true, data: [] });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 种子列表
    app.get('/api/seeds', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await ctx.provider.getSeeds(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 背包物品
    app.get('/api/bag', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await ctx.provider.getBag(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 使用背包物品
    app.post('/api/bag/use', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { itemId, count } = req.body;
            if (!itemId) return res.status(400).json({ ok: false, error: '缺少 itemId' });
            const data = await ctx.provider.useItem(id, Number(itemId), Math.max(1, Number(count) || 1));
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 出售背包物品
    app.post('/api/bag/sell', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { items } = req.body;
            if (!Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ ok: false, error: '缺少出售物品列表' });
            }
            const data = await ctx.provider.sellItems(id, items);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取背包种子列表
    app.get('/api/bag/seeds', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await ctx.provider.getBagSeeds(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await ctx.provider.getDailyGifts(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 启动账号
    app.post('/api/accounts/:id/start', (req: Request, res: Response) => {
        try {
            const accountId = resolveAccId(ctx, req.params.id);

            // 检查权限
            if (!checkAccountAccess(ctx, req as any, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const ok = ctx.provider.startAccount(accountId);
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 停止账号
    app.post('/api/accounts/:id/stop', (req: Request, res: Response) => {
        try {
            const accountId = resolveAccId(ctx, req.params.id);

            // 检查权限
            if (!checkAccountAccess(ctx, req as any, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const ok = ctx.provider.stopAccount(accountId);
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农场一键操作
    app.post('/api/farm/operate', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { opType } = req.body; // 'harvest', 'clear', 'plant', 'all'
            await ctx.provider.doFarmOp(id, opType);
            res.json({ ok: true });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 数据分析
    app.get('/api/analytics', async (req: Request, res: Response) => {
        try {
            const sortBy = req.query.sort || 'exp';
            const { getPlantRankings } = require('../../services/analytics');
            const data = getPlantRankings(sortBy);
            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 种子录入
    const seedImageDir = path.join(__dirname, '../../gameConfig/seed_images_named');
    const seedImageUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 2 * 1024 * 1024 },
        fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
            const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
            const ext = path.extname(file.originalname).toLowerCase();
            if (allowed.includes(ext)) {
                cb(null, true);
            } else {
                cb(new Error('仅支持 png, jpg, webp 格式图片'));
            }
        },
    });

    app.post('/api/seed', seedImageUpload.single('image'), async (req: Request, res: Response) => {
        try {
            const body = req.body;

            // 验证必填字段
            const seedId = Number(body.seed_id);
            const name = String(body.name || '').trim();
            const growPhases = String(body.grow_phases || '').trim();
            const landLevelNeed = Number(body.land_level_need);
            const seasons = Number(body.seasons) || 1;
            const fruitCount = Number(body.fruit_count) || 0;
            const price = Number(body.price) || 0;

            if (!seedId || seedId <= 0) {
                return res.status(400).json({ ok: false, error: '种子ID必须为正整数' });
            }
            if (!name) {
                return res.status(400).json({ ok: false, error: '作物名称不能为空' });
            }
            if (!growPhases) {
                return res.status(400).json({ ok: false, error: '生长阶段不能为空' });
            }
            if (!landLevelNeed || landLevelNeed <= 0) {
                return res.status(400).json({ ok: false, error: '等级要求必须为正整数' });
            }
            if (![1, 2].includes(seasons)) {
                return res.status(400).json({ ok: false, error: '季节数必须为1或2' });
            }
            if (fruitCount <= 0) {
                return res.status(400).json({ ok: false, error: '收获数量必须为正整数' });
            }
            if (price < 0) {
                return res.status(400).json({ ok: false, error: '种子价格不能为负数' });
            }

            // 检查种子ID是否已存在
            const { getPlantBySeedId, loadConfigs: reloadConfigs } = require('../../config/gameConfig');
            const existing = getPlantBySeedId(seedId);
            if (existing) {
                return res.status(400).json({ ok: false, error: `种子ID ${seedId} 已存在（${existing.name}）` });
            }

            // 根据 seedId 生成关联 ID
            // plantId = 1000000 + seedId (如 seedId=21135 → plantId=1021135)
            // fruitId = 40000 + seedId (如 seedId=21135 → fruitId=41135)
            // seedItemId = seedId 本身
            const configDir = path.join(__dirname, '../../gameConfig');
            const plantPath = path.join(configDir, 'Plant.json');
            const itemInfoPath = path.join(configDir, 'ItemInfo.json');

            const plantData: any[] = JSON.parse(fs.readFileSync(plantPath, 'utf8'));
            const itemData: any[] = JSON.parse(fs.readFileSync(itemInfoPath, 'utf8'));

            const newPlantId = 1000000 + seedId;
            const newFruitId = 20000 + seedId;

            // 读取选填字段
            const exp = Number(body.exp) || 0;
            const size = Number(body.size) || 0;
            // 资源自动生成: Crop_{seedId}
            const assetName = `Crop_${seedId}`;

            // 构建 Plant.json 条目
            const plantEntry = {
                id: newPlantId,
                name,
                mutant: '',
                fruit: {
                    id: newFruitId,
                    count: fruitCount,
                },
                seed_id: seedId,
                land_level_need: landLevelNeed,
                seasons,
                grow_phases: growPhases,
                exp,
                size,
                offsetPosition: { x: 0, y: 0 },
                mutantEffectScale: { x: 1, y: 1 },
                harvestOffsetPosition: { x: -35, y: 40 },
                harvestRandom: false,
                harvestAllSpineRes: '',
                harvestAllOffsetPosition: '',
                all_state_spine: '',
                mature_effect: 'effect/prefab/effect_plant_maturation',
                mature_effect_offset: { x: 0, y: 0 },
                rare_plant_light_pos: '',
                exp_root: 0,
                exp_alter: 0,
                fruit_root: 0,
                fruit_alter: 0,
            };

            // 构建 ItemInfo.json 种子条目
            const seedItemEntry = {
                id: seedId,
                type: 5,
                name: `${name}种子`,
                interaction_type: 'plant',
                price_id: 0,
                price,
                level: landLevelNeed,
                target_id: 0,
                asset_name: assetName || `Crop_${seedId}`,
                icon_res: '',
                max_count: 9999,
                max_own: 9999,
                can_use: 0,
                desc: `种植后，可以收获一定数量的${name}。`,
                effectDesc: name,
                trait_id: 0,
                layer: 13,
                rarity: 1,
                rarity_color: 'D2C5AC',
                jumps: '',
                ware_scale: null,
            };

            // 构建 ItemInfo.json 果实条目
            const fruitItemEntry = {
                id: newFruitId,
                type: 6,
                name,
                interaction_type: '',
                price_id: 0,
                price: Math.round(price * 0.25),
                level: landLevelNeed,
                target_id: 0,
                asset_name: assetName || `Crop_${seedId}`,
                icon_res: '',
                max_count: 999,
                max_own: 999,
                can_use: 0,
                desc: `${name}的果实，可以出售换取金币。`,
                effectDesc: name,
                trait_id: 0,
                layer: 0,
                rarity: 1,
                rarity_color: 'D2C5AC',
                jumps: '',
                ware_scale: null,
            };

            // 写入数据
            plantData.push(plantEntry);
            itemData.push(seedItemEntry);
            itemData.push(fruitItemEntry);

            fs.writeFileSync(plantPath, JSON.stringify(plantData, null, 4), 'utf8');
            fs.writeFileSync(itemInfoPath, JSON.stringify(itemData, null, 4), 'utf8');

            // 处理图片上传：直接写入最终文件（覆盖已有文件）
            if (req.file && req.file.buffer) {
                if (!fs.existsSync(seedImageDir)) {
                    fs.mkdirSync(seedImageDir, { recursive: true });
                }
                const finalPath = path.join(seedImageDir, `${assetName}_Seed.png`);
                fs.writeFileSync(finalPath, req.file.buffer);
            }

            // 重新加载配置
            if (typeof reloadConfigs === 'function') {
                reloadConfigs();
            }

            // 通知 worker 进程刷新游戏配置
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({
                ok: true,
                data: {
                    plantId: newPlantId,
                    seedId,
                    fruitId: newFruitId,
                    name,
                },
            });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
}

module.exports = { mountFarmRoutes };
