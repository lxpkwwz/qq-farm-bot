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

    // ============ 配置管理 API ============

    const configImageDir = path.join(__dirname, '../../gameConfig/seed_images_named');
    const configDir = path.join(__dirname, '../../gameConfig');
    const configImageUpload = multer({
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

    /**
     * GET /api/config/seeds — 种子列表
     */
    app.get('/api/config/seeds', async (req: Request, res: Response) => {
        try {
            const { getAllSeeds, getItemById } = require('../../config/gameConfig');
            const seeds = getAllSeeds();
            // 补充 priceId 字段供前端统一价格显示
            const data = seeds.map((s: any) => {
                const item = getItemById(s.seedId);
                return { ...s, priceId: item ? Number(item.price_id) || 0 : 0 };
            });
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * GET /api/config/fruits — 果实列表
     */
    app.get('/api/config/fruits', async (req: Request, res: Response) => {
        try {
            const { getAllFruits, getPlantByFruitId, getItemImageById } = require('../../config/gameConfig');
            const fruits = getAllFruits();
            const data = fruits.map((fruit: any) => {
                const plant = getPlantByFruitId(fruit.id);
                return {
                    id: fruit.id,
                    name: fruit.name,
                    type: fruit.type,
                    price: Number(fruit.price) || 0,
                    priceId: Number(fruit.price_id) || 0,
                    level: Number(fruit.level) || 0,
                    assetName: fruit.asset_name || '',
                    desc: fruit.desc || '',
                    effectDesc: fruit.effectDesc || '',
                    rarity: Number(fruit.rarity) || 0,
                    maxCount: Number(fruit.max_count) || 9999,
                    maxOwn: Number(fruit.max_own) || 9999,
                    plantId: plant ? plant.id : null,
                    seedId: plant ? plant.seed_id : null,
                    plantName: plant ? plant.name : null,
                    image: getItemImageById(fruit.id) || '',
                };
            });
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * GET /api/config/items — 道具列表（排除种子和果实）
     */
    app.get('/api/config/items', async (req: Request, res: Response) => {
        try {
            const { getAllItems, getItemsByType, getItemImageById } = require('../../config/gameConfig');
            const typeFilter = req.query.type ? Number(req.query.type) : null;
            const items = typeFilter ? getItemsByType(typeFilter) : getAllItems();
            const data = items.map((item: any) => ({
                id: item.id,
                type: item.type,
                name: item.name,
                interactionType: item.interaction_type || '',
                priceId: Number(item.price_id) || 0,
                price: Number(item.price) || 0,
                level: Number(item.level) || 0,
                assetName: item.asset_name || '',
                iconRes: item.icon_res || '',
                maxCount: Number(item.max_count) || 9999,
                maxOwn: Number(item.max_own) || 9999,
                canUse: Number(item.can_use) || 0,
                desc: item.desc || '',
                effectDesc: item.effectDesc || '',
                traitId: Number(item.trait_id) || 0,
                layer: Number(item.layer) || 0,
                rarity: Number(item.rarity) || 0,
                rarityColor: item.rarity_color || '',
                jumps: item.jumps || '',
                image: getItemImageById(item.id) || '',
            }));
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * GET /api/config/item-types — 物品类型列表（供前端下拉选择）
     */
    app.get('/api/config/item-types', async (req: Request, res: Response) => {
        try {
            const itemTypes = [
                { value: 1, label: '特殊道具' },
                { value: 2, label: '货币' },
                { value: 3, label: '经验' },
                { value: 4, label: '农场工具' },
                { value: 7, label: '化肥' },
                { value: 8, label: '宠物' },
                { value: 9, label: '宠物食品' },
                { value: 10, label: '头像框' },
                { value: 11, label: '礼品盒' },
                { value: 12, label: '收藏点' },
                { value: 13, label: '活跃点' },
                { value: 14, label: '解锁卡' },
                { value: 15, label: '高级货币' },
                { value: 16, label: '自选礼包' },
                { value: 17, label: '变异果实' },
            ];
            res.json({ ok: true, data: itemTypes });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * GET /api/config/plants — 植物列表（供果实录入时选择关联植物）
     */
    app.get('/api/config/plants', async (req: Request, res: Response) => {
        try {
            const { getAllPlants, getSeedPrice, getSeedImageBySeedId, getItemById } = require('../../config/gameConfig');
            const plants = getAllPlants();
            const data = plants.map((p: any) => ({
                plantId: p.id,
                name: p.name,
                seedId: p.seed_id,
                fruitId: p.fruit ? p.fruit.id : null,
                fruitCount: p.fruit ? p.fruit.count : 0,
                landLevelNeed: (() => { const si = getItemById(p.seed_id); return si ? Number(si.level || 0) : Number(p.land_level_need || 0); })(),
                seasons: Number(p.seasons) || 1,
                growPhases: p.grow_phases || '',
                exp: Number(p.exp) || 0,
                price: getSeedPrice(p.seed_id),
                image: getSeedImageBySeedId(p.seed_id) || '',
            }));
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * POST /api/config/fruit — 录入果实（关联已有植物）
     */
    app.post('/api/config/fruit', configImageUpload.single('image'), async (req: Request, res: Response) => {
        try {
            const body = req.body;
            const plantId = Number(body.plantId);
            const name = String(body.name || '').trim();
            const price = Number(body.price) || 0;
            const priceId = Number(body.priceId) || 0;
            const desc = String(body.desc || '').trim();
            const effectDesc = String(body.effectDesc || '').trim();
            const rarity = Number(body.rarity) || 0;
            const maxCount = Number(body.maxCount) || 9999;
            const level = Number(body.level) || 0;

            if (!plantId || plantId <= 0) {
                return res.status(400).json({ ok: false, error: '请选择关联的植物' });
            }
            if (!name) {
                return res.status(400).json({ ok: false, error: '果实名称不能为空' });
            }

            const { getPlantById, loadConfigs: reloadConfigs } = require('../../config/gameConfig');
            const plant = getPlantById(plantId);
            if (!plant) {
                return res.status(400).json({ ok: false, error: `植物ID ${plantId} 不存在` });
            }

            // 检查该植物是否已有果实
            const existingFruitId = plant.fruit && plant.fruit.id ? plant.fruit.id : null;
            const itemData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
            if (existingFruitId) {
                const existingFruit = itemData.find((item: any) => Number(item.id) === existingFruitId && Number(item.type) === 6);
                if (existingFruit) {
                    return res.status(400).json({ ok: false, error: `植物「${plant.name}」已有果实（ID: ${existingFruitId}），请勿重复录入` });
                }
            }

            // 生成果实 ID
            const fruitId = existingFruitId || (40000 + (plant.seed_id || 0));
            const assetName = String(body.assetName || '').trim() || `Crop_${plant.seed_id || plantId}`;

            // 构建果实条目
            const fruitEntry = {
                id: fruitId,
                type: 6,
                name,
                interaction_type: '',
                price_id: priceId,
                price,
                level: level || Number(plant.land_level_need) || 0,
                target_id: 0,
                asset_name: assetName,
                icon_res: '',
                max_count: maxCount,
                max_own: maxCount,
                can_use: 0,
                desc: desc || `${name}的果实，可以出售换取金币。`,
                effectDesc: effectDesc || name,
                trait_id: 0,
                layer: 0,
                rarity,
                rarity_color: rarity > 0 ? 'D2C5AC' : '',
                jumps: '',
                ware_scale: null,
            };

            // 写入 ItemInfo.json
            itemData.push(fruitEntry);
            fs.writeFileSync(path.join(configDir, 'ItemInfo.json'), JSON.stringify(itemData, null, 4), 'utf8');

            // 更新 Plant.json 的 fruit 引用
            const plantData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'Plant.json'), 'utf8'));
            const plantEntry = plantData.find((p: any) => Number(p.id) === plantId);
            if (plantEntry) {
                plantEntry.fruit = { id: fruitId, count: Number(body.fruitCount) || plantEntry.fruit?.count || 200 };
                fs.writeFileSync(path.join(configDir, 'Plant.json'), JSON.stringify(plantData, null, 4), 'utf8');
            }

            // 处理图片
            if (req.file && req.file.buffer) {
                if (!fs.existsSync(configImageDir)) {
                    fs.mkdirSync(configImageDir, { recursive: true });
                }
                const imagePath = path.join(configImageDir, `${assetName}_Seed.png`);
                fs.writeFileSync(imagePath, req.file.buffer);
            }

            // 重新加载配置
            if (typeof reloadConfigs === 'function') reloadConfigs();
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({
                ok: true,
                data: { fruitId, plantId, name, assetName },
            });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    /**
     * POST /api/config/item — 录入道具
     */
    app.post('/api/config/item', configImageUpload.single('image'), async (req: Request, res: Response) => {
        try {
            const body = req.body;
            const itemId = Number(body.id);
            const type = Number(body.type);
            const name = String(body.name || '').trim();

            if (!itemId || itemId <= 0) {
                return res.status(400).json({ ok: false, error: '物品ID必须为正整数' });
            }
            if (!type || type <= 0) {
                return res.status(400).json({ ok: false, error: '请选择物品类型' });
            }
            if (!name) {
                return res.status(400).json({ ok: false, error: '物品名称不能为空' });
            }
            if (type === 5 || type === 6) {
                return res.status(400).json({ ok: false, error: '种子(type=5)和果实(type=6)请使用对应的录入功能' });
            }

            const { getItemById, loadConfigs: reloadConfigs } = require('../../config/gameConfig');
            const existing = getItemById(itemId);
            if (existing) {
                return res.status(400).json({ ok: false, error: `物品ID ${itemId} 已存在（${existing.name}）` });
            }

            const price = Number(body.price) || 0;
            const priceId = Number(body.priceId) || 0;
            const interactionType = String(body.interactionType || '').trim();
            const canUse = Number(body.canUse) || 0;
            const desc = String(body.desc || '').trim();
            const effectDesc = String(body.effectDesc || '').trim();
            const rarity = Number(body.rarity) || 0;
            const maxCount = Number(body.maxCount) || 9999;
            const level = Number(body.level) || 0;
            const assetName = String(body.assetName || '').trim();

            const itemEntry = {
                id: itemId,
                type,
                name,
                interaction_type: interactionType,
                price_id: priceId,
                price,
                level,
                target_id: 0,
                asset_name: assetName,
                icon_res: '',
                max_count: maxCount,
                max_own: maxCount,
                can_use: canUse,
                desc,
                effectDesc: effectDesc || name,
                trait_id: 0,
                layer: 0,
                rarity,
                rarity_color: rarity > 0 ? 'D2C5AC' : '',
                jumps: '',
                ware_scale: null,
            };

            // 写入 ItemInfo.json
            const itemData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
            itemData.push(itemEntry);
            fs.writeFileSync(path.join(configDir, 'ItemInfo.json'), JSON.stringify(itemData, null, 4), 'utf8');

            // 处理图片
            if (req.file && req.file.buffer) {
                if (!fs.existsSync(configImageDir)) {
                    fs.mkdirSync(configImageDir, { recursive: true });
                }
                const imageFilename = assetName ? `${assetName}.png` : `${itemId}.png`;
                const imagePath = path.join(configImageDir, imageFilename);
                fs.writeFileSync(imagePath, req.file.buffer);
            }

            // 重新加载配置
            if (typeof reloadConfigs === 'function') reloadConfigs();
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({
                ok: true,
                data: { itemId, type, name },
            });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    /**
     * DELETE /api/config/seed/:id — 删除种子（同时删除关联的植物和果实）
     */
    app.delete('/api/config/seed/:id', async (req: Request, res: Response) => {
        try {
            const seedId = Number(req.params.id);
            if (!seedId || seedId <= 0) {
                return res.status(400).json({ ok: false, error: '无效的种子ID' });
            }

            const { getPlantBySeedId, loadConfigs: reloadConfigs } = require('../../config/gameConfig');
            const plant = getPlantBySeedId(seedId);
            if (!plant) {
                return res.status(404).json({ ok: false, error: `种子ID ${seedId} 不存在` });
            }

            const plantId = plant.id;
            const fruitId = plant.fruit ? plant.fruit.id : null;

            // 从 Plant.json 删除
            const plantData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'Plant.json'), 'utf8'));
            const newPlantData = plantData.filter((p: any) => Number(p.id) !== plantId);
            fs.writeFileSync(path.join(configDir, 'Plant.json'), JSON.stringify(newPlantData, null, 4), 'utf8');

            // 从 ItemInfo.json 删除种子(type=5)和果实(type=6)
            const itemData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
            const newItemData = itemData.filter((item: any) => {
                const id = Number(item.id);
                if (id === seedId && Number(item.type) === 5) return false;
                if (fruitId && id === fruitId && Number(item.type) === 6) return false;
                return true;
            });
            fs.writeFileSync(path.join(configDir, 'ItemInfo.json'), JSON.stringify(newItemData, null, 4), 'utf8');

            // 删除图片
            const assetName = `Crop_${seedId}`;
            const imagePath = path.join(configImageDir, `${assetName}_Seed.png`);
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

            if (typeof reloadConfigs === 'function') reloadConfigs();
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({ ok: true, data: { seedId, plantId, fruitId, name: plant.name } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    /**
     * PUT /api/config/seed/:id — 修改种子
     */
    app.put('/api/config/seed/:id', configImageUpload.single('image'), async (req: Request, res: Response) => {
        try {
            const seedId = Number(req.params.id);
            if (!seedId || seedId <= 0) {
                return res.status(400).json({ ok: false, error: '无效的种子ID' });
            }

            const { getPlantBySeedId, loadConfigs: reloadConfigs } = require('../../config/gameConfig');
            const plant = getPlantBySeedId(seedId);
            if (!plant) {
                return res.status(404).json({ ok: false, error: `种子ID ${seedId} 不存在` });
            }

            const body = req.body;

            // 更新 Plant.json
            const plantData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'Plant.json'), 'utf8'));
            const plantEntry = plantData.find((p: any) => Number(p.id) === plant.id);
            if (plantEntry) {
                if (body.name !== undefined) plantEntry.name = String(body.name).trim();
                if (body.grow_phases !== undefined) plantEntry.grow_phases = String(body.grow_phases).trim();
                if (body.land_level_need !== undefined) plantEntry.land_level_need = Number(body.land_level_need);
                if (body.seasons !== undefined) plantEntry.seasons = Number(body.seasons);
                if (body.exp !== undefined) plantEntry.exp = Number(body.exp);
                if (body.size !== undefined) plantEntry.size = Number(body.size);
                if (body.fruit_count !== undefined && plantEntry.fruit) {
                    plantEntry.fruit.count = Number(body.fruit_count);
                }
                fs.writeFileSync(path.join(configDir, 'Plant.json'), JSON.stringify(plantData, null, 4), 'utf8');
            }

            // 更新 ItemInfo.json 中的种子条目
            const itemData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
            const seedItem = itemData.find((item: any) => Number(item.id) === seedId && Number(item.type) === 5);
            if (seedItem) {
                if (body.name !== undefined) {
                    const name = String(body.name).trim();
                    seedItem.name = `${name}种子`;
                    seedItem.effectDesc = name;
                    seedItem.desc = `种植后，可以收获一定数量的${name}。`;
                }
                if (body.price !== undefined) seedItem.price = Number(body.price);
                if (body.land_level_need !== undefined) seedItem.level = Number(body.land_level_need);
            }

            // 更新果实条目名称
            const fruitId = plant.fruit ? plant.fruit.id : null;
            if (fruitId && body.name !== undefined) {
                const fruitItem = itemData.find((item: any) => Number(item.id) === fruitId && Number(item.type) === 6);
                if (fruitItem) {
                    const name = String(body.name).trim();
                    fruitItem.name = name;
                    fruitItem.effectDesc = name;
                    fruitItem.desc = `${name}的果实，可以出售换取金币。`;
                }
            }

            fs.writeFileSync(path.join(configDir, 'ItemInfo.json'), JSON.stringify(itemData, null, 4), 'utf8');

            // 处理图片上传
            if (req.file && req.file.buffer) {
                if (!fs.existsSync(configImageDir)) {
                    fs.mkdirSync(configImageDir, { recursive: true });
                }
                const finalPath = path.join(configImageDir, `Crop_${seedId}_Seed.png`);
                fs.writeFileSync(finalPath, req.file.buffer);
            }

            if (typeof reloadConfigs === 'function') reloadConfigs();
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({ ok: true, data: { seedId, name: body.name || plant.name } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    /**
     * DELETE /api/config/fruit/:id — 删除果实
     */
    app.delete('/api/config/fruit/:id', async (req: Request, res: Response) => {
        try {
            const fruitId = Number(req.params.id);
            if (!fruitId || fruitId <= 0) {
                return res.status(400).json({ ok: false, error: '无效的果实ID' });
            }

            const { getPlantByFruitId, loadConfigs: reloadConfigs } = require('../../config/gameConfig');

            // 从 ItemInfo.json 删除
            const itemData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
            const fruitItem = itemData.find((item: any) => Number(item.id) === fruitId && Number(item.type) === 6);
            if (!fruitItem) {
                return res.status(404).json({ ok: false, error: `果实ID ${fruitId} 不存在` });
            }

            const newItemData = itemData.filter((item: any) => !(Number(item.id) === fruitId && Number(item.type) === 6));
            fs.writeFileSync(path.join(configDir, 'ItemInfo.json'), JSON.stringify(newItemData, null, 4), 'utf8');

            // 清除 Plant.json 中的 fruit 引用
            const plant = getPlantByFruitId(fruitId);
            if (plant) {
                const plantData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'Plant.json'), 'utf8'));
                const plantEntry = plantData.find((p: any) => Number(p.id) === plant.id);
                if (plantEntry && plantEntry.fruit) {
                    plantEntry.fruit = { id: 0, count: 0 };
                    fs.writeFileSync(path.join(configDir, 'Plant.json'), JSON.stringify(plantData, null, 4), 'utf8');
                }
            }

            if (typeof reloadConfigs === 'function') reloadConfigs();
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({ ok: true, data: { fruitId, name: fruitItem.name } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    /**
     * PUT /api/config/fruit/:id — 修改果实
     */
    app.put('/api/config/fruit/:id', configImageUpload.single('image'), async (req: Request, res: Response) => {
        try {
            const fruitId = Number(req.params.id);
            if (!fruitId || fruitId <= 0) {
                return res.status(400).json({ ok: false, error: '无效的果实ID' });
            }

            const body = req.body;
            const itemData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
            const fruitItem = itemData.find((item: any) => Number(item.id) === fruitId && Number(item.type) === 6);
            if (!fruitItem) {
                return res.status(404).json({ ok: false, error: `果实ID ${fruitId} 不存在` });
            }

            if (body.name !== undefined) {
                const name = String(body.name).trim();
                fruitItem.name = name;
                fruitItem.effectDesc = name;
                fruitItem.desc = `${name}的果实，可以出售换取金币。`;
            }
            if (body.price !== undefined) fruitItem.price = Number(body.price);
            if (body.priceId !== undefined) fruitItem.price_id = Number(body.priceId);
            if (body.rarity !== undefined) fruitItem.rarity = Number(body.rarity);
            if (body.desc !== undefined) fruitItem.desc = String(body.desc);
            if (body.level !== undefined) fruitItem.level = Number(body.level);

            fs.writeFileSync(path.join(configDir, 'ItemInfo.json'), JSON.stringify(itemData, null, 4), 'utf8');

            // 处理图片上传
            if (req.file && req.file.buffer) {
                if (!fs.existsSync(configImageDir)) {
                    fs.mkdirSync(configImageDir, { recursive: true });
                }
                const finalPath = path.join(configImageDir, `${fruitId}_Fruit.png`);
                fs.writeFileSync(finalPath, req.file.buffer);
            }

            const { loadConfigs: reloadConfigs } = require('../../config/gameConfig');
            if (typeof reloadConfigs === 'function') reloadConfigs();
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({ ok: true, data: { fruitId, name: fruitItem.name } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    /**
     * DELETE /api/config/item/:id — 删除道具
     */
    app.delete('/api/config/item/:id', async (req: Request, res: Response) => {
        try {
            const itemId = Number(req.params.id);
            if (!itemId || itemId <= 0) {
                return res.status(400).json({ ok: false, error: '无效的物品ID' });
            }

            const { getItemById, loadConfigs: reloadConfigs } = require('../../config/gameConfig');
            const existing = getItemById(itemId);
            if (!existing) {
                return res.status(404).json({ ok: false, error: `物品ID ${itemId} 不存在` });
            }
            const itemType = Number(existing.type);
            if (itemType === 5 || itemType === 6) {
                return res.status(400).json({ ok: false, error: '种子和果实请使用对应的删除功能' });
            }

            const itemData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
            const newItemData = itemData.filter((item: any) => Number(item.id) !== itemId);
            fs.writeFileSync(path.join(configDir, 'ItemInfo.json'), JSON.stringify(newItemData, null, 4), 'utf8');

            if (typeof reloadConfigs === 'function') reloadConfigs();
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({ ok: true, data: { itemId, name: existing.name } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    /**
     * PUT /api/config/item/:id — 修改道具
     */
    app.put('/api/config/item/:id', configImageUpload.single('image'), async (req: Request, res: Response) => {
        try {
            const itemId = Number(req.params.id);
            if (!itemId || itemId <= 0) {
                return res.status(400).json({ ok: false, error: '无效的物品ID' });
            }

            const body = req.body;
            const itemData: any[] = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
            const item = itemData.find((i: any) => Number(i.id) === itemId);
            if (!item) {
                return res.status(404).json({ ok: false, error: `物品ID ${itemId} 不存在` });
            }
            const itemType = Number(item.type);
            if (itemType === 5 || itemType === 6) {
                return res.status(400).json({ ok: false, error: '种子和果实请使用对应的修改功能' });
            }

            if (body.name !== undefined) item.name = String(body.name).trim();
            if (body.price !== undefined) item.price = Number(body.price);
            if (body.priceId !== undefined) item.price_id = Number(body.priceId);
            if (body.interactionType !== undefined) item.interaction_type = String(body.interactionType);
            if (body.canUse !== undefined) item.can_use = Number(body.canUse);
            if (body.desc !== undefined) item.desc = String(body.desc);
            if (body.effectDesc !== undefined) item.effectDesc = String(body.effectDesc);
            if (body.rarity !== undefined) item.rarity = Number(body.rarity);
            if (body.maxCount !== undefined) {
                item.max_count = Number(body.maxCount);
                item.max_own = Number(body.maxCount);
            }
            if (body.level !== undefined) item.level = Number(body.level);

            fs.writeFileSync(path.join(configDir, 'ItemInfo.json'), JSON.stringify(itemData, null, 4), 'utf8');

            // 处理图片上传
            if (req.file && req.file.buffer) {
                if (!fs.existsSync(configImageDir)) {
                    fs.mkdirSync(configImageDir, { recursive: true });
                }
                const finalPath = path.join(configImageDir, `${itemId}_Item.png`);
                fs.writeFileSync(finalPath, req.file.buffer);
            }

            const { loadConfigs: reloadConfigs } = require('../../config/gameConfig');
            if (typeof reloadConfigs === 'function') reloadConfigs();
            if (ctx.provider && typeof ctx.provider.broadcastGameConfigReload === 'function') {
                ctx.provider.broadcastGameConfigReload();
            }

            res.json({ ok: true, data: { itemId, name: item.name } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
}

module.exports = { mountFarmRoutes };
