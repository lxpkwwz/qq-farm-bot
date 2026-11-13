export {};
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const security = require('./auth-security');
const { writeJsonFileAtomic } = require('../services/json-db');

const ADMIN_FILE: string = getDataFile('admin.json');

interface AdminRecord {
    username: string;
    password: string;
    createdAt: number;
    mustChangePassword?: boolean;
}

let admin: AdminRecord | null = null;

function normalizeAdmin(raw: any): AdminRecord | null {
    if (!raw || typeof raw !== 'object' || !String(raw.password || '').trim()) return null;
    return {
        username: String(raw.username || 'admin').trim() || 'admin',
        password: String(raw.password),
        createdAt: Number(raw.createdAt) || Date.now(),
        mustChangePassword: raw.mustChangePassword === true || undefined,
    };
}

/**
 * 先写盘、成功后才换内存。
 *
 * 原来是 `current.password = hash; saveAdmin()`：写盘抛错时接口返回 500，但模块级
 * admin 的口令已经在内存里变了，且调用方拿不到 ok 结果、不会清旧 token。原子写
 * 还避免半截文件在重启后被当成损坏文件、重建出公开的 admin/admin 默认口令。
 */
function persistAdmin(next: AdminRecord): void {
    ensureDataDir();
    writeJsonFileAtomic(ADMIN_FILE, { admin: next });
    admin = next;
}

function saveAdmin(): void {
    if (!admin) return;
    persistAdmin(admin);
}

function loadAdmin(): AdminRecord {
    ensureDataDir();
    if (admin) return admin;
    let fileMissing = false;
    let corruptReason = '';
    try {
        if (fs.existsSync(ADMIN_FILE)) {
            const data = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
            admin = normalizeAdmin(data?.admin || data);
            if (!admin) corruptReason = 'JSON 结构里没有有效的 password 字段';
        } else {
            fileMissing = true;
        }
    } catch (e: any) {
        corruptReason = String((e && e.message) || e);
        admin = null;
    }
    if (!admin && corruptReason) {
        // 损坏文件不能默默当成「首次安装」，那会把管理员口令重置成公开的 admin/admin。
        // 留档一份便于人工恢复，并打印醒目告警（默认账号仍带 mustChangePassword）。
        try {
            fs.copyFileSync(ADMIN_FILE, `${ADMIN_FILE}.corrupt-${Date.now()}`);
        } catch {
            // 只读卷下留档失败不阻止启动
        }
        console.error(`[管理员] admin.json 损坏（${corruptReason}），已留档；临时启用默认账号，请立即修改密码`);
    }
    if (!admin) {
        admin = {
            username: 'admin',
            password: security.hashPassword('admin'),
            createdAt: Date.now(),
            mustChangePassword: true,
        };
        saveAdmin();
        if (fileMissing) console.log('[管理员] 已创建默认账号 admin，默认密码 admin');
    }
    return admin;
}

function getAdminInfo(): { username: string; role: 'admin'; mustChangePassword: boolean } {
    const current = loadAdmin();
    return { username: current.username, role: 'admin', mustChangePassword: current.mustChangePassword === true };
}

function validateAdmin(username: string, password: string, ip: string = 'unknown'): any {
    security.loadLoginAttempts();
    const rateLimit = security.checkRateLimit(ip);
    if (!rateLimit.allowed) return { error: 'rate_limit', ...rateLimit };
    const lockout = security.checkAdminLockout();
    if (lockout.locked) return { error: 'locked', ...lockout };

    const current = loadAdmin();
    if (username !== current.username || !security.verifyPassword(password, current.password)) {
        const attempt = security.recordFailedAttempt();
        return attempt.locked
            ? { error: 'locked', message: attempt.message }
            : { error: 'invalid_credentials', message: `用户名或密码错误，剩余尝试次数: ${attempt.remainingAttempts}` };
    }

    security.clearFailedAttempts();
    if (security.needsRehash(current.password)) {
        persistAdmin({ ...current, password: security.hashPassword(password) });
    }
    return getAdminInfo();
}

function changePassword(oldPassword: string, newPassword: string): { ok: boolean; error?: string; message?: string } {
    const current = loadAdmin();
    if (!security.verifyPassword(oldPassword, current.password)) return { ok: false, error: '当前密码错误' };
    const validation = security.validatePasswordStrength(newPassword);
    if (!validation.valid) return { ok: false, error: validation.errors.join('；') };
    persistAdmin({
        username: current.username,
        password: security.hashPassword(newPassword),
        createdAt: current.createdAt,
        mustChangePassword: undefined,
    });
    return { ok: true, message: '密码修改成功' };
}

loadAdmin();

module.exports = { getAdminInfo, validateAdmin, changePassword };
