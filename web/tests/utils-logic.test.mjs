/**
 * 前端纯逻辑模块的行为测试。
 *
 * 前端原来只有「读源码做静态断言」这一种测试，等于只验证「代码长这样」，
 * 不验证「跑起来算得对不对」。这里用仓库自带的 typescript 把 .ts 转译后动态 import，
 * 不依赖 Node 版本（`--experimental-strip-types` 只在 Node 22.6+ 才有），
 * 也不用引入 vitest 之类的额外依赖。
 *
 * 覆盖四个模块：数字缩写、化肥时间换算、互动道具可用性判定、一键催熟的步进状态机。
 * 后两个是决策表 / 状态机，出错会直接让用户点到不该点的按钮。
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')

/** 把 .ts 就地转译成 ESM，再用 data: URL 导入（不落地临时文件，也不需要额外 loader）。 */
async function loadTs(relativePath) {
  const file = path.join(SRC, relativePath)
  const source = fs.readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      // 只做语法层面的类型擦除，不做类型检查（类型检查由 vue-tsc 负责）
      isolatedModules: true,
    },
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}

const numberFormat = await loadTs('utils/number-format.ts')
const fertilizerTime = await loadTs('utils/fertilizer-time.ts')
const interactionRules = await loadTs('utils/interaction-item-rules.ts')
const ripenAll = await loadTs('utils/ripen-all.ts')

// ============ 数字缩写 ============

test('一万以下用千分位原样显示', () => {
  assert.equal(numberFormat.formatGoldAmount(0), '0')
  assert.equal(numberFormat.formatGoldAmount(999), '999')
  assert.equal(numberFormat.formatGoldAmount(9999), '9,999')
})

test('一万起用「万」，一亿起用「亿」，都保留两位小数', () => {
  assert.equal(numberFormat.formatGoldAmount(10000), '1.00万')
  assert.equal(numberFormat.formatGoldAmount(12345), '1.23万')
  // 99,999,999 四舍五入到两位小数正好是 10000.00 万，必须进位成「亿」而不是显示 10000.00万
  assert.equal(numberFormat.formatGoldAmount(99999999), '1.00亿')
  // 9999.9998 万也会进位，结果同样是 1.00 亿
  assert.equal(numberFormat.formatGoldAmount(99999998), '1.00亿')
  // 但 9999.99 万没到进位线，仍按「万」显示
  assert.equal(numberFormat.formatGoldAmount(99999900), '9999.99万')
  assert.equal(numberFormat.formatGoldAmount(100000000), '1.00亿')
  assert.equal(numberFormat.formatGoldAmount(150000000), '1.50亿')
})

test('负数按绝对值判断单位，符号保留', () => {
  assert.equal(numberFormat.formatGoldAmount(-12345), '-1.23万')
  assert.equal(numberFormat.formatGoldAmount(-999), '-999')
  assert.equal(numberFormat.formatGoldAmount(-150000000), '-1.50亿')
})

test('非有限值与非法文本一律显示 0，不出现 NaN / Infinity', () => {
  for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, 'abc', null, undefined, {}, []]) {
    assert.equal(numberFormat.formatGoldAmount(value), '0', `${String(value)} 应显示 0`)
  }
})

test('数字字符串按数字处理', () => {
  assert.equal(numberFormat.formatGoldAmount('20000'), '2.00万')
})

test('三个资产格式化函数共用同一套规则', () => {
  for (const format of [numberFormat.formatGoldAmount, numberFormat.formatCouponAmount, numberFormat.formatGoldBeanAmount]) {
    assert.equal(format(12345), '1.23万')
  }
})

// ============ 化肥时间换算 ============

test('单位换算系数固定：秒 1 / 分钟 60 / 小时 3600', () => {
  assert.equal(fertilizerTime.fertilizerTimeFactor('seconds'), 1)
  assert.equal(fertilizerTime.fertilizerTimeFactor('minutes'), 60)
  assert.equal(fertilizerTime.fertilizerTimeFactor('hours'), 3600)
  assert.equal(fertilizerTime.fertilizerTimeFactor('bogus'), 1, '未知单位按秒处理，不能返回 0 导致除零')
})

test('输入值换算成秒：负数与非法值归零，结果取整', () => {
  assert.equal(fertilizerTime.fertilizerTimeSeconds(1, 'hours'), 3600)
  assert.equal(fertilizerTime.fertilizerTimeSeconds(1.5, 'minutes'), 90)
  assert.equal(fertilizerTime.fertilizerTimeSeconds(0, 'hours'), 0)
  assert.equal(fertilizerTime.fertilizerTimeSeconds(-5, 'hours'), 0)
  assert.equal(fertilizerTime.fertilizerTimeSeconds(Number.POSITIVE_INFINITY, 'hours'), 0)
  assert.equal(fertilizerTime.fertilizerTimeSeconds(Number.NaN, 'hours'), 0)
  assert.equal(fertilizerTime.fertilizerTimeSeconds('abc', 'hours'), 0)
})

test('秒换算成展示值：保留两位小数', () => {
  assert.equal(fertilizerTime.fertilizerTimeValue(3600, 'hours'), 1)
  assert.equal(fertilizerTime.fertilizerTimeValue(5400, 'hours'), 1.5)
  assert.equal(fertilizerTime.fertilizerTimeValue(90, 'minutes'), 1.5)
  assert.equal(fertilizerTime.fertilizerTimeValue(Number.POSITIVE_INFINITY, 'hours'), 0)
  assert.equal(fertilizerTime.fertilizerTimeValue(Number.NaN, 'hours'), 0)
})

// ============ 互动道具可用性 ============

function land(overrides = {}) {
  return {
    unlocked: true,
    occupiedByMaster: false,
    plantName: '萝卜',
    status: 'growing',
    phaseName: '大叶子',
    rarity: 1,
    plantSize: 1,
    mutantConfigIds: [],
    interactionEffects: [],
    ...overrides,
  }
}

test('地块本身不可用时一律拒绝', () => {
  assert.equal(interactionRules.interactionItemTargetReason('5003', land({ unlocked: false })), '不可用')
  assert.equal(interactionRules.interactionItemTargetReason('5003', land({ occupiedByMaster: true })), '不可用')
  assert.equal(interactionRules.interactionItemTargetReason('5003', land({ plantName: '   ' })), '不可用')
  assert.equal(interactionRules.interactionItemTargetReason('5003', null), '不可用', '空地块不能抛错')
})

test('地块状态：枯萎单独提示，其他不可用状态统一提示', () => {
  assert.equal(interactionRules.interactionItemTargetReason('5003', land({ status: 'locked' })), '不可用')
  assert.equal(interactionRules.interactionItemTargetReason('5003', land({ status: 'empty' })), '不可用')
  assert.equal(interactionRules.interactionItemTargetReason('5003', land({ status: 'dead' })), '枯萎不可用')
})

test('可收获 / 可偷 / 已收获 都算成熟不可用', () => {
  for (const status of ['harvestable', 'stealable', 'harvested']) {
    assert.equal(interactionRules.interactionItemTargetReason('5003', land({ status })), '成熟不可用')
  }
})

test('道具效果已存在时不再重复提示可用', () => {
  assert.equal(
    interactionRules.interactionItemTargetReason('5003', land({ interactionEffects: [{ itemId: '5003' }] })),
    '已生效',
  )
  // 别的道具生效不影响本道具
  assert.equal(
    interactionRules.interactionItemTargetReason('5003', land({ interactionEffects: [{ itemId: '5001' }] })),
    '',
  )
})

test('5003 / 5004 在种子阶段与天工作物上都不可用', () => {
  for (const itemId of ['5003', '5004']) {
    assert.equal(interactionRules.interactionItemTargetReason(itemId, land({ phaseName: '种子期' })), '种子不可用')
    assert.equal(interactionRules.interactionItemTargetReason(itemId, land({ rarity: 4 })), '天工作物不可用')
    assert.equal(interactionRules.interactionItemTargetReason(itemId, land({ rarity: 5 })), '天工作物不可用')
  }
})

test('5003 只对 1×1 作物生效，且闪电变异后不可用', () => {
  assert.equal(interactionRules.interactionItemTargetReason('5003', land({ plantSize: 4 })), '仅限 1×1 作物')
  assert.equal(
    interactionRules.interactionItemTargetReason('5003', land({ mutantConfigIds: [12] })),
    '已闪电变异',
  )
  // 其他道具不受这两条限制
  assert.equal(interactionRules.interactionItemTargetReason('5004', land({ plantSize: 4 })), '')
})

test('全部条件满足时返回空串（表示可用）', () => {
  assert.equal(interactionRules.interactionItemTargetReason('5003', land()), '')
  assert.equal(interactionRules.interactionItemTargetReason('5001', land()), '')
})

// ============ 一键催熟 ============

function preview(overrides = {}) {
  return {
    sufficient: true,
    targetCount: 3,
    actionCount: 3,
    expiresAt: Date.now() + 60000,
    token: 'tk',
    ...overrides,
  }
}

function stepResult(cursor, extra = {}) {
  return { success: true, cursor, done: false, ...extra }
}

test('预览不满足条件时直接拒绝，且不发请求', async () => {
  let calls = 0
  const run = overrides => ripenAll.runRipenAll({
    preview: preview(overrides),
    cancelled: () => false,
    step: async () => {
      calls += 1
      return stepResult(1)
    },
    onProgress: () => {},
  })

  await assert.rejects(() => run({ sufficient: false }), /预览已失效/)
  await assert.rejects(() => run({ targetCount: 0 }), /预览已失效/)
  await assert.rejects(() => run({ expiresAt: Date.now() - 1 }), /预览已失效/)
  assert.equal(calls, 0, '预览不合法时不该发出任何催熟请求')
})

test('取消标记为真时立刻返回 false，不发请求', async () => {
  let calls = 0
  const result = await ripenAll.runRipenAll({
    preview: preview(),
    cancelled: () => true,
    step: async () => {
      calls += 1
      return stepResult(1)
    },
    onProgress: () => {},
  })

  assert.equal(result, false)
  assert.equal(calls, 0)
})

test('按 cursor 递增逐批执行，每批都回调进度', async () => {
  const seen = []
  const result = await ripenAll.runRipenAll({
    preview: preview({ actionCount: 3 }),
    cancelled: () => false,
    step: async (_token, cursor) => {
      seen.push(cursor)
      return stepResult(cursor + 1, { done: cursor + 1 >= 3 })
    },
    onProgress: () => {},
  })

  assert.deepEqual(seen, [0, 1, 2], 'cursor 必须从 0 开始逐次加一')
  assert.equal(result.done, true)
})

test('服务端 cursor 不连续时立即停止，避免错批', async () => {
  await assert.rejects(
    () => ripenAll.runRipenAll({
      preview: preview(),
      cancelled: () => false,
      step: async () => stepResult(5),
      onProgress: () => {},
    }),
    /催熟进度异常/,
  )
})

test('单批失败时抛错并停止后续批次', async () => {
  let calls = 0
  await assert.rejects(
    () => ripenAll.runRipenAll({
      preview: preview(),
      cancelled: () => false,
      step: async (_t, cursor) => {
        calls += 1
        return { success: false, cursor: cursor + 1, done: false }
      },
      onProgress: () => {},
    }),
    /催熟进度异常/,
  )
  assert.equal(calls, 1)
})

test('服务端返回 stopped 时把原因原样透出', async () => {
  await assert.rejects(
    () => ripenAll.runRipenAll({
      preview: preview(),
      cancelled: () => false,
      step: async (_t, cursor) => stepResult(cursor + 1, { stopped: '化肥不足' }),
      onProgress: () => {},
    }),
    /化肥不足/,
  )
})

test('执行完所有批次仍未完成时提示重新预览', async () => {
  await assert.rejects(
    () => ripenAll.runRipenAll({
      preview: preview({ actionCount: 2 }),
      cancelled: () => false,
      step: async (_t, cursor) => stepResult(cursor + 1, { done: false }),
      onProgress: () => {},
    }),
    /尚未全部成熟/,
  )
})

test('每批之间检查取消，中途取消返回 false 且不再发请求', async () => {
  let calls = 0
  const result = await ripenAll.runRipenAll({
    preview: preview({ actionCount: 5 }),
    // 第一次返回 false（进入循环），第二次起返回 true（下一批之前取消）
    cancelled: () => calls > 0,
    step: async (_t, cursor) => {
      calls += 1
      return stepResult(cursor + 1)
    },
    onProgress: () => {},
  })

  assert.equal(result, false)
  assert.equal(calls, 1, '取消之后不该再发第二批')
})

test('化肥小时数换算：负数归零，最多三位小数', () => {
  assert.equal(ripenAll.fertilizerHours(3600), '1')
  assert.equal(ripenAll.fertilizerHours(5400), '1.5')
  assert.equal(ripenAll.fertilizerHours(-100), '0')
})
