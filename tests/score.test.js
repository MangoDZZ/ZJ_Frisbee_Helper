'use strict'

/**
 * 积分推导单元测试。纯 Node，不需要微信环境。
 *
 *   node tests/score.test.js
 *
 * 积分榜是活动级汇总：报名在活动层，signupId 就是活动内的人员主键，
 * 所以计分不需要知道分队，只需要比赛记录 + 报名名单。
 */

const score = require('../cloudfunctions/hat-match/lib/score.js')

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

function deepEq (actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((msg ? msg + '：' : '') + '期望 ' + b + '，实际 ' + a)
}

// ---------------------------------------------------------------- 造数据

/** 活动的报名名单：a1..aN */
function makeSignups (names) {
  const byId = {}
  names.forEach(function (n) {
    byId[n] = { _id: n, name: n, gender: 'M', level: 3 }
  })
  return byId
}

function match (over) {
  return Object.assign({
    tournamentId: 't1',
    teamAIndex: 0, teamBIndex: 1,
    scoreA: 0, scoreB: 0,
    participantsA: [], participantsB: [], mvpIds: [],
  }, over)
}

function rowOf (res, id) {
  return res.rows.filter(function (x) { return x.signupId === id })[0]
}

function pointsOf (res, id) {
  const r = rowOf(res, id)
  if (!r) throw new Error('榜上找不到 ' + id)
  return r.points
}

// ================================================================

test('基本计分：胜方上场每人 3 分，败方上场每人 1 分', function () {
  const su = makeSignups(['a1', 'a2', 'b1', 'b2'])
  const res = score.computeStandings([
    match({ scoreA: 15, scoreB: 10, participantsA: ['a1', 'a2'], participantsB: ['b1', 'b2'] }),
  ], su)

  eq(pointsOf(res, 'a1'), 3)
  eq(pointsOf(res, 'a2'), 3)
  eq(pointsOf(res, 'b1'), 1)
  eq(pointsOf(res, 'b2'), 1)
})

test('B 队获胜时方向正确（不是写死 A 赢）', function () {
  const su = makeSignups(['a1', 'b1'])
  const res = score.computeStandings([
    match({ scoreA: 8, scoreB: 13, participantsA: ['a1'], participantsB: ['b1'] }),
  ], su)
  eq(pointsOf(res, 'b1'), 3)
  eq(pointsOf(res, 'a1'), 1)
  eq(rowOf(res, 'b1').won, 1)
  eq(rowOf(res, 'a1').lost, 1)
})

test('未上场的人 0 分，但仍然出现在榜上', function () {
  const su = makeSignups(['a1', 'a2', 'b1', 'absent'])
  const res = score.computeStandings([
    match({ scoreA: 15, scoreB: 10, participantsA: ['a1', 'a2'], participantsB: ['b1'] }),
  ], su)

  eq(pointsOf(res, 'absent'), 0)
  eq(rowOf(res, 'absent').played, 0)
  eq(res.rows.length, 4, '报名的人都要在榜上')
  eq(res.totals.playedCount, 3)
  eq(res.totals.playerCount, 4)
})

test('MVP 额外 +1，且只会落在败方', function () {
  const su = makeSignups(['a1', 'b1', 'b2'])
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 13,
      participantsA: ['a1'], participantsB: ['b1', 'b2'],
      mvpIds: ['b1'],
    }),
  ], su)

  eq(pointsOf(res, 'b1'), 2, '败方 1 分 + MVP 1 分')
  eq(pointsOf(res, 'b2'), 1)
  eq(pointsOf(res, 'a1'), 3, '胜方拿不到 MVP 分')
  eq(rowOf(res, 'b1').mvpCount, 1)
  eq(rowOf(res, 'a1').mvpCount, 0)
})

test('弃赛扣 3 分，且弃赛两次及以上最终积分归零', function () {
  const su = makeSignups(['p1', 'p2', 'p3'])
  const res = score.computeStandings([
    match({ scoreA: 15, scoreB: 10, participantsA: ['p1'], participantsB: ['p2'], forfeitIds: ['p3'] }),
    match({ tournamentId: 't2', scoreA: 12, scoreB: 10, participantsA: ['p1'], participantsB: ['p2'], forfeitIds: ['p3'] }),
  ], su)
  eq(pointsOf(res, 'p3'), 0, '弃赛两次后积分归零')
  eq(rowOf(res, 'p3').forfeitCount, 2)
  eq(pointsOf(res, 'p1'), 6)

  const once = score.computeStandings([
    match({ scoreA: 15, scoreB: 10, participantsA: ['p1'], participantsB: ['p2'], forfeitIds: ['p3'] }),
  ], su)
  eq(pointsOf(once, 'p3'), -3)
  eq(score.FORFEIT, -3)
})

test('跨多场赛事按人汇总累加', function () {
  const su = makeSignups(['p1', 'p2', 'p3', 'p4'])
  const res = score.computeStandings([
    // 赛事 t1：p1 p2 胜 p3 p4
    match({
      tournamentId: 't1', scoreA: 15, scoreB: 10,
      participantsA: ['p1', 'p2'], participantsB: ['p3', 'p4'],
      mvpIds: ['p3'],
    }),
    // 赛事 t2：重新分队，p1 p3 一队赢了 p2 p4
    match({
      tournamentId: 't2', scoreA: 15, scoreB: 12,
      participantsA: ['p1', 'p3'], participantsB: ['p2', 'p4'],
      mvpIds: ['p2'],
    }),
  ], su)

  // p1: 3 + 3 = 6
  // p2: 3 + 1 + 1(MVP) = 5
  // p3: 1 + 1(MVP) + 3 = 5
  // p4: 1 + 1 = 2
  eq(pointsOf(res, 'p1'), 6)
  eq(pointsOf(res, 'p2'), 5)
  eq(pointsOf(res, 'p3'), 5)
  eq(pointsOf(res, 'p4'), 2)
  eq(res.totals.matchCount, 2)
})

test('tournamentCount 统计参加了几场赛事，同赛事多场比赛只算一次', function () {
  const su = makeSignups(['p1', 'p2'])
  const res = score.computeStandings([
    match({ tournamentId: 't1', scoreA: 15, scoreB: 1, participantsA: ['p1'], participantsB: ['p2'] }),
    match({ tournamentId: 't1', scoreA: 15, scoreB: 2, participantsA: ['p1'], participantsB: ['p2'] }),
    match({ tournamentId: 't2', scoreA: 15, scoreB: 3, participantsA: ['p1'], participantsB: ['p2'] }),
  ], su)

  eq(rowOf(res, 'p1').played, 3, '打了 3 场比赛')
  eq(rowOf(res, 'p1').tournamentCount, 2, '但只参加了 2 场赛事')
  eq(rowOf(res, 'p2').tournamentCount, 2)
})

test('只参加部分赛事的人，只拿参加那几场的分', function () {
  const su = makeSignups(['always', 'onlyT2', 'never'])
  const res = score.computeStandings([
    match({ tournamentId: 't1', scoreA: 15, scoreB: 1, participantsA: ['always'], participantsB: ['never'] }),
    match({ tournamentId: 't2', scoreA: 15, scoreB: 1, participantsA: ['always'], participantsB: ['onlyT2'] }),
  ], su)

  eq(pointsOf(res, 'always'), 6, '两场都赢')
  eq(pointsOf(res, 'onlyT2'), 1, '只打了 t2 且输了')
  eq(rowOf(res, 'onlyT2').tournamentCount, 1)
  eq(rowOf(res, 'always').tournamentCount, 2)
  eq(pointsOf(res, 'never'), 1, 'never 在 t1 上过场并输了')
})

test('空比赛列表：全员 0 分，不报错', function () {
  const su = makeSignups(['a', 'b', 'c'])
  const res = score.computeStandings([], su)
  eq(res.rows.length, 3)
  res.rows.forEach(function (r) { eq(r.points, 0); eq(r.played, 0) })
  eq(res.totals.matchCount, 0)
})

test('平局不计分（兜底，正常录不进来）', function () {
  const su = makeSignups(['a1', 'b1'])
  const res = score.computeStandings([
    match({ scoreA: 10, scoreB: 10, participantsA: ['a1'], participantsB: ['b1'] }),
  ], su)
  res.rows.forEach(function (r) { eq(r.points, 0, r.signupId) })
  eq(res.totals.matchCount, 0)
})

test('排序：积分 → 胜场 → MVP 数 → 姓名', function () {
  const byId = {
    p1: { name: '张三', gender: 'M' },
    p2: { name: '李四', gender: 'M' },
    p3: { name: '王五', gender: 'M' },
    p4: { name: '赵六', gender: 'M' },
  }
  const res = score.computeStandings([
    match({ scoreA: 15, scoreB: 1, participantsA: ['p1', 'p2'], participantsB: ['p3'] }),
    match({ scoreA: 15, scoreB: 1, participantsA: ['p1', 'p2'], participantsB: ['p3'], mvpIds: ['p2'] }),
  ], byId)

  // p2 = 7, p1 = 6, p3 = 2, p4 = 0
  deepEq(res.rows.map(function (r) { return r.signupId }), ['p2', 'p1', 'p3', 'p4'])
})

test('同分同胜场同 MVP 并列同名次', function () {
  const su = makeSignups(['a1', 'a2', 'b1', 'b2'])
  const res = score.computeStandings([
    match({ scoreA: 15, scoreB: 10, participantsA: ['a1', 'a2'], participantsB: ['b1', 'b2'] }),
  ], su)

  eq(res.rows[0].rank, 1)
  eq(res.rows[1].rank, 1, '同分应并列')
  eq(res.rows[2].rank, 3, '并列之后名次要跳号')
  eq(res.rows[3].rank, 3)
})

test('积分榜不携带球员水平——水平是不公开的', function () {
  const su = makeSignups(['a1', 'b1'])
  const res = score.computeStandings([
    match({ scoreA: 15, scoreB: 10, participantsA: ['a1'], participantsB: ['b1'] }),
  ], su)
  res.rows.forEach(function (r) {
    ok(!('level' in r), '积分榜的行不该有 level 字段：' + JSON.stringify(r))
  })
  ok(JSON.stringify(res).indexOf('level') < 0, '整个返回里都不该出现 level')
})

test('比赛里出现不在报名名单的人 → 忽略，不凭空造行', function () {
  const su = makeSignups(['a1', 'b1'])
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 10,
      participantsA: ['a1', 'ghost'], participantsB: ['b1'],
      mvpIds: ['ghost2'],
    }),
  ], su)
  eq(res.rows.length, 2, '不应多出幽灵行')
  ok(!rowOf(res, 'ghost'))
})

test('队伍战绩（单场赛事内）', function () {
  const div = {
    teams: [
      { index: 0, name: '1队', memberIds: [] },
      { index: 1, name: '2队', memberIds: [] },
      { index: 2, name: '3队', memberIds: [] },
    ],
  }
  const rec = score.computeTeamRecords([
    match({ teamAIndex: 0, teamBIndex: 1, scoreA: 15, scoreB: 10 }),
    match({ teamAIndex: 2, teamBIndex: 0, scoreA: 15, scoreB: 12 }),
    match({ teamAIndex: 1, teamBIndex: 2, scoreA: 11, scoreB: 15 }),
  ], div)

  const byIdx = {}
  rec.forEach(function (r) { byIdx[r.index] = r })
  eq(byIdx[0].won, 1); eq(byIdx[0].lost, 1)
  eq(byIdx[1].won, 0); eq(byIdx[1].lost, 2)
  eq(byIdx[2].won, 2); eq(byIdx[2].lost, 0)
  eq(byIdx[0].scoreFor, 27)
  eq(byIdx[0].scoreAgainst, 25)
})

test('分值常量就是约定的 3 / 1 / 1 / -3', function () {
  eq(score.WIN, 3)
  eq(score.LOSS, 1)
  eq(score.MVP_BONUS, 1)
  eq(score.FORFEIT, -3)
})

// ================================================================ 逐分明细（v1.0.1）

/** 造一条逐分记录 */
function pt (team, scorer, assist) {
  return { team: team, scorer: scorer, assist: assist || null }
}

test('scoresOf：有明细时按明细条数算，没明细才退回存量比分', function () {
  deepEq(score.scoresOf(match({
    scoreA: 15, scoreB: 10,
    points: [pt('A', 'a1'), pt('A', 'a1'), pt('B', 'b1')],
  })), { a: 2, b: 1 }, '有明细时以明细为准')

  deepEq(score.scoresOf(match({ scoreA: 15, scoreB: 10 })),
    { a: 15, b: 10 }, '没明细时用存量比分')

  // 空数组等同没有明细，不能算成 0:0
  deepEq(score.scoresOf(match({ scoreA: 15, scoreB: 10, points: [] })),
    { a: 15, b: 10 }, '空明细要退回存量比分')
})

test('hasPoints：区分"有明细"和"老比赛"', function () {
  eq(score.hasPoints(match({ points: [pt('A', 'a1')] })), true)
  eq(score.hasPoints(match({})), false)
  eq(score.hasPoints(match({ points: [] })), false)
})

test('得分 / 助攻统计：只认有明细的比赛', function () {
  const su = makeSignups(['a1', 'a2', 'b1'])
  const res = score.computePointStats([
    match({
      points: [
        pt('A', 'a1', 'a2'),   // a1 得 1 分，a2 助攻 1 次
        pt('A', 'a2', 'a1'),   // a2 得 1 分，a1 助攻 1 次
        pt('A', 'a1', null),   // 个人单打：a1 再得 1 分，无助攻
        pt('B', 'b1', null),
      ],
    }),
    // 没有明细的比赛：只影响积分，不进这两项统计
    match({ scoreA: 15, scoreB: 10, participantsA: ['a1'], participantsB: ['b1'] }),
  ], su)

  eq(res.totals.matchCount, 1, '只有 1 场有明细')
  eq(res.totals.pointCount, 4, '共 4 个得分记录')

  const a1 = res.rows.filter(function (r) { return r.signupId === 'a1' })[0]
  eq(a1.goals, 2)
  eq(a1.assists, 1)
  eq(a1.total, 3)

  const a2 = res.rows.filter(function (r) { return r.signupId === 'a2' })[0]
  eq(a2.goals, 1)
  eq(a2.assists, 1)
  eq(a2.total, 2)

  const b1 = res.rows.filter(function (r) { return r.signupId === 'b1' })[0]
  eq(b1.goals, 1)
  eq(b1.assists, 0)
})

test('得分 / 助攻统计：没有明细时全是 0，且不含水平字段', function () {
  const su = makeSignups(['a1', 'b1'])
  const res = score.computePointStats([
    match({ scoreA: 15, scoreB: 10, participantsA: ['a1'], participantsB: ['b1'] }),
  ], su)

  eq(res.totals.matchCount, 0)
  eq(res.totals.pointCount, 0)
  res.rows.forEach(function (r) {
    eq(r.goals, 0)
    eq(r.assists, 0)
    eq(r.total, 0)
  })
  ok(JSON.stringify(res).indexOf('level') < 0, '榜单里不该出现 level')
})

test('得分 / 助攻统计：明细里的人不在名单里就忽略，不凭空造行', function () {
  const su = makeSignups(['a1'])
  const res = score.computePointStats([
    match({ points: [pt('A', 'ghost', 'a1'), pt('A', 'a1', 'ghost')] }),
  ], su)
  eq(res.rows.length, 1, '不应多出幽灵行')
  eq(res.rows[0].goals, 1)
  eq(res.rows[0].assists, 1)
})

test('得分 / 助攻统计：排序稳定——得分优先，再助攻，最后按名字', function () {
  const su = makeSignups(['乙', '甲', '丙'])
  const res = score.computePointStats([
    match({
      points: [
        pt('A', '丙'), pt('A', '丙'),
        pt('A', '甲'), pt('A', '甲'),
        pt('A', '乙', '丙'),
      ],
    }),
  ], su)
  // 丙、甲都是 2 分；丙多 1 次助攻，排前面
  eq(res.rows[0].signupId, '丙')
  eq(res.rows[1].signupId, '甲')
  eq(res.rows[2].signupId, '乙')
})

test('我的数据：只算自己的得分与助攻，并给逐场明细', function () {
  const su = makeSignups(['a1', 'a2', 'b1'])
  const res = score.computeMyPoints([
    match({ _id: 'm1', points: [pt('A', 'a1', 'a2'), pt('A', 'a1'), pt('B', 'b1')] }),
    match({ _id: 'm2', points: [pt('A', 'a2', 'a1'), pt('A', 'b1')] }),
  ], su, 'a1')

  eq(res.name, 'a1')
  eq(res.goals, 2, 'm1 里 2 分，m2 里没得分')
  eq(res.assists, 1, 'm2 里助攻 1 次')
  eq(res.total, 3)
  eq(res.matchCount, 2, '两场都有数据')
  eq(res.matches.length, 2)
  eq(res.matches[0].matchId, 'm1')
  eq(res.matches[0].goals, 2)
  eq(res.matches[0].assists, 0)
  eq(res.matches[1].goals, 0)
  eq(res.matches[1].assists, 1)
})

test('我的数据：没有明细的比赛不出现在明细里，名单外的人返回 null', function () {
  const su = makeSignups(['a1', 'b1'])
  const res = score.computeMyPoints([
    match({ _id: 'm1', scoreA: 15, scoreB: 10, participantsA: ['a1'], participantsB: ['b1'] }),
  ], su, 'a1')
  eq(res.matchCount, 0)
  eq(res.matches.length, 0)
  eq(res.goals, 0)

  eq(score.computeMyPoints([], su, 'ghost'), null, '不在名单里返回 null')
})

test('逐分明细：不会把水平带进任何统计返回', function () {
  const su = makeSignups(['a1', 'a2'])
  const res = score.computePointStats([
    match({ points: [pt('A', 'a1', 'a2')] }),
  ], su)
  const mine = score.computeMyPoints([match({ _id: 'm1', points: [pt('A', 'a1')] })], su, 'a1')
  ok(JSON.stringify(res).indexOf('level') < 0)
  ok(JSON.stringify(mine).indexOf('level') < 0)
})

test('上限常量存在且为正整数', function () {
  ok(score.MAX_POINTS_PER_MATCH >= 21, '上限至少要能记满一场：' + score.MAX_POINTS_PER_MATCH)
  eq(Math.floor(score.MAX_POINTS_PER_MATCH), score.MAX_POINTS_PER_MATCH)
})

// ---------------------------------------------------------------- 汇总

console.log('')
if (failures.length === 0) {
  console.log('全部通过：' + passed + ' 个用例')
  process.exit(0)
} else {
  console.log('通过 ' + passed + ' 个，失败 ' + failures.length + ' 个：')
  console.log('')
  failures.forEach(function (f) {
    console.log('  ✗ ' + f.name)
    console.log('    ' + f.message)
  })
  console.log('')
  process.exit(1)
}
