const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

// isActivityOpen 的 endTime 与同文件 buildActivityWindowGate / rescheduleActivityEventTimers
// 一样按服务器时间折算，不能拿本地 Date.now() 比，否则本机/服务器时钟一偏就判错开关边界。
test('静态锁：isActivityOpen 用服务器时间判 endTime，不混用本地 Date.now()', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/activity-automation.ts'), 'utf8');
    const start = src.indexOf('function isActivityOpen(');
    assert.ok(start > 0, '找不到 isActivityOpen');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    assert.doesNotMatch(body, /Math\.floor\(Date\.now\(\) \/ 1000\)/, '不能用本地时钟');
    assert.match(body, /getServerTimeSec\(\)/, '必须按服务器时间折算');
});
