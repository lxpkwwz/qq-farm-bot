export {};
interface DeviceInfo {
    os: string;
    clientVersion: string;
    sysSoftware: string;
    network: string;
    memory: string;
    deviceId: string;
    userAgent: string;
}

interface DevicePreset {
    id: string;
    name: string;
    description: string;
    deviceInfo: DeviceInfo;
}

interface SystemConfig {
    serverUrl: string;
    clientVersion: string;
    platform: string;
    os: string;
    deviceInfo: DeviceInfo;
}

interface RuntimeConfig extends SystemConfig {
    heartbeatInterval: number;
    farmCheckInterval: number;
    friendCheckInterval: number;
    farmCheckIntervalMin: number;
    farmCheckIntervalMax: number;
    friendCheckIntervalMin: number;
    friendCheckIntervalMax: number;
    adminPort: number;
    adminPassword: string | undefined;
}

// ============ 设备预设 ============

// clientVersion 从 CONFIG.clientVersion 动态获取，不写死在预设中
const DEFAULT_CLIENT_VERSION = '1.11.6.23_20260601';

const DEVICE_PRESETS: DevicePreset[] = [
    {
        id: 'windows_pc',
        name: 'Windows PC',
        description: 'Windows 微信PC客户端',
        deviceInfo: {
            os: 'Windows',
            clientVersion: '',
            sysSoftware: 'Windows 10',
            network: 'wifi',
            memory: '16384',
            deviceId: 'DESKTOP-PC<WPC>',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
        },
    },
    {
        id: 'iphone_15_pro',
        name: 'iPhone 15 Pro',
        description: 'iPhone 15 Pro (iOS 17)',
        deviceInfo: {
            os: 'iOS',
            clientVersion: '',
            sysSoftware: 'iOS 17.4.1',
            network: 'wifi',
            memory: '7672',
            deviceId: 'iPhone15,2',
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47(0x18002f2c) NetType/WIFI Language/zh_CN',
        },
    },
    {
        id: 'iphone_16_pro',
        name: 'iPhone 16 Pro',
        description: 'iPhone 16 Pro (iOS 18)',
        deviceInfo: {
            os: 'iOS',
            clientVersion: '',
            sysSoftware: 'iOS 18.2.1',
            network: 'wifi',
            memory: '8192',
            deviceId: 'iPhone17,1',
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22C161 MicroMessenger/8.0.54(0x1800362c) NetType/WIFI Language/zh_CN',
        },
    },
    {
        id: 'android_xiaomi',
        name: '小米手机',
        description: '小米/Redmi (Android 14)',
        deviceInfo: {
            os: 'Android',
            clientVersion: '',
            sysSoftware: 'Android 14',
            network: 'wifi',
            memory: '8192',
            deviceId: 'Xiaomi 14',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.231003.002) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1165009 MMWEBSDK/20240407 MiniProgramEnv/android MicroMessenger/8.0.49.2680(0x28003137) NetType/WIFI Language/zh_CN ABI/arm64',
        },
    },
    {
        id: 'android_huawei',
        name: '华为手机',
        description: '华为 (Android 14)',
        deviceInfo: {
            os: 'Android',
            clientVersion: '',
            sysSoftware: 'Android 14',
            network: 'wifi',
            memory: '12288',
            deviceId: 'HUAWEI Mate 60',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; ALN-AL10 Build/HUAWEIALN-AL10) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1165009 MMWEBSDK/20240407 MiniProgramEnv/android MicroMessenger/8.0.49.2680(0x28003137) NetType/WIFI Language/zh_CN ABI/arm64',
        },
    },
    {
        id: 'ipad_pro',
        name: 'iPad Pro',
        description: 'iPad Pro 12.9 (iPadOS 17)',
        deviceInfo: {
            os: 'iOS',
            clientVersion: '',
            sysSoftware: 'iPadOS 17.4',
            network: 'wifi',
            memory: '16384',
            deviceId: 'iPad14,6',
            userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47(0x18002f2c) NetType/WIFI Language/zh_CN',
        },
    },
];

const DEFAULT_DEVICE_INFO: DeviceInfo = { ...DEVICE_PRESETS[0].deviceInfo, clientVersion: DEFAULT_CLIENT_VERSION };

const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
    serverUrl: 'wss://gate-obt.nqf.qq.com/prod/ws',
    clientVersion: DEFAULT_CLIENT_VERSION,
    platform: 'qq',
    os: DEFAULT_DEVICE_INFO.os,
    deviceInfo: { ...DEFAULT_DEVICE_INFO },
};

const CONFIG: RuntimeConfig = {
    serverUrl: DEFAULT_SYSTEM_CONFIG.serverUrl,
    clientVersion: DEFAULT_CLIENT_VERSION,
    platform: DEFAULT_SYSTEM_CONFIG.platform,
    os: DEFAULT_SYSTEM_CONFIG.os,
    deviceInfo: { ...DEFAULT_DEVICE_INFO },
    heartbeatInterval: 25000,
    farmCheckInterval: 3000,
    friendCheckInterval: 12000,
    farmCheckIntervalMin: 3000,
    farmCheckIntervalMax: 5000,
    friendCheckIntervalMin: 12000,
    friendCheckIntervalMax: 15000,
    adminPort: Number(process.env.ADMIN_PORT),
    adminPassword: process.env.ADMIN_PASSWORD,
};

function normalizeDeviceInfo(input: any): DeviceInfo {
    const src = (input && typeof input === 'object') ? input : {};
    return {
        os: String(src.os || DEFAULT_DEVICE_INFO.os).trim(),
        clientVersion: String(src.clientVersion || CONFIG.clientVersion || DEFAULT_CLIENT_VERSION).trim(),
        sysSoftware: String(src.sysSoftware || DEFAULT_DEVICE_INFO.sysSoftware).trim(),
        network: String(src.network || DEFAULT_DEVICE_INFO.network).trim(),
        memory: String(src.memory || DEFAULT_DEVICE_INFO.memory).trim(),
        deviceId: String(src.deviceId || DEFAULT_DEVICE_INFO.deviceId).trim(),
        userAgent: String(src.userAgent || DEFAULT_DEVICE_INFO.userAgent).trim(),
    };
}

function updateRuntimeConfig(newConfig: Partial<SystemConfig>): void {
    if (newConfig.serverUrl && typeof newConfig.serverUrl === 'string') {
        CONFIG.serverUrl = newConfig.serverUrl;
    }
    if (newConfig.clientVersion && typeof newConfig.clientVersion === 'string') {
        CONFIG.clientVersion = newConfig.clientVersion;
    }
    if (newConfig.platform && typeof newConfig.platform === 'string') {
        CONFIG.platform = newConfig.platform;
    }
    if (newConfig.os && typeof newConfig.os === 'string') {
        CONFIG.os = newConfig.os;
    }
    if (newConfig.deviceInfo) {
        CONFIG.deviceInfo = normalizeDeviceInfo(newConfig.deviceInfo);
        // 同步 os 和 clientVersion 到顶层
        CONFIG.os = CONFIG.deviceInfo.os;
        CONFIG.clientVersion = CONFIG.deviceInfo.clientVersion;
    }
}

function getRuntimeConfig(): SystemConfig {
    return {
        serverUrl: CONFIG.serverUrl,
        clientVersion: CONFIG.clientVersion,
        platform: CONFIG.platform,
        os: CONFIG.os,
        deviceInfo: { ...CONFIG.deviceInfo },
    };
}

function getDefaultSystemConfig(): SystemConfig {
    return { ...DEFAULT_SYSTEM_CONFIG, deviceInfo: { ...DEFAULT_DEVICE_INFO } };
}

function getDevicePresets(): DevicePreset[] {
    return DEVICE_PRESETS.map(p => ({
        ...p,
        deviceInfo: { ...p.deviceInfo, clientVersion: CONFIG.clientVersion },
    }));
}

// 生长阶段枚举
const PlantPhase = {
    UNKNOWN: 0,
    SEED: 1,
    GERMINATION: 2,
    SMALL_LEAVES: 3,
    LARGE_LEAVES: 4,
    BLOOMING: 5,
    MATURE: 6,
    DEAD: 7,
} as const;

const PHASE_NAMES: string[] = ['未知', '种子', '发芽', '小叶', '大叶', '开花', '成熟', '枯死'];

module.exports = {
    CONFIG,
    DEFAULT_CLIENT_VERSION,
    PlantPhase,
    PHASE_NAMES,
    updateRuntimeConfig,
    getRuntimeConfig,
    getDefaultSystemConfig,
    getDevicePresets,
    DEVICE_PRESETS,
};
