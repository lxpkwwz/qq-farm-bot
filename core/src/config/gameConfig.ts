export {};
/**
 * 游戏配置数据模块
 * 从 gameConfig 目录加载配置数据
 */

const fs = require('node:fs');
const path = require('node:path');
const { getResourcePath } = require('./runtime-paths');

interface RoleLevelItem {
    level: number;
    exp: number;
}

interface PlantFruit {
    id: number;
    count?: number;
}

interface PlantItem {
    id: number;
    name: string;
    seed_id: number;
    fruit?: PlantFruit;
    land_level_need?: number;
    grow_phases?: string;
    exp?: number;
    seasons?: number;
    size?: number;
}

interface ItemInfo {
    id: number;
    type?: number;
    price?: number;
    asset_name?: string;
    [key: string]: any;
}

interface SeedInfo {
    seedId: number;
    name: string;
    requiredLevel: number;
    price: number;
    image: string;
    seasons: number;
    exp: number;
    growPhases: string;
    growTime: number;
    size: number;
    harvestCount: number;
}

// ============ 等级经验表 ============
let roleLevelConfig: RoleLevelItem[] | null = null;
let levelExpTable: number[] | null = null;

// ============ 植物配置 ============
let plantConfig: PlantItem[] | null = null;
const plantMap = new Map<number, PlantItem>();
const seedToPlant = new Map<number, PlantItem>();
const fruitToPlant = new Map<number, PlantItem>();
let itemInfoConfig: ItemInfo[] | null = null;
const itemInfoMap = new Map<number, ItemInfo>();
const seedItemMap = new Map<number, ItemInfo>();

/**
 * 加载配置文件
 */
function loadConfigs(): void {
    const configDir = getResourcePath('gameConfig');

    // 加载等级经验配置
    try {
        const roleLevelPath = path.join(configDir, 'RoleLevel.json');
        if (fs.existsSync(roleLevelPath)) {
            roleLevelConfig = JSON.parse(fs.readFileSync(roleLevelPath, 'utf8'));
            levelExpTable = [];
            for (const item of roleLevelConfig!) {
                levelExpTable[item.level] = item.exp;
            }
            console.warn(`[配置] 已加载等级经验表 (${roleLevelConfig!.length} 级)`);
        }
    } catch (e: any) {
        console.warn('[配置] 加载 RoleLevel.json 失败:', e.message);
    }

    // 加载植物配置
    try {
        const plantPath = path.join(configDir, 'Plant.json');
        if (fs.existsSync(plantPath)) {
            plantConfig = JSON.parse(fs.readFileSync(plantPath, 'utf8'));
            plantMap.clear();
            seedToPlant.clear();
            fruitToPlant.clear();
            for (const plant of plantConfig!) {
                plantMap.set(plant.id, plant);
                if (plant.seed_id) {
                    seedToPlant.set(plant.seed_id, plant);
                }
                if (plant.fruit && plant.fruit.id) {
                    fruitToPlant.set(plant.fruit.id, plant);
                }
            }
            console.warn(`[配置] 已加载植物配置 (${plantConfig!.length} 种)`);
        }
    } catch (e: any) {
        console.warn('[配置] 加载 Plant.json 失败:', e.message);
    }

    // 加载物品配置（含种子/果实价格）
    try {
        const itemInfoPath = path.join(configDir, 'ItemInfo.json');
        if (fs.existsSync(itemInfoPath)) {
            itemInfoConfig = JSON.parse(fs.readFileSync(itemInfoPath, 'utf8'));
            itemInfoMap.clear();
            seedItemMap.clear();
            for (const item of itemInfoConfig!) {
                const id = Number(item && item.id) || 0;
                if (id <= 0) continue;
                itemInfoMap.set(id, item);
                if (Number(item.type) === 5) {
                    seedItemMap.set(id, item);
                }
            }
            console.warn(`[配置] 已加载物品配置 (${itemInfoConfig!.length} 项)`);
        }
    } catch (e: any) {
        console.warn('[配置] 加载 ItemInfo.json 失败:', e.message);
    }

}

// ============ 等级经验相关 ============

function getLevelExpTable(): number[] | null {
    return levelExpTable;
}

function getLevelExpProgress(level: number, totalExp: number): { current: number; needed: number } {
    if (!levelExpTable || level <= 0) return { current: 0, needed: 0 };

    const currentLevelStart = levelExpTable[level] || 0;
    const nextLevelStart = levelExpTable[level + 1] || (currentLevelStart + 100000);

    const currentExp = Math.max(0, totalExp - currentLevelStart);
    const neededExp = nextLevelStart - currentLevelStart;

    return { current: currentExp, needed: neededExp };
}

// ============ 植物配置相关 ============

function getPlantById(plantId: number): PlantItem | undefined {
    return plantMap.get(plantId);
}

function getPlantBySeedId(seedId: number): PlantItem | undefined {
    return seedToPlant.get(seedId);
}

function getPlantName(plantId: number): string {
    const plant = plantMap.get(plantId);
    return plant ? plant.name : `植物${plantId}`;
}

function getPlantNameBySeedId(seedId: number): string {
    const plant = seedToPlant.get(seedId);
    return plant ? plant.name : `种子${seedId}`;
}

function getPlantGrowTime(plantId: number): number {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.grow_phases) return 0;

    const phases = plant.grow_phases.split(';').filter(p => p);
    let totalSeconds = 0;
    for (const phase of phases) {
        const match = phase.match(/:(\d+)/);
        if (match) {
            totalSeconds += Number.parseInt(match[1]);
        }
    }
    return totalSeconds;
}

function formatGrowTime(seconds: number): string {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}

function getPlantExp(plantId: number): number {
    const plant = plantMap.get(plantId);
    return plant ? (plant.exp || 0) : 0;
}

function getFruitName(fruitId: number): string {
    const plant = fruitToPlant.get(fruitId);
    return plant ? plant.name : `果实${fruitId}`;
}

function getPlantByFruitId(fruitId: number): PlantItem | undefined {
    return fruitToPlant.get(fruitId);
}

function getAllSeeds(): SeedInfo[] {
    return Array.from(seedToPlant.values()).map(p => ({
        seedId: p.seed_id,
        name: p.name,
        requiredLevel: (() => { const si = seedItemMap.get(p.seed_id); return si ? (Number(si.level) || 0) : (Number(p.land_level_need) || 0); })(),
        price: getSeedPrice(p.seed_id),
        image: getSeedImageBySeedId(p.seed_id),
        seasons: Number(p.seasons) || 1,
        exp: Number(p.exp) || 0,
        growPhases: p.grow_phases || '',
        growTime: getPlantGrowTime(p.id),
        size: Number(p.size) || 0,
        harvestCount: Number(p.fruit?.count) || 0,
    }));
}

function getMappedSeedImage(targetId: number): string {
    const id = Number(targetId) || 0;
    if (id <= 0) return '';
    return `/game-config/seed_images_named/${id}.png`;
}

function getSeedImageBySeedId(seedId: number): string {
    return getMappedSeedImage(seedId);
}

function getItemImageById(itemId: number): string {
    const id = Number(itemId) || 0;
    if (id <= 0) return '';

    // 直接按ID返回
    return `/game-config/seed_images_named/${id}.png`;
}

function getItemById(itemId: number): ItemInfo | undefined {
    return itemInfoMap.get(Number(itemId) || 0);
}

function getSeedPrice(seedId: number): number {
    const item = seedItemMap.get(Number(seedId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getFruitPrice(fruitId: number): number {
    const item = itemInfoMap.get(Number(fruitId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getAllPlants(): PlantItem[] {
    return Array.from(plantMap.values());
}

// ============ 配置管理查询 ============

function getAllFruits(): ItemInfo[] {
    return Array.from(itemInfoMap.values()).filter(item => Number(item.type) === 6);
}

function getAllItems(): ItemInfo[] {
    // 返回所有非种子(type=5)、非果实(type=6)的道具
    return Array.from(itemInfoMap.values()).filter(item => {
        const t = Number(item.type);
        return t !== 5 && t !== 6;
    });
}

function getItemsByType(type: number): ItemInfo[] {
    return Array.from(itemInfoMap.values()).filter(item => Number(item.type) === type);
}

function getItemInfoMap(): Map<number, ItemInfo> {
    return itemInfoMap;
}

function getPlantMap(): Map<number, PlantItem> {
    return plantMap;
}

// 启动时加载配置
loadConfigs();

module.exports = {
    loadConfigs,
    getAllPlants,
    getAllSeeds,
    // 等级经验
    getLevelExpTable,
    getLevelExpProgress,
    // 植物配置
    getPlantById,
    getPlantBySeedId,
    getPlantName,
    getPlantNameBySeedId,
    getPlantGrowTime,
    getPlantExp,
    formatGrowTime,
    // 果实配置
    getFruitName,
    getPlantByFruitId,
    getItemById,
    getItemImageById,
    getSeedPrice,
    getFruitPrice,
    getSeedImageBySeedId,
    // 配置管理查询
    getAllFruits,
    getAllItems,
    getItemsByType,
    getItemInfoMap,
    getPlantMap,
};
