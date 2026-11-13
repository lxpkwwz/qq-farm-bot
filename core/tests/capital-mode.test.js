/**
 * 宠物资本模式状态机。
 *
 * 这个模块是「按作物成熟时间自动派狗 — 收获后召回 — 120 秒兜底召回」的中枢，
 * 状态只有 4 个（idle / deploying / deployed / withdrawing），但两个定时器 +
 * 异步网络调用叠在一起，一旦某个分支没把 phase 收回 idle，就会**永久卡死**：
 * 之后所有务农操作都不会再自动派狗，而且日志里什么都不会出现。
 *
 * 之前没有测试，这次把三类不变量钉死：
 *   1. 任何失败路径都必须把 phase 收回 idle（否则只能重启进程）；
 *   2. 派狗成功必须注册 120 秒兜底召回；撤回成功必须清掉两个定时器；
 *   3. 节流窗口内不重复派狗，手动命令与配置变更要能收回自动派出的狗。
 *
 * 定时器用假 scheduler 记录、由测试手动触发，不真的等 120 秒。
 */

// 数据目录指向临时区：否则测试会通过真实 logger 往 core/data/logs 里追加日志。
require('./helpers/isolate-data');

const assert = require('node:assert/strict');
const test = require('node:test');

const { PlantPhase } = require('../dist/config/config');

// ============ 依赖注入：必须在 require 目标模块之前完成 ============

const tasks = new Map();
const petCalls = [];

let capitalConfig = { enabled: true, dogId: 7, leadSeconds: 10 };
let overviewProvider = () => ({ activeDogId: 0, dogs: [{ id: 7, name: '柴犬', owned: true }] });
let deployImpl = async () => {};
let withdrawImpl = async () => {};

require.cache[require.resolve('../dist/services/scheduler')] = {
    exports: {
        createScheduler: () => ({
            setTimeoutTask: (name, ms, fn) => {
                tasks.set(name, { ms, fn });
            },
            clear: name => {
                tasks.delete(name);
            },
            has: name => tasks.has(name),
        }),
    },
};

require.cache[require.resolve('../dist/services/pets')] = {
    exports: {
        getPetInfo: async () => overviewProvider(),
        deployDog: async (dogId) => {
            petCalls.push(`deploy:${dogId}`);
            return deployImpl(dogId);
        },
        withdrawDog: async () => {
            petCalls.push('withdraw');
            return withdrawImpl();
        },
    },
};

require.cache[require.resolve('../dist/models/store')] = {
    exports: {
        getCapitalMode: () => capitalConfig,
    },
};

const capital = require('../dist/services/capital-mode');

// ============ 工具 ============

function reset() {
    capital.releaseForManualCommand();
    capital._state.phase = 'idle';
    capital._state.autoDogId = 0;
    capital._state.lastAttemptAt = 0;
    tasks.clear();
    petCalls.length = 0;
    capitalConfig = { enabled: true, dogId: 7, leadSeconds: 10 };
    overviewProvider = () => ({ activeDogId: 0, dogs: [{ id: 7, name: '柴犬', owned: true }] });
    deployImpl = async () => {};
    withdrawImpl = async () => {};
}

function matureIn(seconds) {
    const at = Math.floor(Date.now() / 1000) + seconds;
    return { plant: { phases: [{ phase: PlantPhase.MATURE, begin_time: at }] } };
}

const OPS = { lands: [matureIn(5)], analysis: null, opType: 'harvest' };

// ============ findNearestMatureSeconds：纯计算 ============

test('已有可收获地块时直接返回 0，不再看成熟时间', () => {
    assert.equal(capital.findNearestMatureSeconds([matureIn(999)], { harvestable: [{}] }), 0);
});

test('没有地块、或成熟时间全在过去，返回 null', () => {
    assert.equal(capital.findNearestMatureSeconds([], null), null);
    assert.equal(capital.findNearestMatureSeconds([null, {}, { plant: null }], null), null);
    // 成熟时间在过去的地块不算「即将成熟」：应当没有任何候选。
    assert.equal(capital.findNearestMatureSeconds([matureIn(-60)], null), null);
});

test('多块地取最近的成熟时间，毫秒级 begin_time 会被换算成秒', () => {
    const nearest = capital.findNearestMatureSeconds([matureIn(30), matureIn(3)], null);
    assert.ok(nearest >= 1 && nearest <= 4, `最近成熟应在 3 秒附近，实际 ${nearest}`);

    const msLand = { plant: { phases: [{ phase: PlantPhase.MATURE, begin_time: (Math.floor(Date.now() / 1000) + 20) * 1000 }] } };
    const fromMs = capital.findNearestMatureSeconds([msLand], null);
    assert.ok(fromMs >= 18 && fromMs <= 22, `毫秒时间戳应换算成秒，实际 ${fromMs}`);
});

test('非成熟阶段与其他阶段混在一起时只看 MATURE', () => {
    const land = {
        plant: {
            phases: [
                { phase: PlantPhase.SEED, begin_time: Math.floor(Date.now() / 1000) + 1 },
                { phase: PlantPhase.MATURE, begin_time: Math.floor(Date.now() / 1000) + 50 },
            ],
        },
    };
    const nearest = capital.findNearestMatureSeconds([land], null);
    assert.ok(nearest >= 48 && nearest <= 52, `应只认 MATURE 阶段，实际 ${nearest}`);
});

// ============ prepareForFarmOperation：派出闸门 ============

test('opType 不是 all / harvest 时完全不介入', async () => {
    reset();
    assert.equal(await capital.prepareForFarmOperation({ ...OPS, opType: 'plant' }), false);
    assert.deepEqual(petCalls, []);
});

test('配置未启用或 dogId 为 0 时不派狗', async () => {
    reset();
    capitalConfig = { enabled: false, dogId: 7, leadSeconds: 10 };
    assert.equal(await capital.prepareForFarmOperation(OPS), false);

    reset();
    capitalConfig = { enabled: true, dogId: 0, leadSeconds: 10 };
    assert.equal(await capital.prepareForFarmOperation(OPS), false);
    assert.deepEqual(petCalls, []);
});

test('最近成熟时间超出 leadSeconds 时不派狗', async () => {
    reset();
    const far = [{ plant: { phases: [{ phase: PlantPhase.MATURE, begin_time: Math.floor(Date.now() / 1000) + 600 }] } }];
    assert.equal(await capital.prepareForFarmOperation({ lands: far, analysis: null, opType: 'all' }), false);
    assert.deepEqual(petCalls, []);
});

test('已经有宠物在场时不抢占，phase 必须收回 idle', async () => {
    reset();
    overviewProvider = () => ({ activeDogId: 99, dogs: [{ id: 7, name: '柴犬', owned: true }] });
    assert.equal(await capital.prepareForFarmOperation(OPS), false);
    assert.equal(capital._state.phase, 'idle', '被别人占了也要回 idle，否则再也不派狗');
    assert.deepEqual(petCalls, []);
});

test('配置的狗没有拥有时不派，phase 必须收回 idle', async () => {
    reset();
    overviewProvider = () => ({ activeDogId: 0, dogs: [{ id: 7, name: '柴犬', owned: false }] });
    assert.equal(await capital.prepareForFarmOperation(OPS), false);
    assert.equal(capital._state.phase, 'idle');
    assert.deepEqual(petCalls, []);
});

test('派出成功：记录归属、注册 120 秒兜底召回', async () => {
    reset();
    assert.equal(await capital.prepareForFarmOperation(OPS), true);
    assert.deepEqual(petCalls, ['deploy:7']);
    assert.equal(capital._state.phase, 'deployed');
    assert.equal(capital._state.autoDogId, 7);
    assert.equal(tasks.get('withdraw_safety')?.ms, 120000, '必须有 120 秒安全召回兜底');
});

test('deployDog 抛错时不留下 deploying 状态，5 秒节流后可重试', async () => {
    reset();
    deployImpl = async () => {
        throw new Error('网关超时');
    };
    assert.equal(await capital.prepareForFarmOperation(OPS), false);
    assert.equal(capital._state.phase, 'idle', '失败必须回 idle，否则永久卡在 deploying');
    assert.equal(capital._state.autoDogId, 0);
    assert.equal(tasks.has('withdraw_safety'), false, '没派成功就不该有召回定时器');

    // 节流窗口内仍应拒绝，避免失败时疯狂重试。
    deployImpl = async () => {};
    assert.equal(await capital.prepareForFarmOperation(OPS), false, '5 秒内不应重复尝试');
});

test('派出之后 5 秒内的重复调用被节流，不会派第二只', async () => {
    reset();
    assert.equal(await capital.prepareForFarmOperation(OPS), true);
    // 第二次调用时 phase 已是 deployed，直接被 phase 检查拦下。
    assert.equal(await capital.prepareForFarmOperation(OPS), false);
    assert.equal(petCalls.filter(call => call.startsWith('deploy')).length, 1);
});

// ============ 安全召回定时器 ============

test('120 秒兜底召回：仍在场就撤回，并清空状态与定时器', async () => {
    reset();
    await capital.prepareForFarmOperation(OPS);
    overviewProvider = () => ({ activeDogId: 7, dogs: [] });

    await tasks.get('withdraw_safety').fn();

    assert.deepEqual(petCalls, ['deploy:7', 'withdraw']);
    assert.equal(capital._state.phase, 'idle');
    assert.equal(capital._state.autoDogId, 0);
    assert.equal(tasks.size, 0, '召回后两个定时器都要清掉');
});

test('120 秒兜底召回：狗已被换走时不误撤别人的狗', async () => {
    reset();
    await capital.prepareForFarmOperation(OPS);
    overviewProvider = () => ({ activeDogId: 42, dogs: [] });

    await tasks.get('withdraw_safety').fn();

    assert.deepEqual(petCalls, ['deploy:7'], 'activeDogId 不是自己派的那只就不撤');
    assert.equal(capital._state.phase, 'idle');
    assert.equal(tasks.size, 0);
});

test('兜底召回自身失败时也必须清空状态，否则永久卡在 withdrawing', async () => {
    reset();
    await capital.prepareForFarmOperation(OPS);
    overviewProvider = () => {
        throw new Error('网关断开');
    };

    await tasks.get('withdraw_safety').fn();

    assert.equal(capital._state.phase, 'idle', '召回失败也要回 idle');
    assert.equal(capital._state.autoDogId, 0);
    assert.equal(tasks.size, 0);
});

// ============ 收获后召回 ============

test('没有自动派出的狗时，收获事件不注册任何定时器', () => {
    reset();
    capital.handleFarmHarvested();
    assert.equal(tasks.size, 0);
});

test('收获后 5 秒召回，并在确认是自己的狗之后才撤', async () => {
    reset();
    await capital.prepareForFarmOperation(OPS);
    overviewProvider = () => ({ activeDogId: 7, dogs: [] });

    capital.handleFarmHarvested();
    assert.equal(tasks.get('withdraw_after_harvest')?.ms, 5000);

    await tasks.get('withdraw_after_harvest').fn();

    assert.deepEqual(petCalls, ['deploy:7', 'withdraw']);
    assert.equal(capital._state.phase, 'idle');
    assert.equal(tasks.size, 0, '收获后召回要把兜底定时器一起清掉');
});

// ============ 配置变更与手动命令 ============

test('配置没有变化（仍启用 + 同一条狗）时不动自动派出的狗', async () => {
    reset();
    await capital.prepareForFarmOperation(OPS);
    petCalls.length = 0;

    await capital.reconcileConfigChange({ enabled: true, dogId: 7 }, { enabled: true, dogId: 7 });

    assert.deepEqual(petCalls, [], '配置没变不该产生任何宠物请求');
    assert.equal(capital._state.autoDogId, 7, '归属要保留，否则后续召回失效');
});

test('关闭资本模式或换狗时，收回自动派出的狗并清空归属', async () => {
    reset();
    await capital.prepareForFarmOperation(OPS);
    petCalls.length = 0;
    overviewProvider = () => ({ activeDogId: 7, dogs: [] });

    await capital.reconcileConfigChange({ enabled: true, dogId: 7 }, { enabled: true, dogId: 8 });

    assert.deepEqual(petCalls, ['withdraw']);
    assert.equal(capital._state.autoDogId, 0);
    assert.equal(tasks.size, 0);
});

test('没有自动派出的狗时，配置变更直接返回，不查宠物信息', async () => {
    reset();
    let called = false;
    overviewProvider = () => {
        called = true;
        return { activeDogId: 0, dogs: [] };
    };

    await capital.reconcileConfigChange({ enabled: true, dogId: 7 }, { enabled: false, dogId: 0 });

    assert.equal(called, false);
});

test('手动命令会释放所有权：之后不会再自动召回这只狗', async () => {
    reset();
    await capital.prepareForFarmOperation(OPS);
    assert.equal(tasks.size, 1);

    capital.releaseForManualCommand();

    assert.equal(capital._state.phase, 'idle');
    assert.equal(capital._state.autoDogId, 0);
    assert.equal(tasks.size, 0, '手动接管后不能再留着自动召回');

    capital.handleFarmHarvested();
    assert.equal(tasks.size, 0, '所有权已释放，收获事件不应再注册召回');
});
