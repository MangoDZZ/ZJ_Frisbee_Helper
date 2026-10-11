'use strict'

/**
 * 积分推导单元测试。纯 Node，不需要微信环境。
 *
 *   node tests/score.test.js
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

/** 两队各 3 人：A 队 a1-a3，B 队 b1-b3 */
function makeDivision (sizes) {
  const teams = []
  let n = 0
  const names = 'ABCD'
  for (let t = 0; t < sizes.length; t++) {
    const ids = []
    for (let i = 0; i < sizes[t]; i++) ids.push(names[t].toLowerCase() + (i + 1))
    teams.push({ index: t, name: (t + 1) + '队', memberIds: ids })
    n += sizes[t]
  }
  return { teams: teams, playerCount: n }
}

function makeSignups (division) {
  const byId = {}
  division.teams.forEach(function (t) {
    t.memberIds.forEach(function (id) {
      byId[id] = { _id: id, name: id, gender: 'M', level: 3 }
    })
  })
  return byId
}

function match (over) {
  return Object.assign({
    teamAIndex: 0, teamBIndex: 1,
    scoreA: 0, scoreB: 0,
    participantsA: [], participantsB: [], mvpIds: [],
  }, over)
}

function pointsOf (res, id) {
  const r = res.rows.filter(function (x) { return x.signupId === id })[0]
  if (!r) throw new Error('榜上找不到 ' + id)
  return r.points
}

function rowOf (res, id) {
  return res.rows.filter(function (x) { return x.signupId === id })[0]
}

// ================================================================

test('基本计分：胜方上场每人 3 分，败方上场每人 1 分', function () {
  const div = makeDivision([3, 3])
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 10,
      participantsA: ['a1', 'a2', 'a3'],
      participantsB: ['b1', 'b2', 'b3'],
    }),
  ], div, makeSignups(div))

  eq(pointsOf(res, 'a1'), 3, 'a1 胜方')
  eq(pointsOf(res, 'a2'), 3)
  eq(pointsOf(res, 'a3'), 3)
  eq(pointsOf(res, 'b1'), 1, 'b1 败方')
  eq(pointsOf(res, 'b2'), 1)
  eq(pointsOf(res, 'b3'), 1)
})

test('B 队获胜时方向正确（不是写死 A 赢）', function () {
  const div = makeDivision([2, 2])
  const res = score.computeStandings([
    match({
      scoreA: 8, scoreB: 13,
      participantsA: ['a1', 'a2'],
      participantsB: ['b1', 'b2'],
    }),
  ], div, makeSignups(div))

  eq(pointsOf(res, 'b1'), 3, 'B 队赢应得 3 分')
  eq(pointsOf(res, 'a1'), 1, 'A 队输应得 1 分')
  eq(rowOf(res, 'b1').won, 1)
  eq(rowOf(res, 'a1').lost, 1)
})

test('未上场的人 0 分，但仍然出现在榜上', function () {
  const div = makeDivision([3, 3])
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 10,
      participantsA: ['a1', 'a2'],        // a3 没上场
      participantsB: ['b1', 'b2'],        // b3 没上场
    }),
  ], div, makeSignups(div))

  eq(pointsOf(res, 'a3'), 0, '胜方未上场的人不得分')
  eq(pointsOf(res, 'b3'), 0, '败方未上场的人不得分')
  eq(rowOf(res, 'a3').played, 0)
  eq(res.rows.length, 6, '6 个人都应在榜上')
  eq(res.totals.playedCount, 4, '只有 4 人上过场')
})

test('MVP 额外 +1，且只会落在败方', function () {
  const div = makeDivision([3, 3])
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 13,
      participantsA: ['a1', 'a2', 'a3'],
      participantsB: ['b1', 'b2', 'b3'],
      mvpIds: ['b1', 'b2'],
    }),
  ], div, makeSignups(div))

  eq(pointsOf(res, 'b1'), 2, '败方 1 分 + MVP 1 分')
  eq(pointsOf(res, 'b2'), 2)
  eq(pointsOf(res, 'b3'), 1, '没当选 MVP 的败方只有 1 分')
  eq(pointsOf(res, 'a1'), 3, '胜方拿不到 MVP 分')
  eq(rowOf(res, 'b1').mvpCount, 1)
  eq(rowOf(res, 'a1').mvpCount, 0)
})

test('MVP 只选了 1 个也正常（允许先存比分、之后补录）', function () {
  const div = makeDivision([2, 2])
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 9,
      participantsA: ['a1', 'a2'],
      participantsB: ['b1', 'b2'],
      mvpIds: ['b1'],
    }),
  ], div, makeSignups(div))
  eq(pointsOf(res, 'b1'), 2)
  eq(pointsOf(res, 'b2'), 1)
})

test('多场比赛累加，一人既有胜场又有败场', function () {
  const div = makeDivision([2, 2, 2])
  const res = score.computeStandings([
    // 第 1 场：1队 胜 2队
    match({
      teamAIndex: 0, teamBIndex: 1, scoreA: 15, scoreB: 10,
      participantsA: ['a1', 'a2'], participantsB: ['b1', 'b2'],
      mvpIds: ['b1'],
    }),
    // 第 2 场：3队 胜 1队
    match({
      teamAIndex: 2, teamBIndex: 0, scoreA: 15, scoreB: 12,
      participantsA: ['c1', 'c2'], participantsB: ['a1', 'a2'],
      mvpIds: ['a1'],
    }),
  ], div, makeSignups(div))

  // a1：第1场胜 3 分，第2场负 1 分 + MVP 1 分 = 5
  eq(pointsOf(res, 'a1'), 5, 'a1 一胜一负且当选 MVP')
  eq(rowOf(res, 'a1').won, 1)
  eq(rowOf(res, 'a1').lost, 1)
  eq(rowOf(res, 'a1').played, 2)
  eq(rowOf(res, 'a1').mvpCount, 1)

  // a2：3 + 1 = 4
  eq(pointsOf(res, 'a2'), 4)
  // b1：1 + 1(MVP) = 2
  eq(pointsOf(res, 'b1'), 2)
  // c1：3
  eq(pointsOf(res, 'c1'), 3)
  eq(res.totals.matchCount, 2)
})

test('空比赛列表：全员 0 分，不报错', function () {
  const div = makeDivision([3, 3])
  const res = score.computeStandings([], div, makeSignups(div))
  eq(res.rows.length, 6)
  res.rows.forEach(function (r) {
    eq(r.points, 0)
    eq(r.played, 0)
  })
  eq(res.totals.matchCount, 0)
  eq(res.totals.playedCount, 0)
})

test('平局不计分（兜底，正常录不进来）', function () {
  const div = makeDivision([2, 2])
  const res = score.computeStandings([
    match({
      scoreA: 10, scoreB: 10,
      participantsA: ['a1', 'a2'], participantsB: ['b1', 'b2'],
    }),
  ], div, makeSignups(div))
  res.rows.forEach(function (r) { eq(r.points, 0, r.signupId + ' 平局不应得分') })
  eq(res.totals.matchCount, 0, '平局不计入场次')
})

test('排序：积分 → 胜场 → MVP 数 → 姓名', function () {
  const div = { teams: [{ index: 0, name: '1队', memberIds: ['p1', 'p2', 'p3', 'p4'] }] }
  const byId = {
    p1: { name: '张三', gender: 'M', level: 3 },
    p2: { name: '李四', gender: 'M', level: 3 },
    p3: { name: '王五', gender: 'M', level: 3 },
    p4: { name: '赵六', gender: 'M', level: 3 },
  }
  // 手工构造：p1 6分/2胜, p2 6分/2胜/1MVP, p3 4分, p4 0分
  const div2 = {
    teams: [
      { index: 0, name: '1队', memberIds: ['p1', 'p2'] },
      { index: 1, name: '2队', memberIds: ['p3', 'p4'] },
    ],
  }
  const res = score.computeStandings([
    match({ scoreA: 15, scoreB: 1, participantsA: ['p1', 'p2'], participantsB: ['p3'] }),
    match({ scoreA: 15, scoreB: 1, participantsA: ['p1', 'p2'], participantsB: ['p3'], mvpIds: ['p2'] }),
  ], div2, byId)

  // p1 = 3+3 = 6（2胜，0 MVP）; p2 = 3+3+1 = 7（2胜，1 MVP）; p3 = 1+1 = 2; p4 = 0
  deepEq(res.rows.map(function (r) { return r.signupId }), ['p2', 'p1', 'p3', 'p4'])
  eq(res.rows[0].points, 7)
  eq(res.rows[1].points, 6)
})

test('同分同胜场同 MVP 并列同名次', function () {
  const div = makeDivision([2, 2])
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 10,
      participantsA: ['a1', 'a2'], participantsB: ['b1', 'b2'],
    }),
  ], div, makeSignups(div))

  // a1 a2 都是 3 分 1 胜 0 MVP → 并列第 1；b1 b2 都是 1 分 → 并列第 3
  eq(res.rows[0].rank, 1)
  eq(res.rows[1].rank, 1, '同分应并列')
  eq(res.rows[2].rank, 3, '并列之后名次要跳号')
  eq(res.rows[3].rank, 3)
})

test('报名记录被删的人用占位显示，不崩', function () {
  const div = makeDivision([2, 2])
  const byId = makeSignups(div)
  delete byId.a2                       // 模拟这个人退出后报名记录被清掉
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 10,
      participantsA: ['a1', 'a2'], participantsB: ['b1', 'b2'],
    }),
  ], div, byId)

  eq(rowOf(res, 'a2').name, '(已退出)')
  eq(pointsOf(res, 'a2'), 3, '记录还在就照常算分')
  eq(res.rows.length, 4)
})

test('比赛里出现不在当前分队名单的人 → 忽略，不凭空造行', function () {
  const div = makeDivision([2, 2])
  const res = score.computeStandings([
    match({
      scoreA: 15, scoreB: 10,
      participantsA: ['a1', 'a2', 'ghost'],
      participantsB: ['b1', 'b2'],
      mvpIds: ['ghost2'],
    }),
  ], div, makeSignups(div))

  eq(res.rows.length, 4, '不应多出幽灵行')
  ok(!rowOf(res, 'ghost'), '幽灵不该出现在榜上')
})

test('队伍战绩统计', function () {
  const div = makeDivision([2, 2, 2])
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
  eq(byIdx[0].scoreFor, 15 + 12)
  eq(byIdx[0].scoreAgainst, 10 + 15)
})

test('分值常量就是约定的 3 / 1 / 1', function () {
  eq(score.WIN, 3)
  eq(score.LOSS, 1)
  eq(score.MVP_BONUS, 1)
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
