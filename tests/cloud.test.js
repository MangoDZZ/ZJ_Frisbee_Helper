'use strict'

/**
 * 云函数逻辑测试。用内存替身顶掉 wx-server-sdk，在本机把三个云函数真跑一遍。
 *
 *   node tests/cloud.test.js
 *
 * 重点覆盖两类"错了不会报错、只会静默出问题"的地方：
 *  1. 权限：参与者能不能读到别人的手机号、能不能调管理接口
 *  2. 并发：报名会不会超出人数上限
 */

const path = require('path')
const Module = require('module')

// 让 require('wx-server-sdk') 解析到内存替身
const mockPath = require.resolve('./mock-wx-server-sdk.js')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request) {
  if (request === 'wx-server-sdk') return mockPath
  return originalResolve.apply(this, arguments)
}

const mockSdk = require('./mock-wx-server-sdk.js')
const mock = mockSdk.__mock

// 云函数导出的是 { main }，测试里直接调 main
const hatEvent = require('../cloudfunctions/hat-event/index.js').main
const hatSignup = require('../cloudfunctions/hat-signup/index.js').main
const hatTeam = require('../cloudfunctions/hat-team/index.js').main
const hatMatch = require('../cloudfunctions/hat-match/index.js').main
const hatAdmin = require('../cloudfunctions/hat-admin/index.js').main

// ---------------------------------------------------------------- 测试框架

let passed = 0
const failures = []

async function test(name, fn) {
  mock.reset()
  try {
    await fn()
    passed++
  } catch (e) {
    failures.push({ name: name, message: (e && e.message) || String(e) })
  }
}

function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败') }

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + '：' : '') + '期望 ' + JSON.stringify(expected) +
      '，实际 ' + JSON.stringify(actual))
  }
}

// ---------------------------------------------------------------- 调用助手

const OWNER = 'openid-owner'
// 必须与各云函数 lib/roles.js 里的 ADMIN_OPENIDS 一致
const ADMIN = 'oKkBt3SP024_uuaA3MUik9oP43h8'
const ALICE = 'openid-alice'
const BOB = 'openid-bob'
function as(openid, fn, action, data) {
  mock.setOpenid(openid)
  return fn({ action: action, data: data || {} })
}

async function expectOk(p, msg) {
  const r = await p
  ok(r.ok, (msg || '应当成功') + '，实际：' +
    (r.error ? r.error.code + ' ' + r.error.message : '?'))
  return r.data
}

async function expectErr(p, code, msg) {
  const r = await p
  ok(!r.ok, (msg || '应当失败') + '，但实际成功了')
  if (code) eq(r.error.code, code, msg || '错误码')
  return r.error
}

const DAY = 86400000

function eventForm(over) {
  return Object.assign({
    name: '周六晚 HAT 局',
    location: '城市体育公园 3 号场',
    teamCount: 4,
    capacity: 24,
    startTime: Date.now() + 3 * DAY,
    endTime: Date.now() + 3 * DAY + 7200000,
    signupDeadline: Date.now() + 2 * DAY,
    notes: '带深浅两色球衣',
  }, over || {})
}

function signupForm(over) {
  return Object.assign({
    name: '张三', gender: 'M', selfLevel: 3, phone: '13800000000', remark: '',
  }, over || {})
}

async function createEvent(over) {
  // 只有组织者能发起活动，所以建活动前先把 OWNER 设成组织者。
  // 每个用例开始时 mock 会 reset，所以这里每次都设一遍。
  grantOrganizer(OWNER)
  const d = await expectOk(as(OWNER, hatEvent, 'create', eventForm(over)), '建活动')
  return d._id
}

/** 直接往 roles 集合里写一条组织者记录（走 setOrganizer 得先有管理员，绕一圈没必要）。 */
function grantOrganizer(openid, name) {
  mock.insert('roles', {
    openid: openid, role: 'organizer', name: name || '测试组织者', createTime: Date.now(),
  })
}

// ================================================================ 活动

const tests = []
function add(name, fn) { tests.push({ name: name, fn: fn }) }

add('创建活动：写入初始状态与名额', async function () {
  const id = await createEvent()
  const doc = mock.get('events', id)
  eq(doc.status, 'open')
  eq(doc.signupCount, 0)
  eq(doc.remaining, 24)
  eq(doc.ownerOpenid, OWNER, '创建者应当是调用方')
})

add('创建活动：表单校验', async function () {
  grantOrganizer(OWNER)
  await expectErr(as(OWNER, hatEvent, 'create', eventForm({ name: '  ' })),
    'INVALID_INPUT', '空名称')
  await expectErr(as(OWNER, hatEvent, 'create', eventForm({ teamCount: 1 })),
    'INVALID_INPUT', '队伍数 1')
  await expectErr(as(OWNER, hatEvent, 'create', eventForm({ teamCount: 2.5 })),
    'INVALID_INPUT', '队伍数非整数')
  await expectErr(as(OWNER, hatEvent, 'create', eventForm({ capacity: 3, teamCount: 4 })),
    'INVALID_INPUT', '人数上限小于队伍数')
  await expectErr(as(OWNER, hatEvent, 'create', eventForm({ startTime: null })),
    'INVALID_INPUT', '缺开始时间')
  await expectErr(as(OWNER, hatEvent, 'create',
    eventForm({ endTime: Date.now() })), 'INVALID_INPUT', '结束早于开始')
  await expectErr(as(OWNER, hatEvent, 'create',
    eventForm({ signupDeadline: Date.now() + 10 * DAY })),
    'INVALID_INPUT', '截止晚于开始')
})

add('非创建者不能改活动、不能关报名、不能删活动', async function () {
  const id = await createEvent()
  await expectErr(as(ALICE, hatEvent, 'update', Object.assign({ eventId: id }, eventForm())),
    'FORBIDDEN', '改活动')
  await expectErr(as(ALICE, hatEvent, 'closeSignup', { eventId: id }), 'FORBIDDEN', '关报名')
  await expectErr(as(ALICE, hatEvent, 'remove', { eventId: id }), 'FORBIDDEN', '删活动')
})

add('改人数上限时同步修正剩余名额', async function () {
  const id = await createEvent({ capacity: 10 })
  mock.setOpenid(ALICE)
  await expectOk(hatSignup({ action: 'submit', data: Object.assign({ eventId: id }, signupForm()) }))
  eq(mock.get('events', id).remaining, 9)

  await expectOk(as(OWNER, hatEvent, 'update',
    Object.assign({ eventId: id }, eventForm({ capacity: 20 }))), '扩容')
  const doc = mock.get('events', id)
  eq(doc.capacity, 20)
  eq(doc.remaining, 19, '扩容后剩余名额要跟着走')
  eq(doc.signupCount, 1)

  // 上限不能压到已报名人数之下
  await expectErr(as(OWNER, hatEvent, 'update',
    Object.assign({ eventId: id }, eventForm({ capacity: 0, teamCount: 4 }))),
    'INVALID_INPUT', '上限低于已报名数')
})

add('活动不存在时返回 NOT_FOUND 而不是崩溃', async function () {
  await expectErr(as(OWNER, hatEvent, 'detail', { eventId: 'ghost' }), 'NOT_FOUND')
  await expectErr(as(OWNER, hatEvent, 'detail', { eventId: '' }), 'INVALID_INPUT')
})

add('未知 action 被拒绝', async function () {
  await expectErr(as(OWNER, hatEvent, 'dropDatabase', {}), 'UNKNOWN_ACTION')
  await expectErr(as(OWNER, hatSignup, 'toString', {}), 'UNKNOWN_ACTION',
    '原型链上的属性不能当成 action')
})

// ================================================================ 报名

add('报名成功并原子扣减名额', async function () {
  const id = await createEvent({ capacity: 3, teamCount: 2 })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  const doc = mock.get('events', id)
  eq(doc.signupCount, 1)
  eq(doc.remaining, 2)
  const rows = mock.all('signups')
  eq(rows.length, 1)
  eq(rows[0].openid, ALICE)
  eq(rows[0].adminLevel, null)
  eq(rows[0].status, 'signed')
})

add('重复报名是改资料，不再占名额', async function () {
  const id = await createEvent({ capacity: 3, teamCount: 2 })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  const d = await expectOk(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ name: '张三改', selfLevel: 5 }))))
  eq(d.updated, true, '第二次应当是更新')
  eq(mock.get('events', id).signupCount, 1, '名额不应被重复占用')
  eq(mock.all('signups').length, 1)
  eq(mock.all('signups')[0].name, '张三改')
  eq(mock.all('signups')[0].selfLevel, 5)
})

add('报名表单校验', async function () {
  const id = await createEvent()
  await expectErr(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ name: ' ' }))), 'INVALID_INPUT', '空姓名')
  await expectErr(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ gender: 'X' }))), 'INVALID_INPUT', '性别非法')
  await expectErr(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ selfLevel: 9 }))), 'INVALID_INPUT', '水平越界')
  await expectErr(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ selfLevel: null }))), 'INVALID_INPUT', '水平缺失')
  await expectErr(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ phone: 'abcdefg' }))), 'INVALID_INPUT', '手机号格式')
  eq(mock.get('events', id).signupCount, 0, '校验失败不能占用名额')
})

add('报名截止后不能再报', async function () {
  const id = await createEvent({
    startTime: Date.now() + DAY,
    endTime: null,
    signupDeadline: Date.now() - 1000,
  })
  await expectErr(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())),
    'SIGNUP_CLOSED')
  eq(mock.get('events', id).signupCount, 0)
})

add('报名关闭后不能再报', async function () {
  const id = await createEvent()
  await expectOk(as(OWNER, hatEvent, 'closeSignup', { eventId: id }))
  await expectErr(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())),
    'SIGNUP_CLOSED')
})

add('名额满后返回 EVENT_FULL，且 remaining 不会变成负数', async function () {
  const id = await createEvent({ capacity: 2, teamCount: 2 })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectOk(as(BOB, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectErr(as('openid-carol', hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm())), 'EVENT_FULL')
  const doc = mock.get('events', id)
  eq(doc.remaining, 0)
  eq(doc.signupCount, 2)
  eq(mock.all('signups').length, 2)
})

add('并发报名不会超出人数上限', async function () {
  const CAP = 10
  const RUSH = 60
  const id = await createEvent({ capacity: CAP, teamCount: 2 })

  // 60 个人同时抢 10 个名额。await 点会交错，真实地制造竞态。
  const jobs = []
  for (let i = 0; i < RUSH; i++) {
    jobs.push((function (n) {
      return function () {
        mock.setOpenid('rush-' + n)
        return hatSignup({
          action: 'submit',
          data: Object.assign({ eventId: id }, signupForm({ name: '球员' + n })),
        })
      }
    })(i))
  }
  const results = await Promise.all(jobs.map(function (f) { return f() }))

  const succeeded = results.filter(function (r) { return r.ok }).length
  const full = results.filter(function (r) { return !r.ok && r.error.code === 'EVENT_FULL' }).length
  const other = results.filter(function (r) { return !r.ok && r.error.code !== 'EVENT_FULL' })

  eq(other.length, 0, '不应出现 EVENT_FULL 之外的错误：' + JSON.stringify(other.slice(0, 2)))
  eq(succeeded, CAP, '成功人数应恰好等于名额')
  eq(full, RUSH - CAP, '其余都该收到名额已满')

  const doc = mock.get('events', id)
  eq(doc.signupCount, CAP, 'signupCount 不应超出上限')
  eq(doc.remaining, 0, 'remaining 不应为负')
  eq(mock.all('signups').length, CAP, '报名明细数应等于名额')
})

add('对照：先查后写的朴素实现会超卖（证明上面的并发测试有效）', async function () {
  // 这段刻意写成"读 remaining → 判断 → 写回"，用来确认并发测试不是摆设。
  const sdk = require('./mock-wx-server-sdk.js')
  const db = sdk.database()
  const _ = db.command
  const id = mock.insert('events', {
    capacity: 10, remaining: 10, signupCount: 0, status: 'open', ownerOpenid: OWNER,
  })

  async function naiveSubmit() {
    const res = await db.collection('events').doc(id).get()
    if (res.data.remaining <= 0) return false
    await db.collection('events').doc(id).update({
      data: { remaining: _.inc(-1), signupCount: _.inc(1) },
    })
    return true
  }

  const jobs = []
  for (let i = 0; i < 60; i++) jobs.push(naiveSubmit())
  const res = await Promise.all(jobs)
  const succeeded = res.filter(Boolean).length

  ok(succeeded > 10,
    '朴素实现本应超卖，实际只成功 ' + succeeded + ' 次——说明并发测试没能制造竞态，' +
    '那么上面那个"并发不超卖"的结论也不可信')
  ok(mock.get('events', id).remaining < 0, '朴素实现应把 remaining 压成负数')
})

add('取消报名释放名额', async function () {
  const id = await createEvent({ capacity: 2, teamCount: 2 })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectOk(as(BOB, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectErr(as('openid-carol', hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm())), 'EVENT_FULL')

  await expectOk(as(ALICE, hatSignup, 'cancel', { eventId: id }))
  eq(mock.get('events', id).remaining, 1)
  eq(mock.get('events', id).signupCount, 1)
  eq(mock.all('signups').length, 1)

  // 名额释放后别人补得上
  await expectOk(as('openid-carol', hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm())), '补位')
  eq(mock.get('events', id).remaining, 0)
})

add('没报名时取消返回 NOT_FOUND，不会把名额加多', async function () {
  const id = await createEvent({ capacity: 5, teamCount: 2 })
  await expectErr(as(ALICE, hatSignup, 'cancel', { eventId: id }), 'NOT_FOUND')
  eq(mock.get('events', id).remaining, 5, '名额不应变化')
})

add('并发重复取消不会把名额加多', async function () {
  const id = await createEvent({ capacity: 5, teamCount: 2 })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  mock.setOpenid(ALICE)
  const rs = await Promise.all([
    hatSignup({ action: 'cancel', data: { eventId: id } }),
    hatSignup({ action: 'cancel', data: { eventId: id } }),
    hatSignup({ action: 'cancel', data: { eventId: id } }),
  ])
  const okCount = rs.filter(function (r) { return r.ok }).length
  eq(okCount, 1, '只应有一次取消成功')
  eq(mock.get('events', id).remaining, 5, 'remaining 不应超过上限')
  eq(mock.get('events', id).signupCount, 0)
})

// ================================================================ 隐私与权限

add('参与者拿不到别人的报名信息（含手机号）', async function () {
  const id = await createEvent()
  await expectOk(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ name: '爱丽丝', phone: '13800000001' }))))
  await expectOk(as(BOB, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ name: '鲍勃', phone: '13800000002' }))))

  // listAll 只有创建者能调
  await expectErr(as(ALICE, hatSignup, 'listAll', { eventId: id }), 'FORBIDDEN')

  // detail 只回传自己的那条
  const d = await expectOk(as(ALICE, hatEvent, 'detail', { eventId: id }))
  eq(d.isOwner, false)
  eq(d.mySignup.name, '爱丽丝')
  eq(d.mySignup.phone, '13800000001')
  const json = JSON.stringify(d)
  ok(json.indexOf('13800000002') < 0, '返回里不应出现别人的手机号')
  ok(json.indexOf('鲍勃') < 0, '返回里不应出现别人的姓名')

  // 创建者能看到全部
  const all = await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))
  eq(all.count, 2)
  eq(all.list[0].phone, '13800000001')
})

add('非管理身份不能改水平、设约束、建赛事', async function () {
  const id = await createEvent()
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  const sid = mock.all('signups')[0]._id

  await expectErr(as(ALICE, hatSignup, 'updateLevel',
    { eventId: id, signupId: sid, adminLevel: 5 }), 'FORBIDDEN', '改水平')
  await expectErr(as(ALICE, hatTeam, 'setConstraints',
    { eventId: id, constraints: [] }), 'FORBIDDEN', '设约束')
  await expectErr(as(ALICE, hatTeam, 'listConstraints', { eventId: id }), 'FORBIDDEN', '读约束')
  await expectErr(as(ALICE, hatTeam, 'createTournament',
    { eventId: id, name: '第 1 场', teamCount: 2, attendeeIds: [sid] }),
    'FORBIDDEN', '建赛事')
  // 分队和发布挂在赛事上，不存在的赛事会先在入参校验挡掉，
  // 真正的权限断言放在「组织者拥有全部管理权限」那条里。
  await expectErr(as(ALICE, hatTeam, 'saveDivision',
    { tournamentId: 'ghost', teams: [{ name: '1队', memberIds: [sid] }] }), 'NOT_FOUND')
})

add('管理身份覆盖水平，有效水平随之改变；传 null 可恢复自评', async function () {
  const id = await createEvent()
  await expectOk(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm({ selfLevel: 2 }))))
  const sid = mock.all('signups')[0]._id

  const d = await expectOk(as(OWNER, hatSignup, 'updateLevel',
    { eventId: id, signupId: sid, adminLevel: 5 }))
  eq(d.level, 5)
  let list = await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))
  eq(list.list[0].level, 5, '有效水平应取覆盖值')
  eq(list.list[0].selfLevel, 2, '自评值要保留')

  await expectOk(as(OWNER, hatSignup, 'updateLevel',
    { eventId: id, signupId: sid, adminLevel: null }))
  list = await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))
  eq(list.list[0].level, 2, '清除覆盖后回到自评')
  eq(list.list[0].adminLevel, null)

  await expectErr(as(OWNER, hatSignup, 'updateLevel',
    { eventId: id, signupId: sid, adminLevel: 7 }), 'INVALID_INPUT', '越界')
})

add('不能跨活动改别人活动里的报名记录', async function () {
  const a = await createEvent()
  const b = await createEvent({ name: '另一场' })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: a }, signupForm())))
  const sid = mock.all('signups')[0]._id
  await expectErr(as(OWNER, hatSignup, 'updateLevel',
    { eventId: b, signupId: sid, adminLevel: 5 }), 'FORBIDDEN',
    '报名记录不属于该活动')
})

// ================================================================ 赛事

/** 建活动 + 报名 N 人，返回 { eventId, ids } */
async function setupEvent(n, over) {
  const id = await createEvent(Object.assign({ teamCount: 2, capacity: Math.max(n, 4) }, over))
  for (let i = 0; i < n; i++) {
    mock.setOpenid('player-' + i)
    await hatSignup({
      action: 'submit',
      data: Object.assign({ eventId: id }, signupForm({
        name: '球员' + i, gender: i % 2 ? 'F' : 'M', selfLevel: (i % 5) + 1,
      })),
    })
  }
  const roster = (await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))).list
  return { eventId: id, ids: roster.map(function (s) { return s._id }), roster: roster }
}

/** 建赛事 + 分队 + 发布，返回可直接录比赛的上下文 */
async function setupTournament(teamSizes, opts) {
  const o = opts || {}
  const total = teamSizes.reduce(function (a, b) { return a + b }, 0)
  const ev = await setupEvent(total)

  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId,
    name: o.name || '第 1 场',
    teamCount: teamSizes.length,
    attendeeIds: ev.ids,
  }), '建赛事')

  const teams = []
  let at = 0
  for (let i = 0; i < teamSizes.length; i++) {
    teams.push({ name: (i + 1) + '队', memberIds: ev.ids.slice(at, at + teamSizes[i]) })
    at += teamSizes[i]
  }

  const saved = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t._id, teams: teams,
  }), '存分队')
  await expectOk(as(OWNER, hatTeam, 'publish', {
    tournamentId: t._id, divisionId: saved._id,
  }), '发布')

  return {
    eventId: ev.eventId,
    tournamentId: t._id,
    ids: ev.ids,
    roster: ev.roster,
    teams: teams,
    divisionId: saved._id,
  }
}

function matchData(ctx, over) {
  return Object.assign({
    tournamentId: ctx.tournamentId,
    teamAIndex: 0,
    teamBIndex: 1,
    scoreA: 15,
    scoreB: 10,
    participantsA: ctx.teams[0].memberIds,
    participantsB: ctx.teams[1].memberIds,
    mvpIds: [],
  }, over || {})
}

function pointsOf(board, name) {
  const r = board.rows.filter(function (x) { return x.name === name })[0]
  if (!r) throw new Error('积分榜上找不到 ' + name)
  return r.points
}

add('创建赛事：赛前检录名单必须是本活动报名的子集', async function () {
  const ev = await setupEvent(6)
  const other = await setupEvent(2, { name: '别的活动' })

  await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids,
  }))

  await expectErr(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 2 场', teamCount: 2,
    attendeeIds: ev.ids.concat([other.ids[0]]),
  }), 'UNKNOWN_PLAYER', '混入别的活动的人')
})

add('创建赛事：赛前检录人数少于队伍数被拒', async function () {
  const ev = await setupEvent(6)
  await expectErr(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 4,
    attendeeIds: ev.ids.slice(0, 3),
  }), 'NOT_ENOUGH_ATTENDEES')
})

add('创建赛事：名称与队伍数校验', async function () {
  const ev = await setupEvent(6)
  const base = { eventId: ev.eventId, teamCount: 2, attendeeIds: ev.ids }
  await expectErr(as(OWNER, hatTeam, 'createTournament',
    Object.assign({}, base, { name: '  ' })), 'INVALID_INPUT', '空名称')
  await expectErr(as(OWNER, hatTeam, 'createTournament',
    Object.assign({}, base, { name: 'x', teamCount: 1 })), 'INVALID_INPUT', '1 队')
  await expectErr(as(OWNER, hatTeam, 'createTournament',
    Object.assign({}, base, { name: 'x', teamCount: 2.5 })), 'INVALID_INPUT', '非整数')
})

add('一个活动可以开多场赛事，各自赛前检录名单不同', async function () {
  const ev = await setupEvent(8)

  const t1 = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids,
  }))
  // 第 2 场只来了一半人
  const t2 = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 2 场', teamCount: 2, attendeeIds: ev.ids.slice(0, 4),
  }))

  const list = await expectOk(as(OWNER, hatTeam, 'listTournaments', { eventId: ev.eventId }))
  eq(list.list.length, 2)
  eq(list.list[0].attendeeCount, 8)
  eq(list.list[1].attendeeCount, 4)
  ok(t1._id !== t2._id)
})

add('分队名单必须与本场赛前检录名单一致', async function () {
  const ev = await setupEvent(8)
  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids.slice(0, 4),
  }))

  // 塞进一个没到场的人
  await expectErr(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t._id,
    teams: [{ name: '1队', memberIds: [ev.ids[0], ev.ids[4]] },
    { name: '2队', memberIds: [ev.ids[1], ev.ids[2]] }],
  }), 'UNKNOWN_PLAYER', '没到场的人')

  // 漏掉一个到场的人
  await expectErr(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t._id,
    teams: [{ name: '1队', memberIds: [ev.ids[0]] },
    { name: '2队', memberIds: [ev.ids[1]] }],
  }), 'INCOMPLETE_DIVISION')

  // 正确的
  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t._id,
    teams: [{ name: '1队', memberIds: [ev.ids[0], ev.ids[1]] },
    { name: '2队', memberIds: [ev.ids[2], ev.ids[3]] }],
  }))
})

add('删赛事连带清掉它的分队和比赛，不碰别的赛事', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))

  // 同一活动再开一场
  const t2 = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ctx.eventId, name: '第 2 场', teamCount: 2, attendeeIds: ctx.ids,
  }))
  const saved2 = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t2._id, teams: ctx.teams,
  }))
  await expectOk(as(OWNER, hatTeam, 'publish', {
    tournamentId: t2._id, divisionId: saved2._id,
  }))

  eq(mock.all('matches').length, 1)
  eq(mock.all('divisions').length, 2)

  await expectOk(as(OWNER, hatTeam, 'removeTournament', { tournamentId: ctx.tournamentId }))
  eq(mock.all('matches').length, 0, '该赛事的比赛应被删')
  eq(mock.all('divisions').length, 1, '只应剩下第 2 场的分队')
  eq(mock.all('tournaments').length, 1)
  eq(mock.all('divisions')[0].tournamentId, t2._id)
})

add('已录比赛后不能改赛前检录名单、不能重新分队', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))

  await expectErr(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: ctx.tournamentId, teams: ctx.teams,
  }), 'MATCHES_EXIST', '重新分队')

  await expectErr(as(OWNER, hatTeam, 'updateTournament', {
    tournamentId: ctx.tournamentId, name: '改名', teamCount: 2,
    attendeeIds: ctx.ids.slice(0, 3),
  }), 'MATCHES_EXIST', '改到场名单')

  // 只改名字（队伍数和名单不变）应当允许
  await expectOk(as(OWNER, hatTeam, 'updateTournament', {
    tournamentId: ctx.tournamentId, name: '改个名', teamCount: 2, attendeeIds: ctx.ids,
  }), '只改名应当允许')
})

add('删除活动会级联清掉赛事', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))
  eq(mock.all('tournaments').length, 1)

  await expectOk(as(OWNER, hatEvent, 'remove', { eventId: ctx.eventId }))
  eq(mock.all('tournaments').length, 0)
  eq(mock.all('matches').length, 0)
  eq(mock.all('divisions').length, 0)
  eq(mock.all('signups').length, 0)
})

// ================================================================ 角色

add('whoami 返回当前身份与能否发起活动', async function () {
  let me = await expectOk(as(ADMIN, hatAdmin, 'whoami', {}))
  eq(me.isAdmin, true)
  eq(me.isOrganizer, false, '管理员不是靠组织者记录认的')
  eq(me.canCreateEvent, true)

  me = await expectOk(as('nobody', hatAdmin, 'whoami', {}))
  eq(me.isAdmin, false)
  eq(me.isOrganizer, false)
  eq(me.canCreateEvent, false, '一般用户不能发起活动')

  grantOrganizer(ALICE)
  me = await expectOk(as(ALICE, hatAdmin, 'whoami', {}))
  eq(me.isOrganizer, true)
  eq(me.canCreateEvent, true)
})

add('一般用户不能发起活动，组织者可以', async function () {
  // 只报名过的人不能建活动
  await expectErr(as(ALICE, hatEvent, 'create', eventForm()), 'FORBIDDEN', '一般用户建活动')
  await expectErr(as(BOB, hatEvent, 'create', eventForm()), 'FORBIDDEN', '没报过名的人')

  // 管理员天然可以
  await expectOk(as(ADMIN, hatEvent, 'create', eventForm({ name: '管理员建的' })))

  // 组织者可以
  grantOrganizer(ALICE)
  await expectOk(as(ALICE, hatEvent, 'create', eventForm({ name: '组织者建的' })))
})

add('只有管理员能管理组织者', async function () {
  await expectErr(as(ALICE, hatAdmin, 'listUsers', {}), 'FORBIDDEN', '一般用户看不了名单')
  await expectErr(as(ALICE, hatAdmin, 'setOrganizer',
    { openid: ALICE, isOrganizer: true }), 'FORBIDDEN', '不能自封')
  await expectErr(as(ALICE, hatAdmin, 'listOrganizers', {}), 'FORBIDDEN')

  // 组织者可以看名单（要指派得先在人堆里找到人），但不能改
  grantOrganizer(OWNER)
  await expectOk(as(OWNER, hatAdmin, 'listUsers', {}), '组织者可以看名单')
  await expectErr(as(OWNER, hatAdmin, 'setOrganizer',
    { openid: ALICE, isOrganizer: true }), 'FORBIDDEN', '组织者不能改组织者')

  await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))
})

add('管理员指定组织者，名单来自报过名的人', async function () {
  const ev = await setupEvent(3)

  const users = await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))
  eq(users.list.length, 3, '三个报过名的人')
  ok(users.list.every(function (u) { return !u.isOrganizer }), '默认都不是组织者')

  const target = users.list[0]
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', {
    openid: target.openid, name: target.name, isOrganizer: true,
  }))

  const after = await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))
  const updated = after.list.filter(function (u) { return u.openid === target.openid })[0]
  eq(updated.isOrganizer, true)

  const orgs = await expectOk(as(ADMIN, hatAdmin, 'listOrganizers', {}))
  eq(orgs.list.length, 2, 'OWNER 建活动时已是组织者，加上刚指定的这个')
  ok(orgs.list.some(function (x) { return x.openid === target.openid }))

  // 取消
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', {
    openid: target.openid, isOrganizer: false,
  }))
  const left = await expectOk(as(ADMIN, hatAdmin, 'listOrganizers', {}))
  eq(left.list.length, 1)
  ok(!left.list.some(function (x) { return x.openid === target.openid }))
  ok(ev.eventId)
})

add('组织者拥有全部管理权限，但不能管理组织者', async function () {
  const ctx = await setupTournament([2, 2])
  const org = 'player-0'
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', { openid: org, isOrganizer: true }))

  // 能录
  await expectOk(as(org, hatMatch, 'saveMatch', matchData(ctx)), '组织者录战绩')
  const list = await expectOk(as(org, hatMatch, 'listMatches',
    { tournamentId: ctx.tournamentId }))
  eq(list.canScore, true)
  await expectOk(as(org, hatMatch, 'removeMatch', {
    tournamentId: ctx.tournamentId, matchId: list.list[0]._id,
  }), '组织者删战绩')

  // 可以做活动、赛事、分队和名单管理
  await expectOk(as(org, hatTeam, 'createTournament', {
    eventId: ctx.eventId, name: 'x', teamCount: 2, attendeeIds: ctx.ids,
  }), '组织者建赛事')
  await expectOk(as(org, hatTeam, 'saveDivision', {
    tournamentId: ctx.tournamentId, teams: ctx.teams,
  }), '组织者分队')
  await expectOk(as(org, hatSignup, 'updateLevel', {
    eventId: ctx.eventId, signupId: ctx.ids[0], adminLevel: 5,
  }), '组织者改水平')
  await expectOk(as(org, hatSignup, 'listAll', { eventId: ctx.eventId }), '组织者看名单')
  await expectOk(as(org, hatAdmin, 'listUsers', {}), '组织者查看用户')
  await expectErr(as(org, hatAdmin, 'setOrganizer',
    { openid: 'player-1', isOrganizer: true }), 'FORBIDDEN', '组织者不能添加组织者')
})

add('移交管理员：权限真的转走，不是再复制一份', async function () {
  const ev = await setupEvent(2)
  const target = (await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))).list[0]

  const res = await expectOk(as(ADMIN, hatAdmin, 'transferAdmin', {
    openid: target.openid, name: target.name,
  }), '移交')
  eq(res.openid, target.openid)

  // 新人拿到全部管理员权限
  let me = await expectOk(as(target.openid, hatAdmin, 'whoami', {}))
  eq(me.isAdmin, true, '新管理员')
  eq(me.canCreateEvent, true)
  const users = await expectOk(as(target.openid, hatAdmin, 'listUsers', {}))
  eq(users.canEditRoles, true, '新管理员可以改角色')
  await expectOk(as(target.openid, hatAdmin, 'setOrganizer', {
    openid: ALICE, isOrganizer: true,
  }), '新管理员可以指定组织者')

  // 老管理员（写死在 roles.js 里的那个）不再是管理员
  me = await expectOk(as(ADMIN, hatAdmin, 'whoami', {}))
  eq(me.isAdmin, false, '移交之后初始管理员应失效')
  eq(me.canCreateEvent, false)
  await expectErr(as(ADMIN, hatAdmin, 'listUsers', {}), 'FORBIDDEN')
  await expectErr(as(ADMIN, hatAdmin, 'transferAdmin', {
    openid: ALICE,
  }), 'FORBIDDEN', '已经交出去了就不能再交')

  const admins = await expectOk(as(target.openid, hatAdmin, 'listUsers', {}))
  eq(admins.adminOpenids.length, 1, '同一时间只有一个管理员')
  eq(admins.adminOpenids[0], target.openid)
  ok(ev.eventId)
})

add('移交管理员：目标是测试数据或没报过名的人时拒绝', async function () {
  await expectErr(as(ADMIN, hatAdmin, 'transferAdmin', {
    openid: 'ghost-openid',
  }), 'NOT_FOUND', '没报过名')
  await expectErr(as(ADMIN, hatAdmin, 'transferAdmin', {
    openid: ADMIN,
  }), 'INVALID_INPUT', '不能移交给自己')

  // 测试数据带 test- 前缀，没有真实微信账号
  const id = await createEvent()
  mock.insert('signups', {
    eventId: id, openid: 'test-abc-0', name: '测试甲', gender: 'M',
    selfLevel: 3, status: 'signed', isTest: true, createTime: Date.now(),
  })
  await expectErr(as(ADMIN, hatAdmin, 'transferAdmin', {
    openid: 'test-abc-0',
  }), 'NOT_FOUND', '测试数据不能当管理员')

  // 失败时不能把管理员搞丢
  eq((await expectOk(as(ADMIN, hatAdmin, 'whoami', {}))).isAdmin, true)
})

add('老数据里的 scorer 记录仍按组织者对待', async function () {
  const ctx = await setupTournament([2, 2])
  // 合并前的角色名，升级后不该凭空掉权限
  mock.insert('roles', {
    openid: 'player-0', role: 'scorer', name: '老记分员', createTime: Date.now(),
  })

  const me = await expectOk(as('player-0', hatAdmin, 'whoami', {}))
  eq(me.isOrganizer, true, '老记录要认')
  await expectOk(as('player-0', hatMatch, 'saveMatch', matchData(ctx)), '老记分员录战绩')

  // 取消时把老记录一并清掉，否则"取消"看起来没生效
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', {
    openid: 'player-0', isOrganizer: false,
  }))
  eq((await expectOk(as('player-0', hatAdmin, 'whoami', {}))).isOrganizer, false)
})

add('组织者身份被取消后，自己建的活动仍归他管', async function () {
  const ctx = await setupTournament([2, 2])
  // OWNER 是活动创建者，也是组织者；把组织者身份撤掉
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', { openid: OWNER, isOrganizer: false }))
  eq((await expectOk(as(OWNER, hatAdmin, 'whoami', {}))).isOrganizer, false)

  // 创建者这条兜底路径还在，否则这些活动就没人能管了
  await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: ctx.eventId }), '创建者看名单')
  await expectOk(as(OWNER, hatEvent, 'update',
    Object.assign({ eventId: ctx.eventId }, eventForm())), '创建者改活动')
  await expectErr(as(OWNER, hatEvent, 'create', eventForm({ name: '不该能建' })),
    'FORBIDDEN', '但不能再发起新活动')
})

add('活动列表区分"我创建的"和"我能管的"', async function () {
  const mine = await createEvent({ name: '我建的' })
  const other = await setupEvent(2, { name: '别人建的' })

  // 组织者能管所有活动，但这些活动不是他创建的
  const org = 'player-0'
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', { openid: org, isOrganizer: true }))

  function pick (list, id) {
    return list.filter(function (e) { return e._id === id })[0]
  }

  const orgList = (await expectOk(as(org, hatEvent, 'list', {}))).list
  eq(pick(orgList, mine).canManage, true)
  eq(pick(orgList, mine).isOwner, false, '能管不等于我创建的')
  eq(pick(orgList, other.eventId).canManage, true)
  eq(pick(orgList, other.eventId).isOwner, false)

  // 创建者自己两个都是 true
  const ownList = (await expectOk(as(OWNER, hatEvent, 'list', {}))).list
  eq(pick(ownList, mine).isOwner, true)
  eq(pick(ownList, mine).canManage, true)

  // 一般用户两个都是 false
  const plainList = (await expectOk(as('player-1', hatEvent, 'list', {}))).list
  eq(pick(plainList, mine).isOwner, false)
  eq(pick(plainList, mine).canManage, false)

  // 详情同理：管理台入口看 canManage
  const d = await expectOk(as(org, hatEvent, 'detail', { eventId: mine }))
  eq(d.canManage, true)
  eq(d.isOwner, false)
  const d2 = await expectOk(as(OWNER, hatEvent, 'detail', { eventId: mine }))
  eq(d2.canManage, true)
  eq(d2.isOwner, true)
  const d3 = await expectOk(as('player-1', hatEvent, 'detail', { eventId: mine }))
  eq(d3.canManage, false)
})

add('普通参与者不能录战绩', async function () {
  const ctx = await setupTournament([2, 2])
  await expectErr(as('player-0', hatMatch, 'saveMatch', matchData(ctx)), 'FORBIDDEN')
  await expectErr(as(ALICE, hatMatch, 'saveMatch', matchData(ctx)), 'FORBIDDEN')
})

add('管理员拥有组织者的全部权限，哪怕活动不是他建的', async function () {
  const ctx = await setupTournament([2, 2])

  await expectOk(as(ADMIN, hatSignup, 'listAll', { eventId: ctx.eventId }), '看名单')
  await expectOk(as(ADMIN, hatSignup, 'updateLevel', {
    eventId: ctx.eventId, signupId: ctx.ids[0], adminLevel: 5,
  }), '改水平')
  await expectOk(as(ADMIN, hatTeam, 'createTournament', {
    eventId: ctx.eventId, name: '管理员加的场', teamCount: 2, attendeeIds: ctx.ids,
  }), '建赛事')
  await expectOk(as(ADMIN, hatMatch, 'saveMatch', matchData(ctx)), '录战绩')
  await expectOk(as(ADMIN, hatEvent, 'update',
    Object.assign({ eventId: ctx.eventId }, eventForm())), '改活动')
})

// ================================================================ 水平保密

add('参与者拿不到任何人的水平', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))

  // 分队结果
  const div = await expectOk(as('player-0', hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  eq(div.canSeeLevel, false)
  ok(JSON.stringify(div).indexOf('level') < 0,
    '分队结果里不该出现 level：' + JSON.stringify(div).slice(0, 300))
  // 人数男女仍然可见
  eq(div.division.teams[0].stats.count, 2)
  ok(div.division.teams[0].stats.avgLevel === undefined, '不该有队均水平')
  ok(div.division.teams[0].stats.star === undefined, '不该有高分人数')

  // 比赛列表
  const mt = await expectOk(as('player-0', hatMatch, 'listMatches',
    { tournamentId: ctx.tournamentId }))
  ok(JSON.stringify(mt).indexOf('level') < 0, '比赛列表里不该出现 level')

  // 积分榜
  const board = await expectOk(as('player-0', hatMatch, 'leaderboard',
    { eventId: ctx.eventId }))
  ok(JSON.stringify(board).indexOf('level') < 0, '积分榜里不该出现 level')

  // 赛事详情
  const tour = await expectOk(as('player-0', hatTeam, 'getTournament',
    { tournamentId: ctx.tournamentId }))
  ok(JSON.stringify(tour).indexOf('level') < 0, '赛事详情里不该出现 level')
})

add('组织者和管理员仍然看得到水平', async function () {
  const ctx = await setupTournament([2, 2])

  const div = await expectOk(as(OWNER, hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  eq(div.canSeeLevel, true)
  ok(typeof div.division.teams[0].members[0].level === 'number', '组织者应看到成员水平')
  ok(typeof div.division.teams[0].stats.avgLevel === 'number', '组织者应看到队均水平')

  const adminDiv = await expectOk(as(ADMIN, hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  eq(adminDiv.canSeeLevel, true)

  const tour = await expectOk(as(OWNER, hatTeam, 'getTournament',
    { tournamentId: ctx.tournamentId }))
  ok(typeof tour.attendees[0].level === 'number', '组织者应看到赛前检录名单的水平')
})

add('组织者拥有管理权限并可以看到水平', async function () {
  const ctx = await setupTournament([2, 2])
  const org = 'player-0'
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', { openid: org, isOrganizer: true }))

  const div = await expectOk(as(org, hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  eq(div.canSeeLevel, true)
  ok(JSON.stringify(div).indexOf('level') >= 0, '组织者应看到管理所需的 level')
  ok(div.division.teams[0].members[0].name.length > 0)
})

add('参与者仍能看到自己的自评水平', async function () {
  const ctx = await setupTournament([2, 2])
  // 组织者把 player-0 的水平改掉
  await expectOk(as(OWNER, hatSignup, 'updateLevel', {
    eventId: ctx.eventId, signupId: ctx.ids[0], adminLevel: 5,
  }))

  const d = await expectOk(as('player-0', hatEvent, 'detail', { eventId: ctx.eventId }))
  eq(d.mySignup.selfLevel, 1, '自评值原样可见')
  ok(d.mySignup.adminLevel === undefined, '组织者调整后的值不该回传')
})

// ================================================================ 比赛与积分

add('分队未发布时不能录比赛', async function () {
  const ev = await setupEvent(4)
  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids,
  }))
  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t._id,
    teams: [{ name: '1队', memberIds: [ev.ids[0], ev.ids[1]] },
    { name: '2队', memberIds: [ev.ids[2], ev.ids[3]] }],
  }))
  await expectErr(as(OWNER, hatMatch, 'saveMatch', {
    tournamentId: t._id, teamAIndex: 0, teamBIndex: 1, scoreA: 15, scoreB: 10,
    participantsA: [ev.ids[0]], participantsB: [ev.ids[2]],
  }), 'DIVISION_NOT_PUBLISHED')
})

add('录入一场比赛并按规则计分', async function () {
  const ctx = await setupTournament([3, 3])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: [ctx.teams[1].memberIds[0], ctx.teams[1].memberIds[1]],
  })))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.rows.length, 6)
  eq(board.totals.matchCount, 1)
  eq(pointsOf(board, '球员0'), 3)
  eq(pointsOf(board, '球员3'), 2, '败方 1 分 + MVP 1 分')
  eq(pointsOf(board, '球员5'), 1)
  eq(board.rules.win, 3)
})

add('录入弃赛人员：扣 3 分且不能同时上场', async function () {
  const ctx = await setupTournament([3, 3])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsA: ctx.teams[0].memberIds.slice(0, 2),
    participantsB: ctx.teams[1].memberIds.slice(0, 2),
    forfeitIds: [ctx.teams[0].memberIds[2]],
  })))
  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员2'), -3)
  eq(board.rows.filter(function (r) { return r.name === '球员2' })[0].forfeitCount, 1)
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    forfeitIds: [ctx.teams[0].memberIds[0]],
  })), 'INVALID_FORFEIT')
})

add('未上场的人不得分', async function () {
  const ctx = await setupTournament([3, 3])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsA: ctx.teams[0].memberIds.slice(0, 2),
    participantsB: ctx.teams[1].memberIds.slice(0, 2),
  })))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员0'), 3)
  eq(pointsOf(board, '球员2'), 0, '胜方未上场不得分')
  eq(pointsOf(board, '球员5'), 0, '败方未上场不得分')
  eq(board.totals.playedCount, 4)
})

add('平局与非法比分被拒', async function () {
  const ctx = await setupTournament([2, 2])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: 12, scoreB: 12 })),
    'DRAW_NOT_ALLOWED')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: -1 })),
    'INVALID_INPUT', '负数')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: 7.5 })),
    'INVALID_INPUT', '小数')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreB: null })),
    'INVALID_INPUT', 'null 不能当 0')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreB: 'abc' })),
    'INVALID_INPUT', '非数字')
})

add('两队不能相同，队伍序号必须存在', async function () {
  const ctx = await setupTournament([2, 2])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { teamBIndex: 0 })),
    'INVALID_INPUT', '同一队')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { teamBIndex: 9 })),
    'INVALID_INPUT', '不存在')
})

add('上场名单混入别队的人被拒', async function () {
  const ctx = await setupTournament([3, 3])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsA: ctx.teams[0].memberIds.concat([ctx.teams[1].memberIds[0]]),
  })), 'INVALID_PARTICIPANT')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsB: ['ghost-id'],
  })), 'INVALID_PARTICIPANT')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { participantsA: [] })),
    'INVALID_INPUT', '空名单')
})

add('MVP 必须来自败方的上场队员', async function () {
  const ctx = await setupTournament([3, 3])

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: [ctx.teams[0].memberIds[0]],
  })), 'INVALID_MVP', '胜方的人')

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsB: ctx.teams[1].memberIds.slice(0, 2),
    mvpIds: [ctx.teams[1].memberIds[2]],
  })), 'INVALID_MVP', '未上场的人')

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    scoreA: 10, scoreB: 15, mvpIds: [ctx.teams[1].memberIds[0]],
  })), 'INVALID_MVP', 'B 赢时 B 的人不能当选')

  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    scoreA: 10, scoreB: 15, mvpIds: [ctx.teams[0].memberIds[0]],
  })), 'B 赢时从 A 队选应当成功')
})

add('MVP 最多 2 人且不能重复', async function () {
  const ctx = await setupTournament([3, 3])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: ctx.teams[1].memberIds,
  })), 'INVALID_INPUT', '超过 2 人')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: [ctx.teams[1].memberIds[0], ctx.teams[1].memberIds[0]],
  })), 'INVALID_INPUT', '重复')
})

add('MVP 可以先不选，之后补录', async function () {
  const ctx = await setupTournament([2, 2])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))
  let board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员2'), 1)

  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: saved._id, mvpIds: [ctx.teams[1].memberIds[0]],
  })))
  board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员2'), 2)
  eq(board.totals.matchCount, 1, '补录是更新不是新增')
})

add('删除比赛后积分同步扣掉', async function () {
  const ctx = await setupTournament([2, 2])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: [ctx.teams[1].memberIds[0]],
  })))
  await expectOk(as(OWNER, hatMatch, 'removeMatch', {
    tournamentId: ctx.tournamentId, matchId: saved._id,
  }))
  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  board.rows.forEach(function (r) { eq(r.points, 0, r.name) })
  eq(board.totals.matchCount, 0)
})

add('不能跨赛事改别场的比赛记录', async function () {
  const ctx = await setupTournament([2, 2])
  const other = await setupTournament([2, 2], { name: '另一场' })
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))
  await expectErr(as(OWNER, hatMatch, 'removeMatch', {
    tournamentId: other.tournamentId, matchId: saved._id,
  }), 'FORBIDDEN')
})

add('参与者看不到未发布赛事的比赛与分队', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))

  const seen = await expectOk(as('player-0', hatMatch, 'listMatches',
    { tournamentId: ctx.tournamentId }))
  eq(seen.list.length, 1)

  await expectOk(as(OWNER, hatTeam, 'unpublish', { tournamentId: ctx.tournamentId }))
  await expectErr(as('player-0', hatMatch, 'listMatches',
    { tournamentId: ctx.tournamentId }), 'DIVISION_NOT_PUBLISHED')
  const div = await expectOk(as('player-0', hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  eq(div.division, null, '撤销发布后参与者看不到分队')
})

// ================================================================ 端到端

add('端到端：一个活动两场赛事，积分汇总与手算一致', async function () {
  // 6 人报名
  const ev = await setupEvent(6)
  const id = ev.ids

  // 第 1 场：6 人全到，分 2 队
  const t1 = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: id,
  }))
  const d1 = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t1._id,
    teams: [{ name: 'A队', memberIds: [id[0], id[1], id[2]] },
    { name: 'B队', memberIds: [id[3], id[4], id[5]] }],
  }))
  await expectOk(as(OWNER, hatTeam, 'publish', { tournamentId: t1._id, divisionId: d1._id }))
  // A 队 15:10 胜，MVP 给 B 队前两人
  await expectOk(as(OWNER, hatMatch, 'saveMatch', {
    tournamentId: t1._id, teamAIndex: 0, teamBIndex: 1, scoreA: 15, scoreB: 10,
    participantsA: [id[0], id[1], id[2]], participantsB: [id[3], id[4], id[5]],
    mvpIds: [id[3], id[4]],
  }))

  // 第 2 场：只来了 4 个人（球员0,1,3,4），重新分队
  const t2 = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 2 场', teamCount: 2,
    attendeeIds: [id[0], id[1], id[3], id[4]],
  }))
  const d2 = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t2._id,
    teams: [{ name: 'C队', memberIds: [id[0], id[3]] },
    { name: 'D队', memberIds: [id[1], id[4]] }],
  }))
  await expectOk(as(OWNER, hatTeam, 'publish', { tournamentId: t2._id, divisionId: d2._id }))
  // D 队 15:12 胜，MVP 给 C 队的球员0
  await expectOk(as(OWNER, hatMatch, 'saveMatch', {
    tournamentId: t2._id, teamAIndex: 0, teamBIndex: 1, scoreA: 12, scoreB: 15,
    participantsA: [id[0], id[3]], participantsB: [id[1], id[4]],
    mvpIds: [id[0]],
  }))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ev.eventId }))

  // 手算：
  // 球员0: t1 胜3 + t2 负1 + MVP1 = 5
  // 球员1: t1 胜3 + t2 胜3       = 6
  // 球员2: t1 胜3                 = 3
  // 球员3: t1 负1 + MVP1 + t2 负1 = 3
  // 球员4: t1 负1 + MVP1 + t2 胜3 = 5
  // 球员5: t1 负1                 = 1
  eq(pointsOf(board, '球员0'), 5)
  eq(pointsOf(board, '球员1'), 6)
  eq(pointsOf(board, '球员2'), 3)
  eq(pointsOf(board, '球员3'), 3)
  eq(pointsOf(board, '球员4'), 5)
  eq(pointsOf(board, '球员5'), 1)

  eq(board.totals.matchCount, 2)
  eq(board.tournamentCount, 2)
  eq(board.rows.length, 6, '活动的全部报名都在榜上')

  // 参加场次
  const row0 = board.rows.filter(function (r) { return r.name === '球员0' })[0]
  const row2 = board.rows.filter(function (r) { return r.name === '球员2' })[0]
  eq(row0.tournamentCount, 2, '球员0 两场都参加了')
  eq(row2.tournamentCount, 1, '球员2 只参加了第 1 场')

  // 名次：球员1 最高
  eq(board.rows[0].name, '球员1')
  eq(board.rows[0].rank, 1)

  // 积分榜里不该有水平
  ok(JSON.stringify(board).indexOf('level') < 0)
})


// ================================================================ 测试数据

add('只有管理员能生成和清理测试数据', async function () {
  const id = await createEvent({ capacity: 30 })
  await expectErr(as(OWNER, hatSignup, 'seedTestSignups', { eventId: id, count: 8 }),
    'FORBIDDEN', '组织者也不行')
  await expectErr(as(ALICE, hatSignup, 'seedTestSignups', { eventId: id, count: 8 }),
    'FORBIDDEN')
  await expectErr(as(OWNER, hatSignup, 'clearTestSignups', { eventId: id }), 'FORBIDDEN')
})

add('生成测试数据：占名额、带标记、性别水平合法', async function () {
  const id = await createEvent({ capacity: 30 })
  const d = await expectOk(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 24 }))
  eq(d.added, 24)

  const evt = mock.get('events', id)
  eq(evt.signupCount, 24, '测试数据要计入报名数')
  eq(evt.remaining, 6, '测试数据要占名额')

  const rows = mock.all('signups')
  eq(rows.length, 24)
  rows.forEach(function (s) {
    eq(s.isTest, true)
    ok(s.name.indexOf('测试') === 0, '名字要带「测试」前缀：' + s.name)
    ok(s.gender === 'M' || s.gender === 'F')
    ok(s.selfLevel >= 1 && s.selfLevel <= 5)
    ok(s.openid.indexOf('test-') === 0, 'openid 要带 test- 前缀')
  })
  // openid 互不重复，否则会撞 (eventId, openid) 唯一索引
  const openids = rows.map(function (s) { return s.openid })
  eq(new Set(openids).size, 24, 'openid 不能重复')

  const list = await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))
  ok(list.list.every(function (s) { return s.isTest === true }), 'listAll 要带上 isTest')
})

add('连续生成两批，openid 也不重复', async function () {
  const id = await createEvent({ capacity: 40 })
  await expectOk(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 8 }))
  // 让两批的时间戳一定不同
  await new Promise(function (r) { setTimeout(r, 5) })
  await expectOk(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 8 }))
  const openids = mock.all('signups').map(function (s) { return s.openid })
  eq(new Set(openids).size, 16)
})

add('名额不够时拒绝生成，且不扣名额', async function () {
  const id = await createEvent({ capacity: 10 })
  await expectErr(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 16 }),
    'EVENT_FULL')
  eq(mock.get('events', id).remaining, 10, '失败不能扣名额')
  eq(mock.all('signups').length, 0)
})

add('生成数量的范围校验', async function () {
  const id = await createEvent({ capacity: 100 })
  await expectErr(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 0 }),
    'INVALID_INPUT')
  await expectErr(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 61 }),
    'INVALID_INPUT')
  await expectErr(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: null }),
    'INVALID_INPUT', 'null 不能当 0 也不能放行')
})

add('清理测试数据：只删测试的，归还名额，真实报名不受影响', async function () {
  const id = await createEvent({ capacity: 30 })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectOk(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 16 }))
  eq(mock.get('events', id).remaining, 13)

  const d = await expectOk(as(ADMIN, hatSignup, 'clearTestSignups', { eventId: id }))
  eq(d.removed, 16)

  const rows = mock.all('signups')
  eq(rows.length, 1, '只剩真实报名')
  eq(rows[0].openid, ALICE)
  const evt = mock.get('events', id)
  eq(evt.remaining, 29, '名额要归还')
  eq(evt.signupCount, 1)
})

add('测试选手已进赛事时拒绝清理，删掉赛事后才能清', async function () {
  const id = await createEvent({ capacity: 30 })
  await expectOk(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 8 }))
  const ids = mock.all('signups').map(function (s) { return s._id })

  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: id, name: '试分队', teamCount: 2, attendeeIds: ids,
  }))

  const e = await expectErr(as(ADMIN, hatSignup, 'clearTestSignups', { eventId: id }),
    'TEST_DATA_IN_USE')
  ok(e.message.indexOf('试分队') >= 0, '要说清是哪场赛事：' + e.message)
  eq(mock.all('signups').length, 8, '被拒时一条都不能删')
  eq(mock.get('events', id).remaining, 22, '被拒时名额不变')

  await expectOk(as(OWNER, hatTeam, 'removeTournament', { tournamentId: t._id }))
  const d = await expectOk(as(ADMIN, hatSignup, 'clearTestSignups', { eventId: id }))
  eq(d.removed, 8)
  eq(mock.get('events', id).remaining, 30)
})

add('清理时约束里的测试选手被摘掉，不足 2 人的整条删除', async function () {
  const id = await createEvent({ capacity: 30 })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectOk(as(BOB, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectOk(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 4 }))
  const rows = mock.all('signups')
  const real = rows.filter(function (s) { return !s.isTest }).map(function (s) { return s._id })
  const fake = rows.filter(function (s) { return s.isTest }).map(function (s) { return s._id })

  await expectOk(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id,
    constraints: [
      { type: 'together', signupIds: [real[0], fake[0]] },           // 摘掉后剩 1 人 → 删
      { type: 'apart', signupIds: [real[0], real[1], fake[1]] },     // 摘掉后剩 2 人 → 保留
      { type: 'apart', signupIds: [real[0], real[1]] },              // 不涉及 → 不动
    ],
  }))

  await expectOk(as(ADMIN, hatSignup, 'clearTestSignups', { eventId: id }))
  const cons = mock.all('constraints')
  eq(cons.length, 2, '剩不足 2 人的那条应被删掉')
  cons.forEach(function (c) {
    ok(c.signupIds.every(function (sid) { return fake.indexOf(sid) < 0 }),
      '约束里不应再有测试选手')
    eq(c.signupIds.length, 2)
  })
})

add('没有测试数据时清理是空操作', async function () {
  const id = await createEvent()
  const d = await expectOk(as(ADMIN, hatSignup, 'clearTestSignups', { eventId: id }))
  eq(d.removed, 0)
})

add('后台用户列表不显示测试账号', async function () {
  const id = await createEvent({ capacity: 30 })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectOk(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 10 }))

  const users = await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))
  eq(users.list.length, 1, '只有真人')
  eq(users.list[0].openid, ALICE)
})

add('端到端：用测试数据完成一次分队', async function () {
  const id = await createEvent({ capacity: 24, teamCount: 4 })
  await expectOk(as(ADMIN, hatSignup, 'seedTestSignups', { eventId: id, count: 24 }))
  const roster = (await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))).list

  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: id, name: '第 1 场', teamCount: 4,
    attendeeIds: roster.map(function (s) { return s._id }),
  }))

  const divider = require('../miniprogram/utils/divide.js')
  const res = divider.divide(roster.map(function (s) {
    return { id: s._id, name: s.name, gender: s.gender, level: s.level }
  }), 4, [], 1)
  ok(res.ok)
  eq(res.stats.sizeSpread, 0, '24 人分 4 队应当每队 6 人')
  ok(res.stats.femaleSpread <= 1)

  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t._id,
    teams: res.teams.map(function (x) { return { name: x.name, memberIds: x.memberIds } }),
  }), '测试数据的分队结果应能通过云端校验')
})

  // ---------------------------------------------------------------- 运行

  ; (async function run() {
    for (let i = 0; i < tests.length; i++) {
      await test(tests[i].name, tests[i].fn)
    }
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
  })()
