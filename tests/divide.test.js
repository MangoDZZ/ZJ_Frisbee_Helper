'use strict'

/**
 * 分队算法单元测试。纯 Node，无第三方依赖。
 *
 *   node tests/divide.test.js
 */

const { divide, ERR, WARN, starLevelOf, isStar, weightedCost } =
  require('../miniprogram/utils/divide.js')

// ---------------------------------------------------------------- 测试框架

let passed = 0
const failures = []
let currentName = ''

function test (name, fn) {
  currentName = name
  try {
    fn()
    passed++
  } catch (e) {
    failures.push({ name: name, message: e && e.message ? e.message : String(e) })
  }
}

function ok (cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

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

/** gen(4, 'M', 3) → 4 名 level 3 男性，id 自动编号 */
let idSeq = 0
function gen (count, gender, level, prefix) {
  const out = []
  for (let i = 0; i < count; i++) {
    const id = (prefix || 'p') + (++idSeq)
    out.push({ id: id, name: id, gender: gender, level: level })
  }
  return out
}

function P (id, gender, level) {
  return { id: id, name: id, gender: gender, level: level }
}

function together () {
  return { type: 'together', ids: Array.prototype.slice.call(arguments) }
}

function apart () {
  return { type: 'apart', ids: Array.prototype.slice.call(arguments) }
}

function teamOf (res, id) {
  for (let i = 0; i < res.teams.length; i++) {
    if (res.teams[i].memberIds.indexOf(id) >= 0) return i
  }
  return -1
}

/** 分区规范化：用于判断两次分队结果是否"实质相同" */
function canonical (res) {
  const groups = res.teams.map(function (t) {
    return t.memberIds.slice().sort().join(',')
  })
  groups.sort()
  return groups.join('|')
}

/** 每个用例都该跑的不变量 */
function checkInvariants (res, players, label) {
  const tag = label ? label + ' ' : ''
  ok(res.ok === true, tag + '应当成功，实际错误：' +
    (res.error ? res.error.code + ' ' + res.error.message : '?'))

  // 每人恰好出现一次，无丢失无重复
  const seen = new Map()
  let total = 0
  for (let i = 0; i < res.teams.length; i++) {
    const ids = res.teams[i].memberIds
    for (let j = 0; j < ids.length; j++) {
      ok(!seen.has(ids[j]), tag + '球员重复出现：' + ids[j])
      seen.set(ids[j], i)
      total++
    }
  }
  eq(total, players.length, tag + '总人数')
  for (let i = 0; i < players.length; i++) {
    ok(seen.has(String(players[i].id)), tag + '球员丢失：' + players[i].id)
  }

  // 守恒：人数、性别、水平总和
  let sumCount = 0; let sumF = 0; let sumM = 0; let sumLevel = 0
  for (let i = 0; i < res.teams.length; i++) {
    const s = res.teams[i].stats
    sumCount += s.count
    sumF += s.female
    sumM += s.male
    sumLevel += s.levelSum
  }
  eq(sumCount, players.length, tag + 'Σ队人数')
  eq(sumF, res.stats.femaleTotal, tag + 'Σ女生')
  eq(sumM, res.stats.maleTotal, tag + 'Σ男生')

  // 「高分」的线是这批人里最高的那一档，算法必须自己算出来并回报，
  // 不能是写死的 5 分——否则大多数业余局里这一项形同不存在。
  const allLevels = []
  for (let i = 0; i < res.teams.length; i++) {
    for (let j = 0; j < res.teams[i].members.length; j++) {
      allLevels.push(res.teams[i].members[j].level)
    }
  }
  const starLine = starLevelOf(allLevels)
  eq(res.stats.starLevel, starLine, tag + '回报的高分线')

  // 统计一致性：从 members 重算必须与返回的 stats 完全相等（抓统计漂移）
  for (let i = 0; i < res.teams.length; i++) {
    const t = res.teams[i]
    let c = 0; let m = 0; let f = 0; let u = 0; let ls = 0; let star = 0
    for (let j = 0; j < t.members.length; j++) {
      const p = t.members[j]
      c++
      if (p.gender === 'M') m++
      else if (p.gender === 'F') f++
      else u++
      ls += p.level
      if (isStar(p.level, starLine)) star++
    }
    eq(t.stats.count, c, tag + t.name + ' count')
    eq(t.stats.male, m, tag + t.name + ' male')
    eq(t.stats.female, f, tag + t.name + ' female')
    eq(t.stats.unknown, u, tag + t.name + ' unknown')
    eq(t.stats.levelSum, ls, tag + t.name + ' levelSum')
    eq(t.stats.star, star, tag + t.name + ' star')
    eq(t.members.length, t.memberIds.length, tag + t.name + ' members/memberIds 长度')
    // memberIds 与 members 必须一一对应且同序
    for (let j = 0; j < t.members.length; j++) {
      eq(t.memberIds[j], t.members[j].id, tag + t.name + ' 第 ' + j + ' 项 id 对不上')
    }
  }
  ok(sumLevel === res.teams.reduce(function (a, t) { return a + t.stats.levelSum }, 0),
    tag + 'Σ水平和')

  // 队内名单按姓名排，**不能按水平排**：分队结果要发布给所有人看，
  // 按水平从高到低排等于公开组织者对每个人的评级。这里用中文名，顺带锁住"用拼音序"。
  for (let i = 0; i < res.teams.length; i++) {
    const names = res.teams[i].members.map(function (m) { return m.name })
    const sorted = names.slice().sort(function (a, b) {
      return String(a).localeCompare(String(b), 'zh-Hans-CN')
    })
    deepEq(names, sorted, tag + res.teams[i].name + ' 名单顺序')
  }

  // 代价必须是有限数——NaN 会让择优静默失效
  const cb = res.costBreakdown
  ok(isFinite(cb.size) && isFinite(cb.gender) && isFinite(cb.star) &&
     isFinite(cb.level) && isFinite(cb.total),
  tag + '代价出现 NaN/Infinity：' + JSON.stringify(cb))
  ok(cb.size >= 0 && cb.gender >= 0 && cb.star >= 0 && cb.level >= 0,
    tag + '代价分项不应为负')

  // 展示的明细和用来择优的总分必须是同一套公式。两处各写一遍代价算法时，
  // 改权重漏改一处就会出现"明细看着没问题、实际排序按另一套权重"的静默错误。
  // 明细是保留三位小数的，所以按权重放大后允许这点舍入误差。
  const rounded = weightedCost(cb) // costBreakdown 里已有 total，这里只用四个分项
  ok(Math.abs(rounded - cb.total) <= 0.6,
    tag + '分项加权和 ' + rounded.toFixed(3) + ' 与总代价 ' + cb.total + ' 对不上')
}

function sizes (res) {
  return res.teams.map(function (t) { return t.stats.count }).sort(function (a, b) { return a - b })
}

function femaleCounts (res) {
  return res.teams.map(function (t) { return t.stats.female }).sort(function (a, b) { return a - b })
}

function hasWarning (res, code) {
  return res.warnings.some(function (w) { return w.code === code })
}

// ================================================================ 高分线的口径

test('高分线 = 这批人里最高的那一档（没有 L5 时也生效）', function () {
  // 全员 1-4 档：以前的写死 5 分会让"高分均衡"这一项完全不起作用
  const roster = [4, 4, 3, 3, 3, 3, 2, 2, 1, 1]
  eq(starLevelOf(roster), 4, '最高是 L4')

  const players = []
  for (let i = 0; i < roster.length; i++) players.push(P('p' + i, i % 2 ? 'F' : 'M', roster[i]))
  const res = divide(players, 2, [], 7)
  eq(res.ok, true)
  eq(res.stats.starLevel, 4)
  // 两个 L4 必须分到不同队，否则"高分均衡"白算
  const fours = res.teams.map(function (t) {
    return t.members.filter(function (m) { return m.level === 4 }).length
  })
  deepEq(fours, [1, 1])
})

test('全员同档 → 没有高分，starLevel 为 null，star 人数都是 0', function () {
  // 都填 L3 的局很常见。若把"最高等级"当成高分线，那所有人都是高分，
  // 这一项就退化成"人数均衡"的加权版，和文档写的权重语义对不上。
  eq(starLevelOf([3, 3, 3, 3]), null)
  const players = [P('a', 'M', 3), P('b', 'F', 3), P('c', 'M', 3), P('d', 'F', 3)]
  const res = divide(players, 2, [], 3)
  eq(res.ok, true)
  eq(res.stats.starLevel, null)
  eq(res.costBreakdown.star, 0, '没有高分时这一项必须是 0')
  for (let i = 0; i < res.teams.length; i++) eq(res.teams[i].stats.star, 0)
})

test('高分线忽略非法等级，且只在有效等级里取最高', function () {
  eq(starLevelOf([0, 4, 9, 3]), 4, '0 和 9 不是有效等级')
  eq(starLevelOf([]), null)
  eq(starLevelOf([5]), null, '只有一个有效等级 = 同档 → 没有高分')
  eq(starLevelOf([1, 5]), 5)
  ok(isStar(5, 5) && !isStar(4, 5))
  ok(!isStar(5, null), '没有分档时谁都不算高分')
})

test('L5 在场时高分线才是 5（与改动前的行为一致）', function () {
  const players = [P('a', 'M', 5), P('b', 'F', 5), P('c', 'M', 4), P('d', 'F', 3)]
  const res = divide(players, 2, [], 11)
  eq(res.stats.starLevel, 5)
  const stars = res.teams.map(function (t) { return t.stats.star })
  deepEq(stars.sort(), [1, 1], '两个 L5 要分开')
})

// ================================================================ 退化与边界

test('N=0, K=3 → 3 个空队，代价非 NaN', function () {
  const res = divide([], 3, [], 1)
  checkInvariants(res, [], 'N=0')
  eq(res.teams.length, 3)
  deepEq(sizes(res), [0, 0, 0])
  ok(hasWarning(res, WARN.EMPTY_TEAMS), '应有空队 warning')
})

test('N=1, K=1 → 平凡通过', function () {
  const players = [P('a', 'M', 3)]
  const res = divide(players, 1, [], 1)
  checkInvariants(res, players, 'N=1')
  deepEq(sizes(res), [1])
})

test('K=1, N=10 → 全部一队', function () {
  const players = gen(10, 'M', 3)
  const res = divide(players, 1, [], 7)
  checkInvariants(res, players, 'K=1')
  eq(res.teams.length, 1)
  eq(res.teams[0].stats.count, 10)
})

test('K=1 且存在 apart → 不崩不挂起，warning 忽略约束', function () {
  const players = [P('a', 'M', 3), P('b', 'M', 3)]
  const res = divide(players, 1, [apart('a', 'b')], 7)
  checkInvariants(res, players, 'K=1+apart')
  eq(res.teams.length, 1)
  ok(hasWarning(res, WARN.APART_IGNORED_SINGLE_TEAM), '应提示拆开约束被忽略')
})

test('K 非法（0 / -1 / 2.5 / null / 字符串）→ 校验错误', function () {
  const players = gen(4, 'M', 3)
  const bad = [0, -1, 2.5, null, undefined, '3', NaN, Infinity]
  for (let i = 0; i < bad.length; i++) {
    const res = divide(players, bad[i], [], 1)
    eq(res.ok, false, 'teamCount=' + String(bad[i]) + ' 应被拒绝')
    eq(res.error.code, ERR.INVALID_TEAM_COUNT, 'teamCount=' + String(bad[i]))
  }
})

test('players 不是数组 → 校验错误', function () {
  const res = divide(null, 2, [], 1)
  eq(res.ok, false)
  eq(res.error.code, ERR.INVALID_PLAYERS)
})

test('K > N（N=3, K=5）→ 3 个单人队 + 2 空队，代价非 NaN', function () {
  const players = gen(3, 'M', 3)
  const res = divide(players, 5, [], 11)
  checkInvariants(res, players, 'K>N')
  deepEq(sizes(res), [0, 0, 1, 1, 1])
  ok(hasWarning(res, WARN.EMPTY_TEAMS), '应提示会有空队')
})

test('球员 id 重复 → DUPLICATE_PLAYER', function () {
  const res = divide([P('a', 'M', 3), P('a', 'F', 4)], 2, [], 1)
  eq(res.ok, false)
  eq(res.error.code, ERR.DUPLICATE_PLAYER)
  ok(res.error.message.indexOf('a') >= 0, '错误信息应含重复的 id')
})

test('球员缺少 id → INVALID_PLAYER', function () {
  const res = divide([{ gender: 'M', level: 3 }], 2, [], 1)
  eq(res.ok, false)
  eq(res.error.code, ERR.INVALID_PLAYER)
})

// ================================================================ 人数均衡

test('N=10, K=3（不整除）→ 人数恰为 {3,3,4}', function () {
  const players = gen(10, 'M', 3)
  const res = divide(players, 3, [], 3)
  checkInvariants(res, players, 'N=10 K=3')
  deepEq(sizes(res), [3, 3, 4])
})

test('N=12, K=4 → 每队恰好 3 人', function () {
  const players = gen(12, 'M', 3)
  const res = divide(players, 4, [], 5)
  checkInvariants(res, players, 'N=12 K=4')
  deepEq(sizes(res), [3, 3, 3, 3])
})

test('多种 N/K 组合下人数极差恒 ≤ 1（无约束）', function () {
  for (let n = 1; n <= 40; n++) {
    for (let k = 1; k <= 8; k++) {
      const players = gen(n, n % 2 ? 'M' : 'F', 3)
      const res = divide(players, k, [], n * 100 + k, { restarts: 30 })
      ok(res.ok, 'N=' + n + ' K=' + k + ' 失败')
      ok(res.stats.sizeSpread <= 1, 'N=' + n + ' K=' + k + ' 人数极差 ' + res.stats.sizeSpread)
    }
  }
})

test('各性别余数不得重叠到同一队（N=15, K=8, 5女10男）', function () {
  // 回归用例：女的 5 个余数队与男的 2 个余数队若重叠，那队会变成 3 人而另一队 1 人，
  // 而两种摆法的 genderTerm 完全相同——所以必须有独立的人数项才分得出好坏。
  const players = gen(10, 'M', 3).concat(gen(5, 'F', 3))
  for (let s = 1; s <= 40; s++) {
    const res = divide(players, 8, [], s, { restarts: 40 })
    checkInvariants(res, players, '余数重叠 seed=' + s)
    eq(res.stats.sizeSpread, 1, 'seed=' + s + ' 人数应为 7 个 2 人 + 1 个 1 人')
    ok(res.stats.femaleSpread <= 1, 'seed=' + s + ' 女生极差 ' + res.stats.femaleSpread)
  }
})

test('各性别互质余数组合下人数极差恒 ≤ 1', function () {
  const cases = [
    [10, 5, 8], [7, 6, 4], [13, 11, 5], [9, 9, 6], [17, 3, 7], [11, 7, 3],
  ]
  for (let i = 0; i < cases.length; i++) {
    const m = cases[i][0]; const f = cases[i][1]; const k = cases[i][2]
    const players = gen(m, 'M', 3).concat(gen(f, 'F', 3))
    for (let s = 1; s <= 10; s++) {
      const res = divide(players, k, [], s, { restarts: 40 })
      const label = m + '男' + f + '女/' + k + '队 seed=' + s
      checkInvariants(res, players, label)
      ok(res.stats.sizeSpread <= 1, label + ' 人数极差 ' + res.stats.sizeSpread)
      ok(res.stats.femaleSpread <= 1, label + ' 女生极差 ' + res.stats.femaleSpread)
    }
  }
})

test('存在 3 人同队 pod 时人数仍均衡（N=12, K=4）', function () {
  const players = gen(12, 'M', 3)
  const ids = players.slice(0, 3).map(function (p) { return p.id })
  const res = divide(players, 4, [together(ids[0], ids[1], ids[2])], 9)
  checkInvariants(res, players, 'pod+均衡')
  deepEq(sizes(res), [3, 3, 3, 3])
  eq(teamOf(res, ids[0]), teamOf(res, ids[1]))
  eq(teamOf(res, ids[1]), teamOf(res, ids[2]))
})

// ================================================================ 性别均衡

test('N=24, K=4, 12男12女 → 每队恰好 3男3女', function () {
  const players = gen(12, 'M', 3).concat(gen(12, 'F', 3))
  const res = divide(players, 4, [], 13)
  checkInvariants(res, players, '性别均衡')
  deepEq(sizes(res), [6, 6, 6, 6])
  deepEq(femaleCounts(res), [3, 3, 3, 3])
  for (let i = 0; i < res.teams.length; i++) eq(res.teams[i].stats.male, 3)
})

test('N=12, K=4, 2女10男（女生少于队数）→ 女生数 {0,0,1,1}，有 warning 且不报错', function () {
  const players = gen(10, 'M', 3).concat(gen(2, 'F', 3))
  const res = divide(players, 4, [], 17)
  checkInvariants(res, players, 'F<K')
  deepEq(femaleCounts(res), [0, 0, 1, 1])
  ok(hasWarning(res, WARN.FEWER_FEMALES_THAN_TEAMS), '应提示女生不足')
})

test('F=0 全男 → 正常出结果', function () {
  const players = gen(16, 'M', 3)
  const res = divide(players, 4, [], 19)
  checkInvariants(res, players, 'F=0')
  deepEq(femaleCounts(res), [0, 0, 0, 0])
  ok(!hasWarning(res, WARN.FEWER_FEMALES_THAN_TEAMS), '没有女生时不该提示女生不足')
})

test('性别字段缺失 / 空串 / "其他" → 归为未知类，不崩，有 warning', function () {
  const players = [
    { id: 'a', level: 3 },
    { id: 'b', gender: '', level: 3 },
    { id: 'c', gender: '其他', level: 3 },
    { id: 'd', gender: null, level: 3 },
  ]
  const res = divide(players, 2, [], 23)
  checkInvariants(res, players, '性别未知')
  eq(res.stats.unknownTotal, 4)
  deepEq(sizes(res), [2, 2])
  ok(hasWarning(res, WARN.GENDER_UNKNOWN), '应提示性别缺失')
})

test('性别写法兼容 男/女/male/female/大小写', function () {
  const players = [
    P('a', '男', 3), P('b', 'MALE', 3), P('c', 'm', 3),
    P('d', '女', 3), P('e', 'Female', 3), P('f', 'F', 3),
  ]
  const res = divide(players, 2, [], 29)
  checkInvariants(res, players, '性别写法')
  eq(res.stats.maleTotal, 3)
  eq(res.stats.femaleTotal, 3)
  eq(res.stats.unknownTotal, 0)
})

// ================================================================ 水平均衡

test('全员同水平 → 水平项为 0，且不同 seed 产生不同分队', function () {
  const players = gen(24, 'M', 3)
  const seen = new Set()
  for (let s = 1; s <= 20; s++) {
    const res = divide(players, 4, [], s, { restarts: 30 })
    checkInvariants(res, players, '同水平 seed=' + s)
    eq(res.costBreakdown.level, 0, 'seed=' + s + ' 水平项应为 0')
    seen.add(canonical(res))
  }
  ok(seen.size >= 2, '全员同水平时应有随机性，实际只有 ' + seen.size + ' 种结果')
})

test('4 个 level5 + 20 个 level1, K=4 → 每队恰好 1 个高分球员', function () {
  const players = gen(4, 'M', 5).concat(gen(20, 'M', 1))
  for (let s = 1; s <= 20; s++) {
    const res = divide(players, 4, [], s, { restarts: 30 })
    checkInvariants(res, players, '明星均衡 seed=' + s)
    for (let i = 0; i < res.teams.length; i++) {
      eq(res.teams[i].stats.star, 1, 'seed=' + s + ' ' + res.teams[i].name + ' 高分球员数')
    }
    eq(res.costBreakdown.star, 0, 'seed=' + s + ' 明星项应为 0')
  }
})

test('水平总和均衡：混合水平名单的队均水平极差很小', function () {
  const players = gen(6, 'M', 5).concat(gen(6, 'M', 4), gen(6, 'M', 2), gen(6, 'M', 1))
  const res = divide(players, 4, [], 31)
  checkInvariants(res, players, '水平总和')
  ok(res.stats.avgLevelSpread <= 0.35, '队均水平极差过大：' + res.stats.avgLevelSpread)
})

test('水平缺失 / 0 / 6 / 3.5 → clamp 到 1-5，无 NaN，有 warning', function () {
  const players = [
    { id: 'a', gender: 'M' },
    { id: 'b', gender: 'M', level: 0 },
    { id: 'c', gender: 'M', level: 6 },
    { id: 'd', gender: 'M', level: 3.5 },
    { id: 'e', gender: 'M', level: 'x' },
    { id: 'f', gender: 'M', level: null },
  ]
  const res = divide(players, 2, [], 37)
  checkInvariants(res, players, '水平异常')
  ok(hasWarning(res, WARN.LEVEL_FIXED), '应提示水平被修正')
  for (let i = 0; i < res.teams.length; i++) {
    const ms = res.teams[i].members
    for (let j = 0; j < ms.length; j++) {
      ok(ms[j].level >= 1 && ms[j].level <= 5, '水平越界：' + ms[j].level)
      ok(Number.isInteger(ms[j].level), '水平非整数：' + ms[j].level)
    }
  }
})

test('adminLevel 覆盖 selfLevel', function () {
  const players = [
    { id: 'a', gender: 'M', selfLevel: 1, adminLevel: 5 },
    { id: 'b', gender: 'M', selfLevel: 1 },
  ]
  const res = divide(players, 2, [], 41)
  checkInvariants(res, players, 'adminLevel')
  const a = res.teams[teamOf(res, 'a')].members.filter(function (m) { return m.id === 'a' })[0]
  eq(a.level, 5, 'adminLevel 应覆盖 selfLevel')
})

// ================================================================ together

test('单对 together → 同队（多 seed 验证）', function () {
  const players = gen(16, 'M', 3)
  const a = players[0].id; const b = players[1].id
  for (let s = 1; s <= 30; s++) {
    const res = divide(players, 4, [together(a, b)], s, { restarts: 20 })
    checkInvariants(res, players, 'together seed=' + s)
    eq(teamOf(res, a), teamOf(res, b), 'seed=' + s + ' 应同队')
  }
})

test('传递链 a-b, b-c, c-d → 四人同队，pod 大小 4', function () {
  const players = gen(16, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 4, [
    together(id[0], id[1]), together(id[1], id[2]), together(id[2], id[3]),
  ], 43)
  checkInvariants(res, players, '传递链')
  const t = teamOf(res, id[0])
  eq(teamOf(res, id[1]), t)
  eq(teamOf(res, id[2]), t)
  eq(teamOf(res, id[3]), t)
  eq(res.stats.podCount, 13, '16 人合并 4 人后应有 13 个可分配单元')
})

test('pod 大小恰等于单队均摊人数 → 该队恰为该 pod（off-by-one）', function () {
  const players = gen(12, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 4, [together(id[0], id[1], id[2])], 47)
  checkInvariants(res, players, 'pod==cap')
  ok(!hasWarning(res, WARN.POD_OVER_CAPACITY), 'pod 恰好等于均摊人数时不该报超额')
  const t = teamOf(res, id[0])
  deepEq(res.teams[t].memberIds.slice().sort(), [id[0], id[1], id[2]].sort(),
    '该队应恰好是这个 pod')
})

test('pod 大小超过单队均摊人数 → warning 但正常返回', function () {
  const players = gen(12, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 4, [together(id[0], id[1], id[2], id[3], id[4])], 53)
  checkInvariants(res, players, 'pod>cap')
  ok(hasWarning(res, WARN.POD_OVER_CAPACITY), '应提示 pod 超额')
  const t = teamOf(res, id[0])
  ok(res.teams[t].stats.count >= 5, '该队至少包含这 5 人')
})

test('两个 4 人 pod（K=4, N=16）→ 分到不同队且人数均衡', function () {
  const players = gen(8, 'M', 3, 'm').concat(gen(8, 'F', 3, 'f'))
  const m = players.slice(0, 8).map(function (p) { return p.id })
  const f = players.slice(8).map(function (p) { return p.id })
  const res = divide(players, 4, [
    together(m[0], m[1], f[0], f[1]),
    together(m[2], m[3], f[2], f[3]),
  ], 59)
  checkInvariants(res, players, '双大 pod')
  ok(teamOf(res, m[0]) !== teamOf(res, m[2]), '两个大 pod 应分到不同队')
  deepEq(sizes(res), [4, 4, 4, 4])
})

// ================================================================ apart

test('单对 apart → 不同队，50 个 seed 全部满足', function () {
  const players = gen(16, 'M', 3)
  const a = players[0].id; const b = players[1].id
  for (let s = 1; s <= 50; s++) {
    const res = divide(players, 4, [apart(a, b)], s, { restarts: 20 })
    checkInvariants(res, players, 'apart seed=' + s)
    ok(teamOf(res, a) !== teamOf(res, b), 'seed=' + s + ' 应拆开')
  }
})

test('apart 提升到 pod 级：pod{a,b} 与 pod{c,d} 间 apart(a,c) → b 与 d 也被分开', function () {
  const players = gen(16, 'M', 3)
  const id = players.map(function (p) { return p.id })
  for (let s = 1; s <= 30; s++) {
    const res = divide(players, 4, [
      together(id[0], id[1]),
      together(id[2], id[3]),
      apart(id[0], id[2]),
    ], s, { restarts: 20 })
    checkInvariants(res, players, 'pod级apart seed=' + s)
    eq(teamOf(res, id[0]), teamOf(res, id[1]), 'seed=' + s + ' a,b 应同队')
    eq(teamOf(res, id[2]), teamOf(res, id[3]), 'seed=' + s + ' c,d 应同队')
    ok(teamOf(res, id[0]) !== teamOf(res, id[2]), 'seed=' + s + ' a,c 应拆开')
    ok(teamOf(res, id[1]) !== teamOf(res, id[3]), 'seed=' + s + ' b,d 也必须被分开')
  }
})

test('together 与 apart 指向同一对 → APART_IN_SAME_POD，错误信息含双方姓名', function () {
  const players = [
    { id: 'a', name: '张三', gender: 'M', level: 3 },
    { id: 'b', name: '李四', gender: 'M', level: 3 },
    P('c', 'M', 3), P('d', 'M', 3),
  ]
  const res = divide(players, 2, [together('a', 'b'), apart('a', 'b')], 61)
  eq(res.ok, false)
  eq(res.error.code, ERR.APART_IN_SAME_POD)
  ok(res.error.message.indexOf('张三') >= 0 && res.error.message.indexOf('李四') >= 0,
    '错误信息应含双方姓名，实际：' + res.error.message)
})

test('传递性冲突：together(a,b)+together(b,c)+apart(a,c) → APART_IN_SAME_POD', function () {
  const players = gen(6, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 2, [
    together(id[0], id[1]), together(id[1], id[2]), apart(id[0], id[2]),
  ], 67)
  eq(res.ok, false)
  eq(res.error.code, ERR.APART_IN_SAME_POD)
})

test('K=2 但三人互为 apart（团大小 3 > K）→ 检出不可行，不挂起', function () {
  const players = gen(10, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 2, [
    apart(id[0], id[1]), apart(id[1], id[2]), apart(id[0], id[2]),
  ], 71)
  eq(res.ok, false)
  eq(res.error.code, ERR.APART_INFEASIBLE)
})

test('三人互为 apart 但 K=3 → 可行', function () {
  const players = gen(9, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 3, [
    apart(id[0], id[1]), apart(id[1], id[2]), apart(id[0], id[2]),
  ], 73)
  checkInvariants(res, players, '3互斥K=3')
  ok(teamOf(res, id[0]) !== teamOf(res, id[1]))
  ok(teamOf(res, id[1]) !== teamOf(res, id[2]))
  ok(teamOf(res, id[0]) !== teamOf(res, id[2]))
})

test('apart 单个约束含 3 人 → 两两拆开', function () {
  const players = gen(9, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 3, [apart(id[0], id[1], id[2])], 79)
  checkInvariants(res, players, 'apart三人组')
  const ts = [teamOf(res, id[0]), teamOf(res, id[1]), teamOf(res, id[2])].sort()
  deepEq(ts, [0, 1, 2], '三人应各在一队')
})

test('apart 自环 apart(a,a) → APART_SELF', function () {
  const players = gen(4, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 2, [apart(id[0], id[0])], 83)
  eq(res.ok, false)
  eq(res.error.code, ERR.APART_SELF)
})

test('together 自环 together(a,a) → 正常忽略', function () {
  const players = gen(4, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const res = divide(players, 2, [together(id[0], id[0])], 89)
  checkInvariants(res, players, 'together自环')
  deepEq(sizes(res), [2, 2])
})

test('约束引用不存在的球员 → UNKNOWN_PLAYER，错误信息带上该 id', function () {
  const players = gen(4, 'M', 3)
  const id = players.map(function (p) { return p.id })

  const r1 = divide(players, 2, [together(id[0], 'ghost-1')], 97)
  eq(r1.ok, false)
  eq(r1.error.code, ERR.UNKNOWN_PLAYER)
  ok(r1.error.message.indexOf('ghost-1') >= 0, '错误信息应含 ghost-1')

  const r2 = divide(players, 2, [apart(id[0], 'ghost-2')], 97)
  eq(r2.ok, false)
  eq(r2.error.code, ERR.UNKNOWN_PLAYER)
  ok(r2.error.message.indexOf('ghost-2') >= 0, '错误信息应含 ghost-2')
})

test('贪心死锁反例 K=2 N=6 apart(a,b),(a,c),(a,d) → 200 个 seed 全部返回合法解', function () {
  const players = [
    P('a', 'M', 3), P('b', 'M', 3), P('c', 'M', 3),
    P('d', 'M', 3), P('e', 'M', 3), P('f', 'M', 3),
  ]
  const cons = [apart('a', 'b'), apart('a', 'c'), apart('a', 'd')]
  for (let s = 1; s <= 200; s++) {
    const res = divide(players, 2, cons, s, { restarts: 20 })
    ok(res.ok, 'seed=' + s + ' 应有解，实际：' +
      (res.error ? res.error.code + ' ' + res.error.message : '?'))
    const ta = teamOf(res, 'a')
    ok(teamOf(res, 'b') !== ta, 'seed=' + s + ' a,b 应拆开')
    ok(teamOf(res, 'c') !== ta, 'seed=' + s + ' a,c 应拆开')
    ok(teamOf(res, 'd') !== ta, 'seed=' + s + ' a,d 应拆开')
    // 已知最优是 3/3；软化人数约束后应该能达到
    deepEq(sizes(res), [3, 3], 'seed=' + s + ' 应达到 3/3')
  }
})

// ================================================================ 随机性与可复现

test('同 seed 跑 100 次结果逐字节相同', function () {
  const players = gen(30, 'M', 3).concat(gen(18, 'F', 4))
  const first = JSON.stringify(divide(players, 6, [], 12345))
  for (let i = 0; i < 100; i++) {
    const again = JSON.stringify(divide(players, 6, [], 12345))
    ok(again === first, '第 ' + i + ' 次结果与首次不同，seed 复现失效')
  }
})

test('同 seed 在有约束时同样可复现', function () {
  const players = gen(20, 'M', 3).concat(gen(12, 'F', 5))
  const id = players.map(function (p) { return p.id })
  const cons = [together(id[0], id[1]), apart(id[2], id[3]), together(id[4], id[5], id[6])]
  const first = JSON.stringify(divide(players, 4, cons, 987654))
  for (let i = 0; i < 30; i++) {
    eq(JSON.stringify(divide(players, 4, cons, 987654)), first, '第 ' + i + ' 次不一致')
  }
})

test('未指定 seed 时返回实际使用的 seed，且回填该 seed 可复现', function () {
  const players = gen(20, 'M', 3).concat(gen(12, 'F', 4))
  const res = divide(players, 4, [])
  checkInvariants(res, players, '自动 seed')
  ok(typeof res.seed === 'number' && isFinite(res.seed), 'seed 应是有限数字')
  const replay = divide(players, 4, [], res.seed)
  eq(canonical(replay), canonical(res), '回填 seed 应复现同一分队')
})

test('50 个不同 seed 在对称名单上产生足够多的不同分区', function () {
  const players = []
  for (let i = 0; i < 12; i++) players.push(P('m' + i, 'M', 1 + (i % 5)))
  for (let i = 0; i < 12; i++) players.push(P('f' + i, 'F', 1 + (i % 5)))
  const seen = new Set()
  for (let s = 1; s <= 50; s++) {
    const res = divide(players, 4, [], s, { restarts: 30 })
    checkInvariants(res, players, '多样性 seed=' + s)
    seen.add(canonical(res))
  }
  ok(seen.size >= 30, '50 个 seed 只产生了 ' + seen.size + ' 种分区，随机性不足')
})

// ================================================================ 模糊测试

test('模糊测试：500 组随机名单，约束由构造保证可满足', function () {
  // 自带 LCG，让模糊测试自身也可复现
  let st = 20260924
  function rnd () {
    st = (Math.imul(st, 1103515245) + 12345) >>> 0
    return st / 4294967296
  }
  function pick (n) { return Math.floor(rnd() * n) }

  for (let iter = 0; iter < 500; iter++) {
    const n = 4 + pick(57)          // 4..60
    const k = 2 + pick(7)           // 2..8
    const players = []
    for (let i = 0; i < n; i++) {
      const g = rnd() < 0.45 ? 'F' : 'M'
      players.push(P('x' + i, g, 1 + pick(5)))
    }

    // 先随机分一个区，再从同区取 together、跨区取 apart，保证存在可行解
    const group = []
    for (let i = 0; i < n; i++) group.push(pick(k))
    const byGroup = []
    for (let g = 0; g < k; g++) byGroup.push([])
    for (let i = 0; i < n; i++) byGroup[group[i]].push(i)

    const cons = []
    const togetherPairs = pick(4)
    for (let t = 0; t < togetherPairs; t++) {
      const g = byGroup[pick(k)]
      if (g.length < 2) continue
      const a = g[pick(g.length)]; const b = g[pick(g.length)]
      if (a !== b) cons.push(together(players[a].id, players[b].id))
    }
    const apartPairs = pick(4)
    for (let t = 0; t < apartPairs; t++) {
      const ga = pick(k); let gb = pick(k)
      if (ga === gb) gb = (gb + 1) % k
      if (byGroup[ga].length === 0 || byGroup[gb].length === 0) continue
      const a = byGroup[ga][pick(byGroup[ga].length)]
      const b = byGroup[gb][pick(byGroup[gb].length)]
      cons.push(apart(players[a].id, players[b].id))
    }

    const label = 'fuzz#' + iter + '(n=' + n + ',k=' + k + ')'
    const t0 = Date.now()
    const res = divide(players, k, cons, iter + 1, { restarts: 60 })
    const ms = Date.now() - t0
    checkInvariants(res, players, label)
    ok(ms < 500, label + ' 耗时 ' + ms + 'ms')

    // 硬约束必须 100% 满足
    for (let c = 0; c < cons.length; c++) {
      const ids = cons[c].ids
      const t1 = teamOf(res, ids[0])
      const t2 = teamOf(res, ids[1])
      if (cons[c].type === 'together') {
        eq(t1, t2, label + ' together 未满足：' + ids.join(','))
      } else {
        ok(t1 !== t2, label + ' apart 未满足：' + ids.join(','))
      }
    }

    // 无 together 约束时人数极差必须 ≤ 1
    const hasTogether = cons.some(function (c) { return c.type === 'together' })
    if (!hasTogether) {
      ok(res.stats.sizeSpread <= 1, label + ' 人数极差 ' + res.stats.sizeSpread)
    }
  }
})

// ================================================================ 性能与健壮性

// 性能要求来自使用场景：算法在组织者手机上同步跑，点「分队」必须即时响应。
// 俱乐部规模（≤60 人）是真实目标，必须快；200 人已超出场景，只要不卡死就行。
// 阈值按本机耗时留了约 4 倍余量给手机。
test('俱乐部规模 60人/6队 带约束 → 400ms 内完成', function () {
  const players = []
  for (let i = 0; i < 36; i++) players.push(P('m' + i, 'M', 1 + (i % 5)))
  for (let i = 0; i < 24; i++) players.push(P('f' + i, 'F', 1 + (i % 5)))
  const cons = []
  for (let i = 0; i < 6; i++) cons.push(together('m' + (i * 2), 'm' + (i * 2 + 1)))
  for (let i = 0; i < 3; i++) cons.push(apart('f' + i, 'f' + (i + 3)))

  const t0 = Date.now()
  const res = divide(players, 6, cons, 1001)
  const ms = Date.now() - t0
  checkInvariants(res, players, 'perf-60')
  ok(res.stats.sizeSpread <= 1, '人数极差 ' + res.stats.sizeSpread)
  ok(ms < 400, '耗时 ' + ms + 'ms，超过 400ms')
})

test('极端规模 200人/10队 各 20 对约束 → 不卡死（3 秒内）', function () {
  const players = []
  for (let i = 0; i < 120; i++) players.push(P('m' + i, 'M', 1 + (i % 5)))
  for (let i = 0; i < 80; i++) players.push(P('f' + i, 'F', 1 + (i % 5)))
  const cons = []
  for (let i = 0; i < 20; i++) cons.push(together('m' + (i * 2), 'm' + (i * 2 + 1)))
  for (let i = 0; i < 20; i++) cons.push(apart('f' + i, 'f' + (i + 20)))

  const t0 = Date.now()
  const res = divide(players, 10, cons, 1001)
  const ms = Date.now() - t0
  checkInvariants(res, players, 'perf-200')
  ok(ms < 3000, '耗时 ' + ms + 'ms，超过 3 秒')
})

test('并查集 200 节点长链不爆栈', function () {
  const players = gen(200, 'M', 3)
  const id = players.map(function (p) { return p.id })
  const cons = []
  for (let i = 0; i + 1 < 200; i++) cons.push(together(id[i], id[i + 1]))
  const res = divide(players, 4, cons, 1009, { restarts: 5 })
  checkInvariants(res, players, '长链')
  eq(res.stats.podCount, 1, '整条链应合并成 1 个单元')
  eq(res.teams[teamOf(res, id[0])].stats.count, 200, '200 人应全在一队')
})

// ================================================================ 输出契约

test('avgLevelSpread 不把空队的 0 算进极差', function () {
  // 3 人 5 队：2 个空队。若把空队均分 0 计入，极差会虚高到 5，而水平只有 1-5。
  const players = [P('a', 'M', 5), P('b', 'M', 5), P('c', 'M', 5)]
  const res = divide(players, 5, [], 1021)
  checkInvariants(res, players, '空队均分')
  eq(res.stats.avgLevelSpread, 0, '三名同水平球员的非空队之间极差应为 0')

  const none = divide([], 3, [], 1021)
  eq(none.stats.avgLevelSpread, 0, '全空队时极差应为 0 而不是负数')
})

test('返回结构完整：teams / stats / seed / costBreakdown / warnings', function () {
  const players = gen(12, 'M', 3).concat(gen(12, 'F', 4))
  const res = divide(players, 4, [], 1013)
  checkInvariants(res, players, '输出契约')
  eq(res.teams.length, 4)
  for (let i = 0; i < res.teams.length; i++) {
    const t = res.teams[i]
    eq(t.index, i)
    ok(typeof t.name === 'string' && t.name.length > 0, '队名缺失')
    ok(Array.isArray(t.memberIds) && Array.isArray(t.members))
    ok(t.stats && typeof t.stats.avgLevel === 'number')
  }
  ok(res.stats.playerCount === 24 && res.stats.teamCount === 4)
  ok(Array.isArray(res.warnings))
  ok(res.costBreakdown && typeof res.costBreakdown.total === 'number')
})

test('队内名单按姓名排列，不泄露水平', function () {
  // 水平故意和姓名顺序相反：如果还是按水平排，这里会变成 [d, c, b, a]
  const players = [P('a', 'M', 1), P('b', 'M', 5), P('c', 'M', 3), P('d', 'M', 4)]
  const res = divide(players, 1, [], 1019)
  checkInvariants(res, players, '展示顺序')
  const names = res.teams[0].members.map(function (m) { return m.name })
  eq(names.join(','), 'a,b,c,d', '队内名单应按姓名（拼音/码位）升序')
  deepEq(res.teams[0].memberIds, res.teams[0].members.map(function (m) { return m.id }),
    'memberIds 必须跟着 members 一起排')
})

// ---------------------------------------------------------------- 汇总

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
  console.log('')
  process.exit(1)
}
