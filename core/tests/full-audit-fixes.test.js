const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => readFileSync(path.join(root, file), 'utf8');

test('worker.onSellGain 只认 count，不再用 gold || sellInfo 回落成对象', () => {
    const src = read('src/core/worker.ts');
    // 旧写法：Number(sellInfo && sellInfo.gold || sellInfo || 0) 在 gold===0 时会 Number(对象)=NaN 并提前 return。
    assert.doesNotMatch(src, /sellInfo\.gold \|\| sellInfo/);
    assert.match(src, /typeof sellInfo === 'object' \? sellInfo\.count : 0/);
});

test('scheduler.setIntervalTask 的 finally 做代际校验，旧 runner 不改写新 entry', () => {
    const src = read('src/services/scheduler.ts');
    assert.match(src, /if \(updated === entry\)/);
    assert.match(src, /updated\.running = false;/);
});

test('planting.runFertilizerByConfig 返回值包含 2×2 催熟计数', () => {
    const src = read('src/services/farm/planting.ts');
    assert.match(src, /normal: fertilizedNormal \+ size2NormalCount/);
    assert.match(src, /organic: fertilizedOrganic \+ size2OrganicCount/);
    // 旧的「只有 multi_season && none 才返回 size2」分支必须删掉，否则典型组合下丢失返回值。
    assert.doesNotMatch(src, /return \{ normal: size2NormalCount, organic: size2OrganicCount \};/);
});

test('hasRemainingSeasons 只按 currentSeason < totalSeason 判断', () => {
    const src = read('src/services/farm/land-analysis.ts');
    assert.doesNotMatch(src, /currentSeason > 1 \|\|/);
    assert.match(src, /return currentSeason < totalSeason;/);
});

test('图鉴自动化 lastRunDate 仅在真正完成后标记', () => {
    const src = read('src/services/illustrated-auto.ts');
    assert.match(src, /if \(completed\) lastRunDate = today;/);
});

test('/api/automation 对空/非法请求体做守卫，不再 500', () => {
    const src = read('src/controllers/admin/farm-routes.ts');
    assert.match(src, /const entries = Object\.entries\(body\);/);
    assert.match(src, /缺少要更新的配置项/);
});

test('登录后附属初始化都有兜底，避免抛错被当成登录失败掐断连接', () => {
    const src = read('src/core/worker.ts');
    assert.match(src, /登录后统计初始化失败/);
    assert.match(src, /登录后邀请码处理失败/);
    assert.match(src, /登录后状态同步失败/);
    assert.match(src, /启动序列执行失败/);
});
