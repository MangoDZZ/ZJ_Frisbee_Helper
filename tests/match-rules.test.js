'use strict'

/**
 * 比赛规则与时间轴。纯 Node，不需要微信环境。
 *
 *   node tests/match-rules.test.js
 *
 * 重点盯住三处容易算错的地方：
 *  1. 中场条件是"时间分支"与"分数分支"的**较早**者；时间中场可留空
 *  2. 软时限改目标分发生在**到点之后的下一次得分完成时**，不是到点那一刻
 *  3. 硬时限到点但平局时不能判定可结束（结束的比赛不允许平局）
 */

const mr = require('../shared/match-rules.js')

let passed = 0
const failures = []

function test (name, fn) {
  try {
    fn()
    passed++
  } catch (e) {
    failures.push({ name: name, message: (e && e.message) || String(e) })
  }
}

function ok (cond, msg) { if (!cond) throw new Error(msg || '断言失败') }

function eq (actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + '：' : '') + '期望 ' + JSON.stringify(expected) +
      '，实际 ' + JSON.stringify(actual))
  }
}

const MIN = 60000

/** 造一批得分：spec 形如 [['A', 65], ['B', 120]]，值是相对开表的**秒** */
function pts (spec) {
  return spec.map(function (s) { return { team: s[0], t: s[1] } })
}

function at (minutes, seconds) {
  return (minutes || 0) * 60 + (seconds || 0)
}

// ================================================================ 默认值与校验

test('默认规则就是计划书里写的 13 / 30 / 60 / 无硬时限 / 3', function () {
  eq(mr.DEFAULT_RULES.targetScore, 13)
  eq(mr.DEFAULT_RULES.halftimeMinutes, 30)
  eq(mr.DEFAULT_RULES.softCapMinutes, 60)
  eq(mr.DEFAULT_RULES.hardCapMinutes, null)
  eq(mr.DEFAULT_RULES.halftimeBreakMinutes, 3)
})

test('normalizeRules：空值一律走默认，越界截断而不是报错', function () {
  const r = mr.normalizeRules(null)
  eq(r.targetScore, 13)
  eq(r.hardCapMinutes, null)

  const big = mr.normalizeRules({ targetScore: 999, softCapMinutes: 0 })
  eq(big.targetScore, 99, '越界截到上限')
  eq(big.softCapMinutes, 1, '越界截到下限')

  // 字符串数字也要认（表单里传上来的是字符串）
  eq(mr.normalizeRules({ targetScore: '15' }).targetScore, 15)
  // 垃圾值退回默认
  eq(mr.normalizeRules({ targetScore: 'abc' }).targetScore, 13)
  eq(mr.normalizeRules({ targetScore: 12.5 }).targetScore, 13)
})

test('validateRules：合法配置原样通过', function () {
  const v = mr.validateRules({
    targetScore: 15, halftimeMinutes: 45, softCapMinutes: 75,
    hardCapMinutes: 90, halftimeBreakMinutes: 5,
  })
  ok(v.value, '应当通过：' + JSON.stringify(v.error))
  eq(v.value.targetScore, 15)
  eq(v.value.hardCapMinutes, 90)
})

test('validateRules：越界报错，不静默改数', function () {
  ok(mr.validateRules({ targetScore: 100, halftimeMinutes: 30, softCapMinutes: 60,
    halftimeBreakMinutes: 3 }).error, '目标分 100 超上限')
  ok(mr.validateRules({ targetScore: 13, halftimeMinutes: -5, softCapMinutes: 60,
    halftimeBreakMinutes: 3 }).error, '时间中场为负数不合法')
  ok(mr.validateRules({ targetScore: 13, halftimeMinutes: 30, softCapMinutes: 60,
    halftimeBreakMinutes: 31 }).error, '休息 31 分钟超上限')
  ok(mr.validateRules({ targetScore: 'x', halftimeMinutes: 30, softCapMinutes: 60,
    halftimeBreakMinutes: 3 }).error, '目标分不是数字')
})

test('时间中场是选填：空串 / null / 0 / 缺省都表示不设', function () {
  ;['', null, 0, undefined].forEach(function (v) {
    const input = {
      targetScore: 13, softCapMinutes: 60, halftimeBreakMinutes: 3,
    }
    if (v !== undefined) input.halftimeMinutes = v
    const r = mr.validateRules(input)
    ok(r.value, '应当通过：' + JSON.stringify(v))
    eq(r.value.halftimeMinutes, null, JSON.stringify(v) + ' 应存成 null')
  })
})

test('时间中场不设时，不再校验"不能晚于软时限"', function () {
  const r = mr.validateRules({
    targetScore: 13, halftimeMinutes: null, softCapMinutes: 60, halftimeBreakMinutes: 3,
  })
  ok(r.value, '不设就没有先后关系可违反')
})

test('normalizeRules：字段缺失给默认值，显式清空才是不设', function () {
  // 老赛事 / 没存过规则：缺字段 → 默认 30
  eq(mr.normalizeRules({}).halftimeMinutes, 30, '缺字段走默认')
  eq(mr.normalizeRules({ targetScore: 15 }).halftimeMinutes, 30)
  // 组织者主动清空：null / '' / 0 → 不设
  eq(mr.normalizeRules({ halftimeMinutes: null }).halftimeMinutes, null, '显式 null 就是不设')
  eq(mr.normalizeRules({ halftimeMinutes: '' }).halftimeMinutes, null)
  eq(mr.normalizeRules({ halftimeMinutes: 0 }).halftimeMinutes, null)
  // 硬时限同理
  eq(mr.normalizeRules({}).hardCapMinutes, null, '硬时限默认不设')
  eq(mr.normalizeRules({ hardCapMinutes: 90 }).hardCapMinutes, 90)
})

test('validateRules：时间中场不能晚于软时限，硬时限必须晚于软时限', function () {
  const lateHalf = mr.validateRules({
    targetScore: 13, halftimeMinutes: 90, softCapMinutes: 60, halftimeBreakMinutes: 3,
  })
  ok(lateHalf.error, '中场 90 > 软时限 60 应当报错')

  const badHard = mr.validateRules({
    targetScore: 13, halftimeMinutes: 30, softCapMinutes: 60,
    hardCapMinutes: 60, halftimeBreakMinutes: 3,
  })
  ok(badHard.error, '硬时限等于软时限应当报错')

  const okHard = mr.validateRules({
    targetScore: 13, halftimeMinutes: 30, softCapMinutes: 60,
    hardCapMinutes: 61, halftimeBreakMinutes: 3,
  })
  ok(okHard.value, '硬时限 61 应当通过')
})

test('validateRules：硬时限留空/0/null 都表示不设', function () {
  ;[[], [null], [''], [0]].forEach(function (pair) {
    const v = mr.validateRules({
      targetScore: 13, halftimeMinutes: 30, softCapMinutes: 60,
      hardCapMinutes: pair[0], halftimeBreakMinutes: 3,
    })
    ok(v.value, '应当通过：' + JSON.stringify(pair))
    eq(v.value.hardCapMinutes, null)
  })
})

test('halfTargetOf：13 → 7，15 → 8，1 → 1', function () {
  eq(mr.halfTargetOf(13), 7)
  eq(mr.halfTargetOf(15), 8)
  eq(mr.halfTargetOf(1), 1)
})

test('formatClock：分秒与超过一小时', function () {
  eq(mr.formatClock(0), '0:00')
  eq(mr.formatClock(9), '0:09')
  eq(mr.formatClock(65), '1:05')
  eq(mr.formatClock(600), '10:00')
  eq(mr.formatClock(3600), '1:00:00')
  eq(mr.formatClock(3725), '1:02:05')
  eq(mr.formatClock(-5), '0:00', '负数当 0')
})

// ================================================================ 时钟状态

const R = mr.DEFAULT_RULES
const START = 1000000

function state (points, elapsedMin, rules) {
  return mr.clockState(rules || R, START, points, START + elapsedMin * MIN)
}

test('没开表时不算时间轴，也不会误报可以结束', function () {
  const s = mr.clockState(R, 0, pts([['A', 0]]), START)
  eq(s.running, false)
  eq(s.elapsedSec, 0)
  eq(s.halfReached, false)
  eq(s.canFinish, false)
  eq(mr.clockHint(s), '', '没开表不该有提示')
})

test('开局：未到中场、未到软时限、目标分就是初始值', function () {
  const s = state(pts([['A', 30], ['B', 90]]), 5)
  eq(s.phase, 'first')
  eq(s.halfReached, false)
  eq(s.softReached, false)
  eq(s.target, 13, '还没到软时限，目标分不变')
  eq(s.targetReached, false)
  eq(s.canFinish, false)
})

test('中场分数分支：任一队先到 7 分即到中场', function () {
  const list = []
  for (let i = 0; i < 7; i++) list.push(['A', 60 + i * 20])
  const s = state(pts(list), 5)
  eq(s.halfReached, true)
  eq(s.halfReason, 'score')
  eq(s.halfAtSec, 60 + 6 * 20, '第 7 分落袋那一刻')
  eq(s.halfAtSec < 30 * 60, true, '比 30 分钟早')
})

test('中场时间分支：一直不得分，到 30 分钟也进中场', function () {
  const s = state(pts([['A', 30], ['B', 60]]), 31)
  eq(s.halfReached, true)
  eq(s.halfReason, 'time')
  eq(s.halfAtSec, 30 * 60)
})

test('时间中场不设时，中场只由分数分支触发', function () {
  const noTime = Object.assign({}, R, { halftimeMinutes: null })
  // 打了 50 分钟、只有 1:0：不进中场。默认 30 分钟的话这会儿早该中场了
  const s1 = mr.clockState(noTime, START, pts([['A', 30]]), START + 50 * MIN)
  eq(s1.halfReached, false)
  eq(s1.inBreak, false)
  eq(mr.clockHint(s1), '', '50 分钟未到软时限，也没有别的提示')
  // 同样的时间点、用默认规则就会进中场——证明差别确实来自这个开关
  eq(state(pts([['A', 30]]), 50).halfReached, true)

  // 某队到 7 分才进中场
  const list = []
  for (let i = 0; i < 7; i++) list.push(['A', 40 * 60 + i])
  const s2 = mr.clockState(noTime, START, pts(list), START + 45 * MIN)
  eq(s2.halfReached, true)
  eq(s2.halfReason, 'score')
  eq(s2.halfAtSec, 40 * 60 + 6)
})

test('中场取较早者：分数分支 25 分钟发生在时间分支 30 分钟之前', function () {
  const list = []
  for (let i = 0; i < 7; i++) list.push(['A', 25 * 60 + i])   // 第 7 分在 25 分左右
  const s = state(pts(list), 26)
  eq(s.halfReason, 'score')
  eq(s.halfAtSec, 25 * 60 + 6)
})

test('中场休息是提示，不停表：休息结束后进入下半场，用时继续累加', function () {
  const s = state(pts([['A', 10]]), 31)
  eq(s.inBreak, true, '30 分到 33 分之间在中场休息')
  eq(s.breakRemainSec, 2 * 60, '还剩 2 分钟')
  eq(s.elapsedSec, 31 * 60, '表没有停')

  const later = state(pts([['A', 10]]), 34)
  eq(later.phase, 'second')
  eq(later.inBreak, false)
})

test('休息时长为 0 就没有休息窗口', function () {
  const rules = Object.assign({}, R, { halftimeBreakMinutes: 0 })
  const s = state(pts([['A', 10]]), 31, rules)
  eq(s.halfReached, true)
  eq(s.inBreak, false)
  eq(s.phase, 'second')
})

test('软时限到点那一刻不改目标分——要等下一次得分完成', function () {
  // 55 分时 11:9，到 60 分（软时限）但没有新的得分
  const list = []
  for (let i = 0; i < 11; i++) list.push(['A', 55 * 60 - 100 + i])
  for (let i = 0; i < 9; i++) list.push(['B', 55 * 60 - 50 + i])
  const s = state(pts(list), 60)
  eq(s.softReached, true)
  eq(s.targetRaised, false, '到点了但还没得分')
  eq(s.target, 13)
  eq(s.targetReached, false, '11 分没到 13，不能结束')
})

test('软时限后的下一分把目标分改成"领先方 +1"', function () {
  const list = []
  for (let i = 0; i < 11; i++) list.push(['A', 20 * 60 + i])
  for (let i = 0; i < 9; i++) list.push(['B', 21 * 60 + i])
  // 软时限 60 分之后，A 又得一分 → 12:9 → 目标变 13
  list.push(['A', 61 * 60])
  const s1 = state(pts(list), 61.5)
  eq(s1.target, 13, '12+1 = 13')
  eq(s1.targetRaised, false, '与初始目标相同，等于没变')

  // 换个更低的初始目标，才能看出它真的抬高了
  const lowRules = Object.assign({}, R, { targetScore: 9, halftimeMinutes: 20 })
  const list2 = []
  for (let i = 0; i < 5; i++) list2.push(['A', 10 * 60 + i])
  for (let i = 0; i < 4; i++) list2.push(['B', 11 * 60 + i])
  list2.push(['A', 61 * 60])            // 软时限后：6:4 → 目标 7
  const s2 = mr.clockState(lowRules, START, pts(list2), START + 62 * MIN)
  eq(s2.baseTarget, 9)
  eq(s2.target, 9, '7 比初始目标 9 小，取较大的那个')
  eq(s2.targetRaised, false, '没有真的抬高')

  // 领先方分数已经超过初始目标时才会抬高
  const list3 = []
  for (let i = 0; i < 9; i++) list3.push(['A', 10 * 60 + i])
  list3.push(['B', 62 * 60])            // 软时限后 B 得分：9:1 → 目标 10
  const s3 = mr.clockState(lowRules, START, pts(list3), START + 63 * MIN)
  eq(s3.target, 10, '9+1 = 10')
  eq(s3.targetRaised, true)
  eq(s3.targetReached, false, '当前 9 分，还没到 10')
  eq(s3.canFinish, false)
})

test('软时限后打成平手时，目标分按平分 +1', function () {
  const rules = Object.assign({}, R, { targetScore: 9, halftimeMinutes: 20 })
  const list = []
  for (let i = 0; i < 5; i++) list.push(['A', 10 * 60 + i * 2])
  for (let i = 0; i < 5; i++) list.push(['B', 11 * 60 + i * 2])
  list.push(['A', 62 * 60])             // 6:5 → 目标 7
  const s = mr.clockState(rules, START, pts(list), START + 63 * MIN)
  eq(s.target, 9, '7 小于初始 9，取 9')
  ok(s.scoreA === 6 && s.scoreB === 5)
})

test('达到目标分 → 可以结束，提示文案点明目标分', function () {
  const list = []
  for (let i = 0; i < 13; i++) list.push(['A', 30 * 60 + i * 10])
  const s = state(pts(list), 40)
  eq(s.target, 13)
  eq(s.targetReached, true)
  eq(s.canFinish, true)
  eq(mr.clockHint(s), '已达到目标分 13，可以结束比赛')
})

test('硬时限：到点即可结束，即使没到目标分', function () {
  const rules = Object.assign({}, R, { hardCapMinutes: 70 })
  const s = state(pts([['A', 10 * 60]]), 71, rules)
  eq(s.hardReached, true)
  eq(s.hardSec, 70 * 60)
  eq(s.targetReached, false)
  eq(s.scoreA, 1)
  eq(s.scoreB, 0)
  eq(s.canFinish, true, '比分 1:0 已分出胜负')
  eq(mr.clockHint(s), '已到硬时限，可以结束比赛')
})

test('硬时限到点但平局 → 不允许结束，提示继续记到分出胜负', function () {
  const rules = Object.assign({}, R, { hardCapMinutes: 70 })
  const s = state(pts([['A', 10 * 60], ['B', 11 * 60]]), 71, rules)
  ok(s.scoreA === s.scoreB)
  eq(s.tieAtHardCap, true)
  eq(s.canFinish, false)
  eq(mr.clockHint(s), '已到硬时限但比分相同，请继续记到分出胜负')

  // 再记一分就分出来了
  const decided = state(pts([['A', 10 * 60], ['B', 11 * 60], ['A', 72 * 60]]), 73, rules)
  eq(decided.tieAtHardCap, false)
  eq(decided.canFinish, true)
})

test('没设硬时限时 hardReached 恒为 false', function () {
  const s = state(pts([['A', 10]]), 300)
  eq(s.hardSec, null)
  eq(s.hardReached, false)
  eq(s.canFinish, false, '又没到目标分，当然不能结束')
})

test('老比赛没有逐分时刻（t 缺失）时，分数分支不参与，只按时间判定', function () {
  const legacy = [{ team: 'A' }, { team: 'A' }, { team: 'B' }]
  const s = mr.clockState(R, START, legacy, START + 31 * MIN)
  eq(s.halfReached, true)
  eq(s.halfReason, 'time', '拿不到得分时刻，只能用时间分支')
  eq(s.scoreA, 2)
  eq(s.scoreB, 1, '比分仍然按明细累计')
})

test('未到软时限时不会提前改目标分（没有 t 也不行）', function () {
  const legacy = [{ team: 'A' }, { team: 'A' }]
  const s = mr.clockState(R, START, legacy, START + 10 * MIN)
  eq(s.target, 13)
  eq(s.targetRaised, false)
})

test('clockHint：还没到中场就该是空串，中场休息时才提示倒计时', function () {
  eq(mr.clockHint(state(pts([['A', 10]]), 5)), '')
  const brk = state(pts([['A', 10]]), 31)
  eq(mr.clockHint(brk), '中场休息中，还有 2:00')
  const soft = state(pts([['A', 10]]), 61)
  eq(mr.clockHint(soft), '已到软时限，下一次得分后目标分将调整为领先方 +1')
})

// ================================================================ 汇总

console.log('')
if (failures.length === 0) {
  console.log('全部通过：' + passed + ' 个用例')
  process.exit(0)
} else {
  console.log('通过 ' + passed + ' 个，失败 ' + failures.length + ' 个：')
  console.log('')
  for (let i = 0; i < failures.length; i++) {
    console.log('  ✗ ' + failures[i].name)
    console.log('    ' + failures[i].message)
  }
  process.exit(1)
}
