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

add('返回了非信封结构时会被包成可读的错误，而不是让客户端看到「操作失败」', async function () {
  const shared = require('../shared/common.js')

  // 正常信封原样放行（连 detail 都不动）
  const good = shared.ok({ a: 1 })
  eq(shared.ensureEnvelope(good, 'x'), good, '正常信封必须原样返回')

  // 这一段故意触发兜底，把日志收走再断言，别让它污染测试输出
  const logs = []
  const realError = console.error
  console.error = function () { logs.push(Array.prototype.join.call(arguments, ' ')) }
  let bare, junk
  try {
    // 真实踩过的坑：纯模块的 {code, message} 被原样 return 出去
    bare = shared.ensureEnvelope(
      { code: 'INVALID_IMPORT', message: '第 22 行性别必须是男/女或 M/F' }, 'importSignups')
    // 完全认不出来的：也要是一个合法信封，并带上 action 方便查日志
    junk = shared.ensureEnvelope(undefined, 'importSignups')
  } finally {
    console.error = realError
  }

  eq(bare.ok, false)
  eq(bare.error.code, 'INVALID_IMPORT')
  eq(bare.error.message, '第 22 行性别必须是男/女或 M/F', '原因要原样传给前端')
  ok(junk.ok === false && junk.error.code === 'BAD_RESULT')
  ok(junk.error.message.indexOf('importSignups') >= 0, '要说是哪个 action')

  // 服务端必须留下线索：没有日志的话，"返回了个怪东西"事后完全无法追查
  eq(logs.length, 2)
  ok(logs[0].indexOf('importSignups') >= 0 && logs[0].indexOf('非信封') >= 0)
})

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

add('创建活动：类型落库，未知类型被拒', async function () {
  grantOrganizer(OWNER)
  // 不传类型 = 个人积分赛，这样旧版前端（不知道 type）建出来的活动行为不变
  const a = await createEvent()
  eq(mock.get('events', a).type, 'personal')

  const b = await createEvent({ name: '经典 HAT 局', type: 'classic' })
  eq(mock.get('events', b).type, 'classic')
  const d = await expectOk(as(OWNER, hatEvent, 'detail', { eventId: b }))
  eq(d.event.type, 'classic')
  eq(d.event.typeLabel, '经典 HAT')

  await expectErr(as(OWNER, hatEvent, 'create', eventForm({ type: 'league' })),
    'INVALID_INPUT', '未知类型')
})

add('编辑活动不会改类型', async function () {
  grantOrganizer(OWNER)
  const id = await createEvent({ type: 'classic' })
  // 编辑页根本不提交 type；就算提交了也不该生效——类型决定了"只能有一个赛事"
  await expectOk(as(OWNER, hatEvent, 'update', Object.assign(
    { eventId: id }, eventForm({ type: 'personal', name: '改个名字' }))))
  eq(mock.get('events', id).type, 'classic')
  eq(mock.get('events', id).name, '改个名字')
})

add('活动可以跨天：结束时间晚于开始一天以上照样接受，且仍然可选', async function () {
  const start = Date.now() + 3 * DAY

  // 跨天（两天一夜）
  const id = await createEvent({
    startTime: start, endTime: start + 2 * DAY, signupDeadline: null,
  })
  const doc = mock.get('events', id)
  eq(doc.endTime - doc.startTime, 2 * DAY, '跨度按原样存下')

  // 不填结束时间
  const id2 = await createEvent({ endTime: null, signupDeadline: null })
  eq(mock.get('events', id2).endTime, null, '结束时间可以不填')

  // 二者都能正常读回来（列表走的是同一条查询）
  const list = (await expectOk(as(OWNER, hatEvent, 'list', {}))).list
  const row = list.filter(function (e) { return e._id === id })[0]
  eq(row.endTime, start + 2 * DAY)
  eq(row.startTime, start)
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

add('自己取消报名：已被赛前检录时拒绝，移出检录后才能取消', async function () {
  const ev = await setupEvent(4)
  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids,
  }))

  // player-0 在检录名单里 → 不能自己取消，也不会留下半个操作
  const err = await expectErr(as('player-0', hatSignup, 'cancel', { eventId: ev.eventId }),
    'SIGNUP_IN_USE', '在检录名单里')
  ok(err.message.indexOf('第 1 场') >= 0, '错误信息要指出是哪场赛事：' + err.message)
  eq(mock.all('signups').length, 4, '人数没变')
  eq(mock.get('events', ev.eventId).signupCount, 4, '名额没变')

  // 组织者把他移出检录名单后，就能自己取消了
  await expectOk(as(OWNER, hatTeam, 'updateTournament', {
    tournamentId: t._id, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids.slice(1),
  }))
  await expectOk(as('player-0', hatSignup, 'cancel', { eventId: ev.eventId }))
  eq(mock.all('signups').length, 3)
  eq(mock.get('events', ev.eventId).signupCount, 3)
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

// ================================================================ 删除报名

add('删除报名：记录消失且名额归还', async function () {
  const ev = await setupEvent(3)
  const doc0 = mock.get('events', ev.eventId)
  eq(doc0.signupCount, 3)
  eq(doc0.remaining, 1, '上限 4，报了 3 人')

  const d = await expectOk(as(OWNER, hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[0] }))
  eq(d.removed, true)
  eq(d.constraintsTouched, 0)
  eq(mock.all('signups').length, 2, '少了一条报名')

  const doc = mock.get('events', ev.eventId)
  eq(doc.signupCount, 2)
  eq(doc.remaining, 2, '名额要还回来')

  const list = await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: ev.eventId }))
  eq(list.list.length, 2)
  ok(list.list.every(function (s) { return s._id !== ev.ids[0] }), '被删的人不在了')

  // 腾出来的名额能被别人用掉
  await expectOk(as(ALICE, hatSignup, 'submit',
    Object.assign({ eventId: ev.eventId }, signupForm({ name: '补位的' }))))
  eq(mock.get('events', ev.eventId).remaining, 1)
})

add('删除报名：组织者和管理员都能删不是自己建的活动，一般用户不行', async function () {
  const ev = await setupEvent(2)

  // 一般用户（没角色、也不是创建者）
  await expectErr(as('player-0', hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[0] }), 'FORBIDDEN', '一般用户不能删别人的报名')
  eq(mock.all('signups').length, 2, '被拒后什么也没删')

  // 组织者
  grantOrganizer(ALICE)
  await expectOk(as(ALICE, hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[0] }), '组织者可以删')
  eq(mock.all('signups').length, 1)

  // 管理员
  await expectOk(as(ADMIN, hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[1] }), '管理员可以删')
  eq(mock.all('signups').length, 0)
  eq(mock.get('events', ev.eventId).remaining, 4, '两个名额都还回来了')
})

add('删除报名：不存在、跨活动、缺 id', async function () {
  const a = await createEvent()
  const b = await createEvent({ name: '另一场' })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: a }, signupForm())))
  const sid = mock.all('signups')[0]._id

  await expectErr(as(OWNER, hatSignup, 'removeSignup',
    { eventId: a, signupId: '' }), 'INVALID_INPUT', '缺 id')
  await expectErr(as(OWNER, hatSignup, 'removeSignup',
    { eventId: a, signupId: 'ghost' }), 'NOT_FOUND')
  await expectErr(as(OWNER, hatSignup, 'removeSignup',
    { eventId: b, signupId: sid }), 'FORBIDDEN', '不属于这场活动')
  eq(mock.all('signups').length, 1, '都没删掉')
})

add('删除报名：已被赛前检录的人不能删，且不会留下半个操作', async function () {
  const ev = await setupEvent(4)
  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids,
  }))
  ok(t._id)

  const err = await expectErr(as(OWNER, hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[0] }), 'SIGNUP_IN_USE', '在检录名单里')
  ok(err.message.indexOf('第 1 场') >= 0, '错误信息要指出是哪场赛事：' + err.message)
  eq(err.detail.tournamentIds.length, 1)

  // 名额和记录都不能动
  eq(mock.all('signups').length, 4)
  eq(mock.get('events', ev.eventId).signupCount, 4)

  // 把人移出检录名单之后就能删了
  await expectOk(as(OWNER, hatTeam, 'updateTournament', {
    tournamentId: t._id, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids.slice(1),
  }))
  await expectOk(as(OWNER, hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[0] }), '移出检录后可以删')
  eq(mock.all('signups').length, 3)
})

add('删除报名：约束里涉及他的被摘掉，不足 2 人的整条删除', async function () {
  const ev = await setupEvent(4)
  // 两条约束：一条只涉及两人（删一个就剩 1 人 → 整条删），一条涉及三人（摘掉后剩 2 人 → 保留）
  await expectOk(as(OWNER, hatTeam, 'setConstraints', {
    eventId: ev.eventId,
    constraints: [
      { type: 'apart', signupIds: [ev.ids[0], ev.ids[1]] },
      { type: 'together', signupIds: [ev.ids[0], ev.ids[1], ev.ids[2]] },
    ],
  }))
  eq(mock.all('constraints').length, 2)

  const d = await expectOk(as(OWNER, hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[0] }))
  eq(d.constraintsTouched, 2, '两条约束都动了')

  const left = mock.all('constraints')
  eq(left.length, 1, '只剩 1 人的那条被删掉了')
  eq(left[0].type, 'together')
  eq(left[0].signupIds.length, 2)
  ok(left[0].signupIds.indexOf(ev.ids[0]) < 0, '被删的人不再出现在约束里')

  // 剩下的约束仍然能正常保存/读取（不是坏数据）
  const list = await expectOk(as(OWNER, hatTeam, 'listConstraints', { eventId: ev.eventId }))
  eq(list.list.length, 1)
})

add('删除报名：不影响别的活动', async function () {
  const a = await setupEvent(2)
  const b = await setupEvent(2, { name: '别的活动' })

  await expectOk(as(OWNER, hatSignup, 'removeSignup',
    { eventId: a.eventId, signupId: a.ids[0] }))

  eq(mock.get('events', a.eventId).signupCount, 1)
  eq(mock.get('events', b.eventId).signupCount, 2, '别的活动不受影响')
  eq((await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: b.eventId }))).list.length, 2)
})

add('自己取消报名：也要从约束和随机事件触发名单里摘掉', async function () {
  const ev = await setupEvent(3)
  // 取消的人既在约束里，也在随机事件触发名单里
  await expectOk(as(OWNER, hatTeam, 'setConstraints', {
    eventId: ev.eventId,
    constraints: [{ type: 'apart', signupIds: [ev.ids[0], ev.ids[1]] }],
  }))
  await expectOk(as(OWNER, hatMatch, 'setRandomEvents', {
    eventId: ev.eventId,
    events: [
      { text: '两人事件', delta: -1, signupIds: [ev.ids[0], ev.ids[1]] },
      { text: '单人事件', delta: 2, signupIds: [ev.ids[0]] },
    ],
  }))

  // 参与者自己取消（走 cancel，不是管理端的 removeSignup）
  await expectOk(as('player-0', hatSignup, 'cancel', { eventId: ev.eventId }))
  eq(mock.get('events', ev.eventId).signupCount, 2, '名额归还')

  // 约束：只剩 1 人 → 整条删除
  eq(mock.all('constraints').length, 0, '不足 2 人的约束该整条删掉')

  // 随机事件：单人那条整条删除，两人那条只剩还在的人
  const pool = mock.all('randomEvents')
  eq(pool.length, 1, '只剩 1 人的事件该删掉')
  eq(pool[0].text, '两人事件')
  eq(pool[0].signupIds.length, 1)
  eq(pool[0].signupIds[0], ev.ids[1])

  // 关键：池子里没有悬空引用，所以还能正常覆盖式保存与抽取
  const r = await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ev.eventId }))
  eq(r.draw.names.length, 1)
  eq(r.draw.names[0], '球员1', '抽取只作用于还在的人')
})

// ================================================================ 随机事件

/** 造一条事件定义 */
function eventDef (ids, delta, text) {
  return { text: text || (delta > 0 ? '奖励' : '惩罚'), delta: delta, signupIds: ids }
}

async function setPool (eventId, list, who) {
  return expectOk(as(who || OWNER, hatMatch, 'setRandomEvents',
    { eventId: eventId, events: list }))
}

add('随机事件：只有管理身份能设置、查看事件池和抽取', async function () {
  const ev = await setupEvent(3)
  const defs = [eventDef([ev.ids[0]], -1)]

  // 一般用户
  await expectErr(as('player-1', hatMatch, 'setRandomEvents',
    { eventId: ev.eventId, events: defs }), 'FORBIDDEN', '设置')
  await expectErr(as('player-1', hatMatch, 'listRandomEvents',
    { eventId: ev.eventId }), 'FORBIDDEN', '查看事件池（对参与者该是惊喜）')
  await expectErr(as('player-1', hatMatch, 'drawRandomEvent',
    { eventId: ev.eventId }), 'FORBIDDEN', '抽取')
  await expectErr(as('player-1', hatMatch, 'removeDraw',
    { eventId: ev.eventId, drawId: 'x' }), 'FORBIDDEN', '撤销')

  // 组织者：活动不是他建的也能管
  grantOrganizer(ALICE)
  await setPool(ev.eventId, defs, ALICE)
  await expectOk(as(ALICE, hatMatch, 'listRandomEvents', { eventId: ev.eventId }))

  // 管理员
  await expectOk(as(ADMIN, hatMatch, 'listRandomEvents', { eventId: ev.eventId }))
})

add('随机事件：事件池校验', async function () {
  const ev = await setupEvent(3)
  const okDef = eventDef([ev.ids[0]], -1)

  await expectErr(as(OWNER, hatMatch, 'setRandomEvents',
    { eventId: ev.eventId, events: [{ text: ' ', delta: 1, signupIds: [ev.ids[0]] }] }),
    'INVALID_INPUT', '空说明')
  await expectErr(as(OWNER, hatMatch, 'setRandomEvents',
    { eventId: ev.eventId, events: [{ text: 'x'.repeat(61), delta: 1, signupIds: [ev.ids[0]] }] }),
    'INVALID_INPUT', '说明过长')
  await expectErr(as(OWNER, hatMatch, 'setRandomEvents',
    { eventId: ev.eventId, events: [{ text: 'x', delta: 0, signupIds: [ev.ids[0]] }] }),
    'INVALID_INPUT', '效果为 0 没有意义')
  await expectErr(as(OWNER, hatMatch, 'setRandomEvents',
    { eventId: ev.eventId, events: [{ text: 'x', delta: 1.5, signupIds: [ev.ids[0]] }] }),
    'INVALID_INPUT', '效果非整数')
  await expectErr(as(OWNER, hatMatch, 'setRandomEvents',
    { eventId: ev.eventId, events: [{ text: 'x', delta: 99, signupIds: [ev.ids[0]] }] }),
    'INVALID_INPUT', '效果越界')
  await expectErr(as(OWNER, hatMatch, 'setRandomEvents',
    { eventId: ev.eventId, events: [{ text: 'x', delta: 1, signupIds: [] }] }),
    'INVALID_INPUT', '触发名单不能为空')
  await expectErr(as(OWNER, hatMatch, 'setRandomEvents',
    { eventId: ev.eventId, events: [{ text: 'x', delta: 1, signupIds: ['ghost'] }] }),
    'UNKNOWN_PLAYER', '引用了不存在的报名记录')

  // 合法的能存下，且是覆盖式：第二次提交只剩一条
  await setPool(ev.eventId, [okDef, eventDef([ev.ids[1]], 2, '奖励')])
  eq(mock.all('randomEvents').length, 2)
  await setPool(ev.eventId, [okDef])
  eq(mock.all('randomEvents').length, 1, '覆盖式保存')
  await setPool(ev.eventId, [])
  eq(mock.all('randomEvents').length, 0, '空数组＝清空')
})

add('随机事件：池子为空时抽取报错', async function () {
  const ev = await setupEvent(3)
  await expectErr(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ev.eventId }),
    'NO_RANDOM_EVENT')
  eq(mock.all('randomDraws').length, 0)
})

add('随机事件：抽取会落库，并把效果计入积分榜', async function () {
  const ctx = await setupTournament([2, 2])
  await setPool(ctx.eventId, [eventDef([ctx.ids[0]], -2, '踩线扣分')])

  const d = await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ctx.eventId }))
  eq(d.draw.text, '踩线扣分')
  eq(d.draw.delta, -2)
  eq(d.draw.deltaText, '-2')
  eq(d.draw.names.length, 1)
  eq(d.poolSize, 1)

  const rows = mock.all('randomDraws')
  eq(rows.length, 1, '触发记录落库')
  eq(rows[0].eventId, ctx.eventId)
  eq(rows[0].delta, -2)

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  const r = board.rows.filter(function (x) { return x.signupId === ctx.ids[0] })[0]
  eq(r.eventDelta, -2, '事件调整分')
  eq(r.eventCount, 1)
  eq(r.matchPoints, 0, '还没打比赛')
  eq(r.points, -2)
  // 别人不受影响
  const other = board.rows.filter(function (x) { return x.signupId === ctx.ids[1] })[0]
  eq(other.eventDelta, 0)
  // 最近触发记录也一并返回（参与者可见的趣味信息）
  eq(board.recentDraws.length, 1)
  eq(board.recentDraws[0].text, '踩线扣分')
})

add('随机事件：和比赛积分合并，总分 = 比赛分 + 事件调整', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))
  // 参赛的两队：teams[0] 是 ids[0..1]（胜，各 +3），teams[1] 是 ids[2..3]（负，各 +1）
  const winA = ctx.teams[0].memberIds[0]
  const winB = ctx.teams[0].memberIds[1]
  const loseA = ctx.teams[1].memberIds[0]

  // 给「一个胜方的人」和「一个败方的人」各 +2
  await setPool(ctx.eventId, [eventDef([winA, loseA], 2, '趣味加分')])
  await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ctx.eventId }))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  function row (id) { return board.rows.filter(function (x) { return x.signupId === id })[0] }

  eq(row(winA).matchPoints, 3)
  eq(row(winA).eventDelta, 2)
  eq(row(winA).points, 5, '总分要把两边加起来')
  eq(row(loseA).matchPoints, 1)
  eq(row(loseA).eventDelta, 2)
  eq(row(loseA).points, 3)
  // 没被抽中的人不受影响
  eq(row(winB).matchPoints, 3)
  eq(row(winB).eventDelta, 0)
  eq(row(winB).points, 3)

  // 排序按最终总分：winA(5) > loseA(3) = winB(3) > 另一个败方(1)
  eq(board.rows[0].signupId, winA, '加了事件分的排最前')
})

add('随机事件：抽取是随机的，池子里的事件都会有机会被抽到', async function () {
  const ev = await setupEvent(3)
  await setPool(ev.eventId, [
    eventDef([ev.ids[0]], 1, '甲'),
    eventDef([ev.ids[1]], 2, '乙'),
  ])

  const seen = {}
  for (let i = 0; i < 60; i++) {
    const d = await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ev.eventId }))
    seen[d.draw.text] = true
  }
  eq(mock.all('randomDraws').length, 60, '每次都留一条记录')
  ok(seen['甲'] && seen['乙'], '两个事件都该被抽到过：' + JSON.stringify(Object.keys(seen)))
})

add('随机事件：撤销记录后调整分随之消失（积分是实时推导的）', async function () {
  const ctx = await setupTournament([2, 2])
  await setPool(ctx.eventId, [eventDef([ctx.ids[0]], -3, '扣分')])
  const d = await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ctx.eventId }))

  let board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.rows.filter(function (x) { return x.signupId === ctx.ids[0] })[0].points, -3)

  await expectOk(as(OWNER, hatMatch, 'removeDraw', {
    eventId: ctx.eventId, drawId: d.draw._id,
  }))
  eq(mock.all('randomDraws').length, 0)

  board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  const r = board.rows.filter(function (x) { return x.signupId === ctx.ids[0] })[0]
  eq(r.points, 0)
  eq(r.eventDelta, 0)
  eq(r.eventCount, 0)
})

add('随机事件：撤销的边界——缺 id、不存在、跨活动', async function () {
  const a = await setupTournament([2, 2])
  const b = await setupTournament([2, 2], { name: '别的活动' })
  await setPool(a.eventId, [eventDef([a.ids[0]], 1)])
  const d = await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: a.eventId }))

  await expectErr(as(OWNER, hatMatch, 'removeDraw',
    { eventId: a.eventId, drawId: '' }), 'INVALID_INPUT', '缺 id')
  await expectErr(as(OWNER, hatMatch, 'removeDraw',
    { eventId: a.eventId, drawId: 'ghost' }), 'NOT_FOUND')
  await expectErr(as(OWNER, hatMatch, 'removeDraw',
    { eventId: b.eventId, drawId: d.draw._id }), 'FORBIDDEN', '不属于这场活动')
  eq(mock.all('randomDraws').length, 1, '都没删掉')
})

add('随机事件：参与者能看触发记录（含人名不含水平），但要分队已发布', async function () {
  const ctx = await setupTournament([2, 2])
  await setPool(ctx.eventId, [eventDef([ctx.ids[0], ctx.ids[1]], -1, '穿错颜色')])
  await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ctx.eventId }))

  // 已发布：参与者能看
  let d = await expectOk(as('player-0', hatMatch, 'listDraws', { eventId: ctx.eventId }))
  eq(d.list.length, 1)
  eq(d.list[0].text, '穿错颜色')
  eq(d.list[0].deltaText, '-1')
  eq(d.list[0].names.length, 2)
  ok(JSON.stringify(d).indexOf('level') < 0, '触发记录不该带水平')
  ok(JSON.stringify(d).indexOf('openid') < 0, '也不该带 openid')

  // 撤销发布后参与者看不到了
  await expectOk(as(OWNER, hatTeam, 'unpublish', { tournamentId: ctx.tournamentId }))
  await expectErr(as('player-0', hatMatch, 'listDraws', { eventId: ctx.eventId }),
    'DIVISION_NOT_PUBLISHED')
  // 组织者仍然能看
  await expectOk(as(OWNER, hatMatch, 'listDraws', { eventId: ctx.eventId }))
})

add('随机事件：弃赛归零会把事件调整一起归零，但数额仍然留档', async function () {
  const ctx = await setupTournament([2, 2])
  const victim = ctx.teams[0].memberIds[0]
  // 弃赛的人必须不在上场名单里，所以 A 队只派另一个人上场
  const lineupA = ctx.teams[0].memberIds.slice(1)

  await setPool(ctx.eventId, [eventDef([victim], 5, '大奖')])
  await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ctx.eventId }))

  // 第 1 场：弃赛一次
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsA: lineupA, forfeitIds: [victim],
  })))

  let board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  let r = board.rows.filter(function (x) { return x.signupId === victim })[0]
  eq(r.forfeitCount, 1, '同一场只算一次弃赛')
  eq(r.points, 2, '还没到两次：事件 +5 与弃赛 -3 都算上')

  // 第 2 场：再弃赛一次，凑满 2 次
  const t2 = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ctx.eventId, name: '第 2 场', teamCount: 2, attendeeIds: ctx.ids,
  }))
  const div2 = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t2._id, teams: ctx.teams,
  }))
  await expectOk(as(OWNER, hatTeam, 'publish', { tournamentId: t2._id, divisionId: div2._id }))
  await expectOk(as(OWNER, hatMatch, 'saveMatch',
    matchData(Object.assign({}, ctx, { tournamentId: t2._id }), {
      participantsA: lineupA, forfeitIds: [victim],
    })))

  board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  r = board.rows.filter(function (x) { return x.signupId === victim })[0]
  eq(r.forfeitCount, 2)
  eq(r.reset, true, '要标出归零了')
  eq(r.points, 0, '最终积分归零（连事件调整一起）')
  eq(r.eventDelta, 5, '事件调整的数额仍留档，能解释这笔分怎么没的')
  eq(board.totals.eventResetCount, 1)
})

add('随机事件：删报名会把他从触发名单里摘掉，摘空就整条删除', async function () {
  const ev = await setupEvent(4)
  await setPool(ev.eventId, [
    eventDef([ev.ids[0], ev.ids[1]], -1, '两人事件'),
    eventDef([ev.ids[0]], 2, '单人事件'),
  ])

  const d = await expectOk(as(OWNER, hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[0] }))
  eq(d.randomEventsTouched, 2, '两条事件都涉及他')

  const left = mock.all('randomEvents')
  eq(left.length, 1, '只剩 1 人的那条被删掉')
  eq(left[0].text, '两人事件')
  eq(left[0].signupIds.length, 1)
  eq(left[0].signupIds[0], ev.ids[1], '留下的是别人')
})

add('随机事件：清理测试数据时同样摘除，不留悬空引用', async function () {
  // 上限 4、已有 2 个真人 → 正好还能塞 2 个测试报名
  const ev = await setupEvent(2)
  const added = await expectOk(as(ADMIN, hatSignup, 'seedTestSignups',
    { eventId: ev.eventId, count: 2 }))
  eq(added.added, 2)

  const testIds = mock.all('signups')
    .filter(function (s) { return s.isTest })
    .map(function (s) { return s._id })
  await setPool(ev.eventId, [
    eventDef(testIds.concat([ev.ids[0]]), -1, '混着真人和测试'),
    eventDef([testIds[0]], 1, '只有测试'),
  ])

  await expectOk(as(ADMIN, hatSignup, 'clearTestSignups', { eventId: ev.eventId }))
  const left = mock.all('randomEvents')
  eq(left.length, 1, '纯测试的那条被删掉')
  eq(left[0].signupIds.length, 1, '混着的只剩真人')
  eq(left[0].signupIds[0], ev.ids[0])
})

add('随机事件：删活动会连带清掉事件池与触发记录', async function () {
  const ctx = await setupTournament([2, 2])
  await setPool(ctx.eventId, [eventDef([ctx.ids[0]], 1)])
  await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ctx.eventId }))
  eq(mock.all('randomEvents').length, 1)
  eq(mock.all('randomDraws').length, 1)

  await expectOk(as(OWNER, hatEvent, 'remove', { eventId: ctx.eventId }))
  eq(mock.all('randomEvents').length, 0, '事件池要清掉')
  eq(mock.all('randomDraws').length, 0, '触发记录要清掉')
})

add('随机事件：触发名单里有人退出后，抽取只作用于还在的人', async function () {
  const ev = await setupEvent(4)
  await setPool(ev.eventId, [eventDef([ev.ids[0], ev.ids[1]], -1)])

  // 直接删掉报名会被拦（没进检录，所以这里能删）
  await expectOk(as(OWNER, hatSignup, 'removeSignup',
    { eventId: ev.eventId, signupId: ev.ids[1] }))

  const d = await expectOk(as(OWNER, hatMatch, 'drawRandomEvent', { eventId: ev.eventId }))
  eq(d.draw.names.length, 1)
  eq(d.draw.names[0], '球员0', '只剩还在的人')

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ev.eventId }))
  eq(board.rows.filter(function (x) { return x.signupId === ev.ids[0] })[0].points, -1)
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
  const ev = await setupEvent(total, o.eventOver)

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

add('经典 HAT：只允许一个赛事', async function () {
  const ev = await setupEvent(6, { type: 'classic' })
  const base = { eventId: ev.eventId, teamCount: 2, attendeeIds: ev.ids }
  await expectOk(as(OWNER, hatTeam, 'createTournament',
    Object.assign({}, base, { name: '第 1 场' })))
  await expectErr(as(OWNER, hatTeam, 'createTournament',
    Object.assign({}, base, { name: '第 2 场' })),
    'CLASSIC_SINGLE_TOURNAMENT', '经典 HAT 不能开第二场赛事')

  // 但"重新分队"仍然允许：那只是修正同一场赛事的名单，不算再分一次
  const list = await expectOk(as(OWNER, hatTeam, 'listTournaments', { eventId: ev.eventId }))
  eq(list.eventType, 'classic')
  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: list.list[0]._id,
    teams: [{ name: 'A', memberIds: ev.ids.slice(0, 3) },
      { name: 'B', memberIds: ev.ids.slice(3) }],
  }), '重新分队')
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
  // 三个报过名的人 + 建活动的 OWNER + 当前管理员（后两者没有报名记录，靠角色列出来）
  eq(users.list.length, 5, '报过名的三个人 + 两个只有角色的人')
  const signed = users.list.filter(function (u) { return !u.noSignup })
  eq(signed.length, 3, '有报名记录的正好三个')
  ok(signed.every(function (u) { return !u.isOrganizer }), '默认都不是组织者')

  const target = signed[0]
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

add('管理台：组织者和管理员能打开不是自己创建的活动', async function () {
  // 活动是 OWNER 建的，org 不是创建者
  const ctx = await setupTournament([2, 2])
  const org = 'player-0'
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', { openid: org, isOrganizer: true }))

  // manage 页打开时会调这几个接口，任何一个被拒都会让管理台打不开
  const detail = await expectOk(as(org, hatEvent, 'detail', { eventId: ctx.eventId }))
  eq(detail.canManage, true, '管理台入口看 canManage')
  eq(detail.isOwner, false, '他不是创建者')
  await expectOk(as(org, hatSignup, 'listAll', { eventId: ctx.eventId }), '读名单')
  await expectOk(as(org, hatTeam, 'listConstraints', { eventId: ctx.eventId }), '读约束')
  eq((await expectOk(as(org, hatAdmin, 'whoami', {}))).isOrganizer, true)

  // 管理员同理
  const adminDetail = await expectOk(as(ADMIN, hatEvent, 'detail', { eventId: ctx.eventId }))
  eq(adminDetail.canManage, true)
  eq(adminDetail.isOwner, false)
  await expectOk(as(ADMIN, hatSignup, 'listAll', { eventId: ctx.eventId }))

  // 既没角色也不是创建者的人打不开（管理台里的接口照样拦得住）
  eq((await expectOk(as('player-1', hatEvent, 'detail', { eventId: ctx.eventId }))).canManage,
    false, '一般用户没有管理权')
  await expectErr(as('player-1', hatSignup, 'listAll', { eventId: ctx.eventId }),
    'FORBIDDEN', '一般用户读不到名单')
})

add('比赛中允许平局：逐分暂存在持平状态下也能存住', async function () {
  const ctx = await setupTournament([2, 2])
  const A = ctx.teams[0].memberIds
  const B = ctx.teams[1].memberIds

  // 1:1 —— 这正是原来手动暂存失败、自动保存一存就报错的场景
  const live = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [
      { team: 'A', scorer: A[0], assist: null },
      { team: 'B', scorer: B[0], assist: null },
    ],
    status: 'live',
  })), '比赛中要允许平局')

  const doc = mock.get('matches', live._id)
  eq(doc.scoreA, 1)
  eq(doc.scoreB, 1)
  eq(doc.status, 'live')

  // 平局不计胜负分，所以积分榜上还没人拿到分
  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.totals.matchCount, 0, '平局不计分')
  eq(board.liveMatchCount, 1)

  // 比赛结束仍然不允许平局
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: live._id,
    points: [
      { team: 'A', scorer: A[0], assist: null },
      { team: 'B', scorer: B[0], assist: null },
    ],
    status: 'finished',
  })), 'DRAW_NOT_ALLOWED', '结束的比赛不能是平局')

  // 补一分就能结束
  const done = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: live._id,
    points: [
      { team: 'A', scorer: A[0], assist: null },
      { team: 'B', scorer: B[0], assist: null },
      { team: 'A', scorer: A[1], assist: null },
    ],
    status: 'finished',
  })))
  eq(done.status, 'finished')
  eq(mock.get('matches', live._id).scoreA, 2)
})

add('比赛中平局时也允许带 MVP（只能选本场上过场的人）', async function () {
  const ctx = await setupTournament([2, 2])
  const A = ctx.teams[0].memberIds
  const B = ctx.teams[1].memberIds

  // 平局时没有"败方"，不应该因为 MVP 落在哪一方而整场保存失败
  const live = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [
      { team: 'A', scorer: A[0], assist: null },
      { team: 'B', scorer: B[0], assist: null },
    ],
    mvpIds: [A[1]],
    status: 'live',
  })), '平局时可以暂存 MVP')
  eq(mock.get('matches', live._id).mvpIds.length, 1)

  // 但不能是本场没上过场的人
  const bench = ctx.ids.filter(function (id) {
    return ctx.teams[0].memberIds.indexOf(id) < 0 &&
      ctx.teams[1].memberIds.indexOf(id) < 0
  })[0]
  if (bench) {
    await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
      matchId: live._id,
      points: [
        { team: 'A', scorer: A[0], assist: null },
        { team: 'B', scorer: B[0], assist: null },
      ],
      mvpIds: [bench],
      status: 'live',
    })), 'INVALID_MVP')
  }
})

add('自动暂存：反复保存同一场只更新一条记录，不会多出比赛', async function () {
  const ctx = await setupTournament([2, 2])
  const A = ctx.teams[0].memberIds
  const B = ctx.teams[1].memberIds

  let id = null
  const seq = [
    [{ team: 'A', scorer: A[0], assist: null }],
    [{ team: 'A', scorer: A[0], assist: null }, { team: 'B', scorer: B[0], assist: null }],
    [{ team: 'A', scorer: A[0], assist: null }, { team: 'B', scorer: B[0], assist: null },
      { team: 'A', scorer: A[1], assist: A[0] }],
  ]
  for (let i = 0; i < seq.length; i++) {
    const r = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
      matchId: id, points: seq[i], status: 'live',
    })))
    id = r._id
    eq(mock.all('matches').length, 1, '第 ' + (i + 1) + ' 次暂存后仍然只有一条记录')
  }
  const doc = mock.get('matches', id)
  eq(doc.points.length, 3, '存下的是最后一次的完整明细')
  eq(doc.scoreA, 2)
  eq(doc.scoreB, 1)
  eq(doc.status, 'live')
})

add('后台用户列表：报名记录被删光后，组织者仍要出现在列表里', async function () {
  const ev = await setupEvent(2)
  const target = (await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))).list[0]

  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', {
    openid: target.openid, name: target.name, isOrganizer: true,
  }))

  // 把他所有报名记录都删掉（这正是 v1.1.1 报告的场景）
  const all = mock.all('signups').filter(function (s) { return s.openid === target.openid })
  ok(all.length > 0)
  for (let i = 0; i < all.length; i++) {
    await expectOk(as(ADMIN, hatSignup, 'removeSignup', {
      eventId: ev.eventId, signupId: all[i]._id,
    }))
  }
  eq(mock.all('signups').filter(function (s) { return s.openid === target.openid }).length, 0)

  // 权限确实还在
  const me = await expectOk(as(target.openid, hatAdmin, 'whoami', {}))
  eq(me.isOrganizer, true, '角色不会因为删报名而消失')

  // 但必须还能在列表里看到他、并且能撤销
  const after = await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))
  const row = after.list.filter(function (u) { return u.openid === target.openid })[0]
  ok(row, '只有角色的用户必须仍然列在后台名单里')
  eq(row.isOrganizer, true)
  eq(row.noSignup, true, '要标明他没有报名记录')
  eq(row.signupCount, 0)
  eq(row.name, target.name, '姓名取角色记录里存的')

  // 撤销之后他从"有角色"变成普通条目（仍然可以列出，因为角色没了就不再是无报名用户）
  await expectOk(as(ADMIN, hatAdmin, 'setOrganizer', {
    openid: target.openid, isOrganizer: false,
  }))
  const finalList = await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))
  const gone = finalList.list.filter(function (u) { return u.openid === target.openid })[0]
  ok(!gone || (!gone.isOrganizer && !gone.noSignup),
    '撤销后不该再以"无报名的组织者"出现')
})

add('后台用户列表：没有报名记录的管理员也要列出来', async function () {
  // 管理员在 mock 里没有报名记录（初始管理员名单是写死在云函数里的）
  const users = await expectOk(as(ADMIN, hatAdmin, 'listUsers', {}))
  const me = users.list.filter(function (u) { return u.openid === ADMIN })[0]
  ok(me, '管理员自己要出现在名单里，否则他不知道自己在名单中的什么位置')
  eq(me.isAdmin, true)
  eq(me.noSignup, true)
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

const ROSTER_ORDER = function (x, y) {
  return String(x).localeCompare(String(y), 'zh-Hans-CN')
}

/** 一队的人名是否按姓名升序。分队结果要发布给所有人看，不能按水平排。 */
function namesSorted (members) {
  const names = members.map(function (m) { return m.name })
  const sorted = names.slice().sort(ROSTER_ORDER)
  return names.join(',') === sorted.join(',')
}

add('分队名单按姓名排，不按水平排（防止公开评级）', async function () {
  const ctx = await setupTournament([2, 2])

  // 球员0 和 球员1 同队（名单是按报名顺序建的队）。
  // 故意让"姓名靠前的人水平低"：按姓名排是 [1, 5]，按水平排会变成 [5, 1]。
  const a0 = ctx.teams[0].memberIds[0]
  const a1 = ctx.teams[0].memberIds[1]
  await expectOk(as(OWNER, hatSignup, 'updateLevel', {
    eventId: ctx.eventId, signupId: a0, adminLevel: 1,
  }))
  await expectOk(as(OWNER, hatSignup, 'updateLevel', {
    eventId: ctx.eventId, signupId: a1, adminLevel: 5,
  }))

  const div = await expectOk(as(OWNER, hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  for (let i = 0; i < div.division.teams.length; i++) {
    ok(namesSorted(div.division.teams[i].members),
      '第 ' + (i + 1) + ' 队的人名应按姓名排序')
  }

  const teamA = div.division.teams.filter(function (t) {
    return t.members.some(function (m) { return m._id === a0 })
  })[0]
  ok(teamA, 'a0 应该在某一队里')
  const levels = teamA.members.map(function (m) { return m.level })
  eq(levels.join(','), '1,5',
    '按姓名排是 1、5；按水平排会变成 5、1。组织者仍看得到水平，只是不再用它排序')
})

add('参与者看到的名单同样是姓名序，且没有水平', async function () {
  const ctx = await setupTournament([2, 2])
  const before = await expectOk(as(OWNER, hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  await expectOk(as(OWNER, hatTeam, 'publish', {
    tournamentId: ctx.tournamentId, divisionId: before.division._id,
  }))

  const div = await expectOk(as('player-0', hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  eq(div.canSeeLevel, false)
  ok(JSON.stringify(div).indexOf('"level"') < 0, '参与者不该拿到 level')
  for (let i = 0; i < div.division.teams.length; i++) {
    ok(namesSorted(div.division.teams[i].members), '参与者看到的也是姓名序')
  }
})

add('高分线取赛前检录名单里的最高档，缺席的 L5 不影响本场', async function () {
  // setupEvent 的自评水平是 (i%5)+1 → 1,2,3,4,5,1
  const ev = await setupEvent(6)
  const absentL5 = ev.ids[4]          // 报了名但本场没检录
  const attend = ev.ids.slice(0, 4)   // 到场：1,2,3,4

  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: attend,
  }))
  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: t._id,
    teams: [
      { name: '1队', memberIds: [attend[0], attend[1]] },
      { name: '2队', memberIds: [attend[2], attend[3]] },
    ],
  }))

  const div = await expectOk(as(OWNER, hatTeam, 'getDivision', { tournamentId: t._id }))
  // 到场的最高是 L4，所以线是 4；缺席的 L5 不该把线钉到 5
  eq(div.division.starLevel, 4, '线按检录名单算，不看没来的人')
  const starTotal = div.division.teams.reduce(function (a, x) { return a + x.stats.star }, 0)
  eq(starTotal, 1, '到场 4 人里只有 1 个 L4')
  ok(mock.get('signups', absentL5).selfLevel === 5, '缺席的那位确实是 L5')
})

add('全员同档时没有高分：starLevel 为 null、star 均为 0', async function () {
  const ctx = await setupTournament([2, 2])
  // 把这场赛事 4 个人都调成 L3
  for (let i = 0; i < ctx.ids.length; i++) {
    await expectOk(as(OWNER, hatSignup, 'updateLevel', {
      eventId: ctx.eventId, signupId: ctx.ids[i], adminLevel: 3,
    }))
  }
  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: ctx.tournamentId,
    teams: [
      { name: '1队', memberIds: ctx.teams[0].memberIds },
      { name: '2队', memberIds: ctx.teams[1].memberIds },
    ],
  }))
  const div = await expectOk(as(OWNER, hatTeam, 'getDivision', { tournamentId: ctx.tournamentId }))
  eq(div.division.starLevel, null, '没有分档')
  for (let i = 0; i < div.division.teams.length; i++) {
    eq(div.division.teams[i].stats.star, 0, '同档时谁都不算高分')
  }
})

add('高分线属于水平信息，参与者拿不到', async function () {
  const ctx = await setupTournament([2, 2])
  for (let i = 0; i < ctx.ids.length; i++) {
    await expectOk(as(OWNER, hatSignup, 'updateLevel', {
      eventId: ctx.eventId, signupId: ctx.ids[i], adminLevel: i + 1,
    }))
  }
  const saved = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    tournamentId: ctx.tournamentId,
    teams: [
      { name: '1队', memberIds: ctx.teams[0].memberIds },
      { name: '2队', memberIds: ctx.teams[1].memberIds },
    ],
  }))
  await expectOk(as(OWNER, hatTeam, 'publish', {
    tournamentId: ctx.tournamentId, divisionId: saved._id,
  }))

  const mine = await expectOk(as('player-0', hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  eq(mine.canSeeLevel, false)
  eq(mine.division.starLevel, null, '高分线等于"最强的人有多强"，不能给参与者')
  ok(mine.division.teams[0].stats.star === undefined, '高分人数也不给')

  const org = await expectOk(as(OWNER, hatTeam, 'getDivision',
    { tournamentId: ctx.tournamentId }))
  eq(org.division.starLevel, 4, '组织者看得到线（4 人水平 1-4）')
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

add('积分榜：积分相同时按得分+助攻总数排名，且与数据页数字一致', async function () {
  const ctx = await setupTournament([2, 2])
  const winA = ctx.teams[0].memberIds     // 球员0、球员1
  const loseB = ctx.teams[1].memberIds    // 球员2、球员3

  // 只有一场比赛：A 队赢。球员2 是败方但进球 2 次，球员3 没有个人数据，
  // 两人都是 1 分 → 同分，应该按得分+助攻把球员2 排在球员3 前面。
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [
      { team: 'A', scorer: winA[0], assist: null },
      { team: 'A', scorer: winA[0], assist: null },
      { team: 'A', scorer: winA[0], assist: null },
      { team: 'B', scorer: loseB[0], assist: null },
      { team: 'B', scorer: loseB[0], assist: loseB[1] },
    ],
  })))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  const r2 = board.rows.filter(function (x) { return x.name === '球员2' })[0]
  const r3 = board.rows.filter(function (x) { return x.name === '球员3' })[0]
  eq(r2.points, 1)
  eq(r3.points, 1)
  eq(r2.total, 2, '球员2 进 2 球')
  eq(r3.total, 1, '球员3 助攻 1 次')
  ok(r2.rank < r3.rank, '同分时个人数据多的排前面')

  // 与得分助攻榜口径一致：同一个人在两张表上的得分/助攻必须一样
  const stats = await expectOk(as(OWNER, hatMatch, 'pointStats', { eventId: ctx.eventId }))
  stats.rows.forEach(function (s) {
    const row = board.rows.filter(function (x) { return x.signupId === s.signupId })[0]
    eq(row.goals, s.goals, s.name + ' 进球数')
    eq(row.assists, s.assists, s.name + ' 助攻数')
  })

  // 仍然是公开数据，不能顺带把水平带出去
  ok(JSON.stringify(board).indexOf('"level"') < 0, '积分榜不该带 level')
})

add('个人积分赛的积分榜仍然按个人排名', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {})))
  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.mode, 'personal')
  eq(board.rows.length, 4)
  ok(!board.teams, '个人榜不该带队伍战绩')
})

add('经典 HAT：名次页改为队伍战绩，按队伍顺序列胜负与净胜分', async function () {
  const ctx = await setupTournament([2, 2], { eventOver: { type: 'classic' } })

  // 队 1 赢 15:10；下一场队 1 输 11:13 → 各 1 胜 1 负，净胜分 +3 / -3
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: 15, scoreB: 10 })))
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: 11, scoreB: 13 })))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.mode, 'team')
  eq(board.eventType, 'classic')
  eq(board.matchCount, 2)
  eq(board.teams.length, 2)

  // 按队伍序号而不是胜负排序：分发名单是按序号念的
  eq(board.teams[0].name, '1队')
  eq(board.teams[0].won, 1)
  eq(board.teams[0].lost, 1)
  eq(board.teams[0].scoreFor, 26)
  eq(board.teams[0].scoreAgainst, 23)
  eq(board.teams[0].diff, 3)

  eq(board.teams[1].name, '2队')
  eq(board.teams[1].won, 1)
  eq(board.teams[1].lost, 1)
  eq(board.teams[1].diff, -3)

  // 参赛者（非组织者）看到的是同一份数据，且仍然不带球员水平
  mock.setOpenid('player-0')
  const pub = await expectOk(as('player-0', hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pub.mode, 'team')
  eq(pub.teams.length, 2)
  ok(JSON.stringify(pub).indexOf('"level"') < 0, '战绩榜不该带 level')
})

add('经典 HAT：还没分队时不报错，明确告诉前端还没分队', async function () {
  const ev = await setupEvent(4, { type: 'classic' })
  const t = await expectOk(as(OWNER, hatTeam, 'createTournament', {
    eventId: ev.eventId, name: '第 1 场', teamCount: 2, attendeeIds: ev.ids,
  }))
  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ev.eventId }))
  eq(board.mode, 'team')
  eq(board.hasDivision, false)
  eq(board.teams.length, 0)
  eq(board.matchCount, 0)
  ok(t._id, '赛事建出来了')
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

// ================================================================ 逐分记录（v1.1.0）

/** 造一串逐分记录：scoring 是 [['A', 队员下标, 助攻下标|null], ...] */
function pointList (ctx, scoring) {
  return scoring.map(function (s) {
    const team = s[0]
    const roster = team === 'A' ? ctx.teams[0].memberIds : ctx.teams[1].memberIds
    return {
      team: team,
      scorer: roster[s[1]],
      assist: s[2] === null || s[2] === undefined ? null : roster[s[2]],
    }
  })
}

add('逐分记录：比分由明细条数算出来，客户端传来的比分不采信', async function () {
  const ctx = await setupTournament([2, 2])
  // A 得 3 分（1 分有助攻），B 得 1 分
  const points = pointList(ctx, [['A', 0, 1], ['A', 1, 0], ['A', 0, null], ['B', 0, null]])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: points,
    // 故意传一组错比分：云函数应当按明细重算，不能让客户端改比分
    scoreA: 99,
    scoreB: 0,
  })))

  const doc = mock.get('matches', saved._id)
  eq(doc.scoreA, 3, '按明细重算 A 的比分')
  eq(doc.scoreB, 1, '按明细重算 B 的比分')
  eq(doc.points.length, 4, '明细原样入库')
  eq(doc.points[0].assist, ctx.teams[0].memberIds[1], '助攻记下了')

  const list = await expectOk(as(OWNER, hatMatch, 'listMatches',
    { tournamentId: ctx.tournamentId }))
  eq(list.list[0].scoreA, 3)
  eq(list.list[0].hasPoints, true)
  eq(list.list[0].points.length, 4)
  eq(list.list[0].points[0].scorer.name, '球员0')
  eq(list.list[0].points[2].assist, null, '没助攻时是 null')
})

add('逐分记录也能正常算积分：得分队员算上场，比分照旧推导胜负', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: pointList(ctx, [['A', 0, 1], ['A', 1, null], ['A', 0, null], ['B', 0, null]]),
    mvpIds: [ctx.teams[1].memberIds[0]],
  })))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  // A 方两人各 3 分，B 方一人 1 分 + 1 MVP
  eq(pointsOf(board, '球员0'), 3)
  eq(pointsOf(board, '球员1'), 3)
  eq(pointsOf(board, '球员2'), 2)
  eq(board.totals.matchCount, 1)
})

add('逐分记录：得分/助攻队员必须是本场上场的人', async function () {
  const ctx = await setupTournament([2, 2])
  const outsider = ctx.ids[ctx.ids.length - 1]

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [{ team: 'A', scorer: outsider, assist: null }],
  })), 'INVALID_POINT', '得分队员不在上场名单')

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [{ team: 'A', scorer: ctx.teams[0].memberIds[0], assist: outsider }],
  })), 'INVALID_POINT', '助攻队员不在上场名单')

  // 拿 B 队的人当 A 队的得分队员同样不行
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [{ team: 'A', scorer: ctx.teams[1].memberIds[0], assist: null }],
  })), 'INVALID_POINT', '别队的人不能算进 A 队的得分')
})

add('逐分记录：得分和助攻不能是同一人，队伍必须合法', async function () {
  const ctx = await setupTournament([2, 2])
  const me = ctx.teams[0].memberIds[0]

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [{ team: 'A', scorer: me, assist: me }],
  })), 'INVALID_POINT', '自助攻')

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [{ team: 'C', scorer: me, assist: null }],
  })), 'INVALID_POINT', '队伍只能是 A/B')

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [{ team: 'A', scorer: '', assist: null }],
  })), 'INVALID_POINT', '缺得分队员')
})

add('逐分记录：平局和超出上限都被拒', async function () {
  const ctx = await setupTournament([2, 2])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: pointList(ctx, [['A', 0, null], ['B', 0, null]]),
  })), 'DRAW_NOT_ALLOWED', '明细记成平局')

  const many = []
  for (let i = 0; i < 201; i++) {
    many.push({ team: 'A', scorer: ctx.teams[0].memberIds[0], assist: null })
  }
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { points: many })),
    'INVALID_INPUT', '超出单场上限')
})

add('逐分记录：弃赛和上场互斥，所以弃赛的人不可能有得分记录', async function () {
  const ctx = await setupTournament([2, 2])
  const A = ctx.teams[0].memberIds
  // A 队只派一个人上场，队友记弃赛
  const benched = A[1]

  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsA: [A[0]],
    points: [{ team: 'A', scorer: A[0], assist: null },
      { team: 'A', scorer: A[0], assist: null },
      { team: 'B', scorer: ctx.teams[1].memberIds[0], assist: null }],
    forfeitIds: [benched],
  })), '没上场的人可以记弃赛')

  // 反过来：既在上场名单里又记弃赛 → 直接报错
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    forfeitIds: [A[0]],
  })), 'INVALID_FORFEIT', '上场的人不能记弃赛')

  // 弃赛的人也不可能出现在得分明细里——他不在上场名单，两种错都会挡住
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsA: [A[0]],
    points: [{ team: 'A', scorer: benched, assist: null },
      { team: 'B', scorer: ctx.teams[1].memberIds[0], assist: null }],
  })), 'INVALID_POINT', '弃赛的人算不得分')
})

add('比赛状态：比赛中存 live，结束后存 finished；老前端不传按 finished', async function () {
  const ctx = await setupTournament([2, 2])

  const live = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: pointList(ctx, [['A', 0, null], ['A', 1, null], ['B', 0, null]]),
    status: 'live',
  })))
  eq(mock.get('matches', live._id).status, 'live')

  let list = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  eq(list.list[0].status, 'live')

  // 比赛中的比赛也计分——否则记分员忘了点「比赛结束」就会静默少分
  let board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.liveMatchCount, 1, '要告诉前端还有几场没结束')
  eq(pointsOf(board, '球员0'), 3)

  // 结束它
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: live._id,
    points: pointList(ctx, [['A', 0, null], ['A', 1, null], ['A', 0, null], ['B', 0, null]]),
    status: 'finished',
  })))
  list = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  eq(list.list[0].status, 'finished')
  board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.liveMatchCount, 0)

  // 不传 status 的一律当已结束（老前端、以及历史数据）
  const legacy = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: live._id, points: pointList(ctx, [['A', 0, null], ['B', 0, null], ['A', 1, null]]),
  })))
  eq(legacy.status, 'finished')
  eq(mock.get('matches', live._id).status, 'finished')

  // 历史数据没有 status 字段，不能被当成"比赛中"
  mock.insert('matches', {
    tournamentId: ctx.tournamentId, eventId: ctx.eventId,
    teamAIndex: 0, teamBIndex: 1, scoreA: 15, scoreB: 10,
    participantsA: ctx.teams[0].memberIds, participantsB: ctx.teams[1].memberIds,
    mvpIds: [], forfeitIds: [], createTime: Date.now(),
  })
  const all = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  const noStatus = all.list.filter(function (m) { return !m.hasPoints && m.scoreA === 15 })[0]
  eq(noStatus.status, 'finished', '没有 status 的历史记录算已结束')
})

add('老比赛没有明细：照样计入积分，但不进得分助攻榜', async function () {
  const ctx = await setupTournament([2, 2])
  // 不带 points 的提交就是 v1.1.0 之前的老前端行为
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.totals.matchCount, 1, '积分照算')
  eq(pointsOf(board, '球员0'), 3)

  const stats = await expectOk(as(OWNER, hatMatch, 'pointStats', { eventId: ctx.eventId }))
  eq(stats.matchCount, 1, '赛事里确实有 1 场')
  eq(stats.totals.matchCount, 0, '但没有明细，进不了统计')
  eq(stats.totals.pointCount, 0)
  stats.rows.forEach(function (r) { eq(r.goals, 0, r.name) })
})

add('老比赛（无明细）仍可编辑：只改 MVP / 弃赛时比分原样保留', async function () {
  const ctx = await setupTournament([2, 2])
  // 老前端提交方式：没有 points，手填 15:10
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))
  eq(mock.get('matches', saved._id).scoreA, 15)

  // 前端补录 MVP 时会连明细一起提交（老比赛没有明细，就是空数组），
  // 比分也必须原样带回来——否则会被算成 0:0 而拒绝保存。
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: saved._id,
    points: [],
    mvpIds: [ctx.teams[1].memberIds[0]],
  })), '老比赛要能补录 MVP')

  const doc = mock.get('matches', saved._id)
  eq(doc.scoreA, 15, '比分不能被明细覆盖成 0')
  eq(doc.scoreB, 10)
  eq(doc.points.length, 0)

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员2'), 2, '原有积分 + MVP 都还在')
})

add('得分助攻榜：按逐分记录汇总，含三张榜需要的数据', async function () {
  const ctx = await setupTournament([2, 2])
  const A = ctx.teams[0].memberIds
  const B = ctx.teams[1].memberIds

  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [
      { team: 'A', scorer: A[0], assist: A[1] },
      { team: 'A', scorer: A[0], assist: null },
      { team: 'A', scorer: A[1], assist: A[0] },
      { team: 'B', scorer: B[0], assist: B[1] },
    ],
  })))

  const stats = await expectOk(as(OWNER, hatMatch, 'pointStats', { eventId: ctx.eventId }))
  eq(stats.totals.matchCount, 1)
  eq(stats.totals.pointCount, 4)
  eq(stats.matchCount, 1)

  function row (id) {
    return stats.rows.filter(function (r) { return r.signupId === id })[0]
  }
  eq(row(A[0]).goals, 2)
  eq(row(A[0]).assists, 1)
  eq(row(A[0]).total, 3)
  eq(row(A[1]).goals, 1)
  eq(row(A[1]).assists, 1)
  eq(row(B[1]).goals, 0)
  eq(row(B[1]).assists, 1)
  // 榜单里不能有水平
  ok(JSON.stringify(stats).indexOf('level') < 0, '得分榜不该带 level')
})

add('我的数据：只返回自己的数据，含逐场明细', async function () {
  const ctx = await setupTournament([2, 2])
  const A = ctx.teams[0].memberIds
  const B = ctx.teams[1].memberIds

  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: [
      { team: 'A', scorer: A[0], assist: A[1] },
      { team: 'A', scorer: A[0], assist: null },
      { team: 'A', scorer: A[1], assist: A[0] },
      { team: 'B', scorer: B[0], assist: null },
    ],
  })))

  const mine = await expectOk(as('player-0', hatMatch, 'myStats', { eventId: ctx.eventId }))
  eq(mine.found, true)
  eq(mine.me.name, '球员0')
  eq(mine.me.goals, 2)
  eq(mine.me.assists, 1)
  eq(mine.me.total, 3)
  eq(mine.me.matchCount, 1)
  eq(mine.me.matches.length, 1)
  eq(mine.me.matches[0].goals, 2)
  eq(mine.me.matches[0].assists, 1)
  eq(mine.me.matches[0].tournamentName, '第 1 场')
  ok(JSON.stringify(mine).indexOf('level') < 0)

  // 换个人看到的是他自己那份
  const other = await expectOk(as('player-1', hatMatch, 'myStats', { eventId: ctx.eventId }))
  eq(other.me.name, '球员1')
  eq(other.me.goals, 1)
  eq(other.me.assists, 1)
})

add('我的数据：没报名、以及老比赛（无明细）的处理', async function () {
  const ctx = await setupTournament([2, 2])

  // 没报名的人
  const none = await expectOk(as(ALICE, hatMatch, 'myStats', { eventId: ctx.eventId }))
  eq(none.found, false)
  eq(none.me, null)

  // 老比赛没有明细：逐场明细里仍要出现（标明无明细），但得分助攻是 0
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))
  const mine = await expectOk(as('player-0', hatMatch, 'myStats', { eventId: ctx.eventId }))
  eq(mine.found, true)
  eq(mine.me.goals, 0)
  eq(mine.me.matchCount, 0, '没有明细的比赛不进"有数据的场次"')
  eq(mine.me.matches.length, 1, '但要出现在逐场明细里')
  eq(mine.me.matches[0].hasPoints, false)
})

add('得分助攻榜和我的数据：一般参与者也能看（不需要管理权限）', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: pointList(ctx, [['A', 0, 1], ['A', 1, null], ['B', 0, null]]),
  })))

  await expectOk(as('player-0', hatMatch, 'pointStats', { eventId: ctx.eventId }))
  await expectOk(as('player-0', hatMatch, 'myStats', { eventId: ctx.eventId }))
})

add('得分助攻榜：分队未发布时参与者看不到', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    points: pointList(ctx, [['A', 0, null], ['B', 0, null], ['A', 1, null]]),
  })))
  await expectOk(as(OWNER, hatTeam, 'unpublish', { tournamentId: ctx.tournamentId }))

  await expectErr(as('player-0', hatMatch, 'pointStats', { eventId: ctx.eventId }),
    'DIVISION_NOT_PUBLISHED')
  // 自己的数据不受这个限制
  await expectOk(as('player-0', hatMatch, 'myStats', { eventId: ctx.eventId }))
  // 组织者照样能看
  await expectOk(as(OWNER, hatMatch, 'pointStats', { eventId: ctx.eventId }))
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
  // 真人 + 建活动的 OWNER + 当前管理员；测试账号一个都不该出现
  eq(users.list.length, 3, '真人和两个只有角色的人')
  ok(users.list.some(function (u) { return u.openid === ALICE }), '真人要在列表里')
  eq(users.list.filter(function (u) { return u.noSignup }).length, 2, '没有报名记录的只有 OWNER 和管理员')
  ok(users.list.every(function (u) {
    return !u.isTest && u.openid.indexOf('test-') !== 0
  }), '测试数据不能出现在名单里')
})

// ================================================================ v1.1.3
// 活动类型 / 报名表字段配置 / 群聊可见 / 活动级比赛记录摘要

add('活动类型：新建活动是「个人积分赛」，老活动没有 type 也按它显示', async function () {
  const id = await createEvent()
  eq(mock.get('events', id).type, 'personal', 'type 要落库')

  const d = await expectOk(as(OWNER, hatEvent, 'detail', { eventId: id }))
  eq(d.event.type, 'personal')
  eq(d.event.typeLabel, '个人积分赛')

  const list = await expectOk(as(ALICE, hatEvent, 'list', {}))
  eq(list.list[0].typeLabel, '个人积分赛')

  // 模拟 v1.1.3 之前创建的活动：文档里根本没有 type 字段
  mock.update('events', id, { type: undefined })
  const old = await expectOk(as(OWNER, hatEvent, 'detail', { eventId: id }))
  eq(old.event.type, 'personal', '缺 type 一律当个人积分赛')
})

add('报名表字段：默认只采集手机号，其它可配置字段即使提交也被丢弃', async function () {
  const id = await createEvent()
  const d = await expectOk(as(OWNER, hatEvent, 'detail', { eventId: id }))
  eq(d.event.signupFields.phone.enabled, true, '手机号默认采集')
  eq(d.event.signupFields.phone.required, false, '但不必填')
  eq(d.event.signupFields.age.enabled, false, '年龄默认不采集')

  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm({
    age: 24, className: '高一(3)班', studentId: '20240101',
  }))))
  const s = mock.all('signups')[0]
  eq(s.age, null, '不采集的字段不能留在库里')
  eq(s.className, '')
  eq(s.studentId, '')
  eq(s.phone, '13800000000', '采集的字段照常保存')
})

add('报名表字段：组织者开启并设必填后，缺项会被挡下', async function () {
  const id = await createEvent({
    signupFields: {
      age: { enabled: true, required: true },
      phone: { enabled: false, required: false },
      className: { enabled: true, required: false },
    },
  })

  await expectErr(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())),
    'INVALID_INPUT', '年龄必填但没填')
  await expectErr(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm({
    age: 200,
  }))), 'INVALID_INPUT', '年龄超范围')
  await expectErr(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm({
    age: 'abc',
  }))), 'INVALID_INPUT', '年龄不是数字')

  // 关掉手机号采集后，提交的手机号不应被保存，也不该因为格式不对而报错
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm({
    age: 24, phone: 'abcdefg',
  }))))
  const s = mock.all('signups')[0]
  eq(s.age, 24)
  eq(s.phone, '', '关掉采集的字段不保存')
  eq(s.className, '', '可选的班级可以不填')
})

add('报名表字段：班级/学号按长度校验，且组织者能在名单里看到', async function () {
  const id = await createEvent({
    signupFields: {
      className: { enabled: true, required: true },
      studentId: { enabled: true, required: false },
    },
  })
  await expectErr(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm({
    className: 'x'.repeat(31),
  }))), 'INVALID_INPUT', '班级超长')

  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm({
    className: '高一(3)班', studentId: '20240101',
  }))))
  const roster = await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))
  eq(roster.list[0].className, '高一(3)班')
  eq(roster.list[0].studentId, '20240101')
  eq(roster.list[0].age, '', '没采集的年龄不返回')

  // 参与者自己也能在详情里看到自己填的内容
  const mine = await expectOk(as(ALICE, hatEvent, 'detail', { eventId: id }))
  eq(mine.mySignup.className, '高一(3)班')
})

add('报名表字段：老活动没有配置时行为与升级前一致', async function () {
  const id = await createEvent()
  // 模拟老文档：完全没有 signupFields
  mock.update('events', id, { signupFields: undefined })
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  await expectErr(as(BOB, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm({
    phone: 'abcdefg',
  }))), 'INVALID_INPUT', '手机号格式仍然校验')
})

add('群聊可见：不进公开列表，没有口令打不开，有口令打开后就能看到', async function () {
  const id = await createEvent({ visibility: 'group' })
  const doc = mock.get('events', id)
  eq(doc.visibility, 'group')
  ok(doc.shareToken && doc.shareToken.length >= 16, '要有足够长的分享口令')
  eq(doc.visitors.length, 0)

  // 没进来过的人：列表里看不到
  const before = await expectOk(as(ALICE, hatEvent, 'list', {}))
  eq(before.list.length, 0, '群内活动不能出现在公开列表里')

  // 没有口令 / 口令错误：详情被拒
  await expectErr(as(ALICE, hatEvent, 'detail', { eventId: id }), 'FORBIDDEN')
  await expectErr(as(ALICE, hatEvent, 'detail', { eventId: id, t: 'wrong-token' }), 'FORBIDDEN')

  // 口令正确：能进，并且被记下来
  const d = await expectOk(as(ALICE, hatEvent, 'detail', { eventId: id, t: doc.shareToken }))
  eq(d.event.name, '周六晚 HAT 局')
  eq(d.shareToken, doc.shareToken, '要把口令回传，好让他继续分享')

  const after = await expectOk(as(ALICE, hatEvent, 'list', {}))
  eq(after.list.length, 1, '进来过之后就应该出现在他的活动列表里')
  eq(after.list[0].groupOnly, true)

  // 别人还是看不到
  const others = await expectOk(as(BOB, hatEvent, 'list', {}))
  eq(others.list.length, 0)
})

add('报名表字段：老前端不传配置时，编辑活动不会把已有配置重置掉', async function () {
  const id = await createEvent({
    signupFields: {
      age: { enabled: true, required: true },
      className: { enabled: true, required: false },
    },
  })
  // 模拟旧版前端：提交一个不含 signupFields / visibility 的表单
  const form = eventForm({ name: '改个名字' })
  const res = await expectOk(as(OWNER, hatEvent, 'update',
    Object.assign({ eventId: id }, form)), '更新活动')
  ok(res._id)

  const doc = mock.get('events', id)
  eq(doc.name, '改个名字')
  eq(doc.signupFields.age.enabled, true, '没传配置就保持原样')
  eq(doc.signupFields.age.required, true)
  eq(doc.signupFields.className.enabled, true)
  eq(doc.signupFields.phone.enabled, true, '默认字段也要在')
})

add('群聊可见：管理身份始终可见', async function () {
  const id = await createEvent({ visibility: 'group' })

  // 组织者和管理员本来就能管所有活动
  const byOwner = await expectOk(as(OWNER, hatEvent, 'list', {}))
  eq(byOwner.list.length, 1)
  const byAdmin = await expectOk(as(ADMIN, hatEvent, 'detail', { eventId: id }))
  eq(byAdmin.canManage, true)

  // 参与者（没进来过）一律看不到
  const byAlice = await expectOk(as(ALICE, hatEvent, 'list', {}))
  eq(byAlice.list.length, 0)
})

add('群聊可见：已报名的人即使没有口令也能看', async function () {
  const id = await createEvent({ visibility: 'group' })
  const token = mock.get('events', id).shareToken
  // 报名本身不需要"能看到"——他被分享了链接才来报名；这里直接造一条报名
  mock.insert('signups', {
    eventId: id, openid: ALICE, name: '张三', gender: 'M', selfLevel: 3,
    adminLevel: null, phone: '', remark: '', status: 'signed', createTime: Date.now(),
  })
  const d = await expectOk(as(ALICE, hatEvent, 'detail', { eventId: id }))
  eq(d.mySignup.name, '张三', '报过名就看得到，不需要再带口令')
  const list = await expectOk(as(ALICE, hatEvent, 'list', {}))
  eq(list.list.length, 1)
  ok(token)
})

add('群聊可见：公开活动不受影响，口令字段为空', async function () {
  const id = await createEvent()
  const d = await expectOk(as(ALICE, hatEvent, 'detail', { eventId: id }))
  eq(d.event.groupOnly, false)
  eq(d.shareToken, '', '公开活动不需要口令')
  const list = await expectOk(as(ALICE, hatEvent, 'list', {}))
  eq(list.list.length, 1)
})

add('比赛记录摘要：返回最近两场比分，且按各自赛事的队伍名解析', async function () {
  const ctx = await setupTournament([2, 2])
  const teams = ctx.teams

  // 没有比赛时：列表为空，入口指向已有的赛事
  let r = await expectOk(as(OWNER, hatMatch, 'recentMatches', { eventId: ctx.eventId }))
  eq(r.list.length, 0)
  eq(r.entryTournamentId, ctx.tournamentId, '没有比赛时也要能点进去录')
  eq(r.tournamentCount, 1)

  for (let i = 0; i < 3; i++) {
    await expectOk(as(OWNER, hatMatch, 'saveMatch', {
      tournamentId: ctx.tournamentId,
      teamAIndex: 0,
      teamBIndex: 1,
      scoreA: 10 + i,
      scoreB: 5,
      participantsA: teams[0].memberIds,
      participantsB: teams[1].memberIds,
      mvpIds: [],
    }))
  }

  r = await expectOk(as(OWNER, hatMatch, 'recentMatches', { eventId: ctx.eventId, limit: 2 }))
  eq(r.list.length, 2, '只返回限额内的场次')
  eq(r.list[0].scoreA, 12, '最近的排在最前面')
  eq(r.list[1].scoreA, 11)
  eq(r.list[0].tournamentName, '第 1 场')
  ok(r.list[0].teamAName && r.list[0].teamBName, '队伍名要解析出来')
  eq(r.list[0].teamAName, '1队')
  eq(r.entryTournamentId, ctx.tournamentId)
})

add('比赛记录摘要：参与者只看到已发布分队的比赛，且能读到摘要', async function () {
  const ctx = await setupTournament([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: 15, scoreB: 9 })))

  // 已发布 → 参与者能看到
  const seen = await expectOk(as('player-0', hatMatch, 'recentMatches', { eventId: ctx.eventId }))
  eq(seen.list.length, 1)
  eq(seen.list[0].scoreA, 15)

  // 撤销发布 → 摘要里也不该再出现（否则等于绕过"分队未发布"）
  await expectOk(as(OWNER, hatTeam, 'unpublish', { tournamentId: ctx.tournamentId }))
  const hidden = await expectOk(as('player-0', hatMatch, 'recentMatches', { eventId: ctx.eventId }))
  eq(hidden.list.length, 0)
})

add('比赛记录摘要：群内可见活动对外人不给摘要', async function () {
  const id = await createEvent({ visibility: 'group' })
  await expectErr(as(ALICE, hatMatch, 'recentMatches', { eventId: id }), 'FORBIDDEN')
  // 管理身份照常
  const mine = await expectOk(as(OWNER, hatMatch, 'recentMatches', { eventId: id }))
  eq(mine.list.length, 0)
})

// ================================================================ v1.1.4
// 赛前配置（目标分 / 时限 / 中场）、开表与得分时刻、每场备注

add('比赛规则：默认值随 listMatches 返回，组织者可以改', async function () {
  const ctx = await setupTournament([2, 2])

  let d = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  eq(d.rules.targetScore, 13, '默认目标分 13')
  eq(d.rules.halftimeMinutes, 30)
  eq(d.rules.softCapMinutes, 60)
  eq(d.rules.hardCapMinutes, null, '硬时限默认不设')
  eq(d.rules.halftimeBreakMinutes, 3)

  const saved = await expectOk(as(OWNER, hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId,
    rules: {
      targetScore: 15, halftimeMinutes: 45, softCapMinutes: 75,
      hardCapMinutes: 90, halftimeBreakMinutes: 5,
    },
  }))
  eq(saved.rules.targetScore, 15)

  d = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  eq(d.rules.targetScore, 15)
  eq(d.rules.hardCapMinutes, 90)
})

add('比赛规则：时间中场可以留空，留空即只按分数判定', async function () {
  const ctx = await setupTournament([2, 2])

  // 留空（null / 空串 / 0）都能存，存下来是 null
  const saved = await expectOk(as(OWNER, hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId,
    rules: {
      targetScore: 13, halftimeMinutes: '', softCapMinutes: 60,
      hardCapMinutes: null, halftimeBreakMinutes: 3,
    },
  }))
  eq(saved.rules.halftimeMinutes, null, '空串存成 null')

  const d = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  eq(d.rules.halftimeMinutes, null, '读出来仍然是"不设"，不会被默认值填回 30')

  // 硬时限同理，两个可选项互不影响
  eq(d.rules.hardCapMinutes, null)
  eq(d.rules.targetScore, 13)
})

add('比赛规则：时间中场留空时不校验"不能晚于软时限"', async function () {
  const ctx = await setupTournament([2, 2])

  // 填了就要守规矩：超出范围 → 报错
  await expectErr(as(OWNER, hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId,
    rules: {
      targetScore: 13, halftimeMinutes: 999, softCapMinutes: 60, halftimeBreakMinutes: 3,
    },
  }), 'INVALID_INPUT', '时间中场 999 超范围')

  // 留空就没有先后关系可违反
  await expectOk(as(OWNER, hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId,
    rules: {
      targetScore: 13, halftimeMinutes: null, softCapMinutes: 60, halftimeBreakMinutes: 3,
    },
  }))
})

add('比赛规则：老赛事没有时间中场字段时拿默认 30', async function () {
  const ctx = await setupTournament([2, 2])
  // 模拟老数据：字段根本不存在
  mock.update('tournaments', ctx.tournamentId, { matchRules: { targetScore: 15 } })
  const d = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  eq(d.rules.targetScore, 15, '存了的字段用自己的')
  eq(d.rules.halftimeMinutes, 30, '缺的字段用默认值')
  eq(d.rules.softCapMinutes, 60)
})

add('比赛规则：只有管理身份能改，越界与自相矛盾的配置被拒', async function () {
  const ctx = await setupTournament([2, 2])

  await expectErr(as('player-0', hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId, rules: { targetScore: 15 },
  }), 'FORBIDDEN', '参与者不能改规则')

  await expectErr(as(OWNER, hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId,
    rules: { targetScore: 0, halftimeMinutes: 30, softCapMinutes: 60, halftimeBreakMinutes: 3 },
  }), 'INVALID_INPUT', '目标分 0 不合法')

  await expectErr(as(OWNER, hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId,
    rules: { targetScore: 13, halftimeMinutes: 90, softCapMinutes: 60, halftimeBreakMinutes: 3 },
  }), 'INVALID_INPUT', '中场晚于软时限')

  await expectErr(as(OWNER, hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId,
    rules: {
      targetScore: 13, halftimeMinutes: 30, softCapMinutes: 60,
      hardCapMinutes: 30, halftimeBreakMinutes: 3,
    },
  }), 'INVALID_INPUT', '硬时限早于软时限')
})

add('开表：第一次以「比赛中」保存时定 startedAt，之后不再变', async function () {
  const ctx = await setupTournament([2, 2])

  const first = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    scoreA: 0, scoreB: 0, participantsA: ctx.teams[0].memberIds,
    participantsB: ctx.teams[1].memberIds, status: 'live',
  })), '0:0 的 live 记录应当能存（开表用）')
  ok(first.startedAt > 0, '服务端要回传开表时刻')

  const before = mock.get('matches', first._id).startedAt
  eq(before, first.startedAt)

  // 再存一次：开表时刻不能被重置
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: first._id, scoreA: 1, scoreB: 0, status: 'live',
    points: [{ team: 'A', scorer: ctx.teams[0].memberIds[0], assist: null, t: 5 }],
  })))
  eq(mock.get('matches', first._id).startedAt, before, '改记录不能重置开表时刻')
})

add('得分时刻：按相对秒数存，列表里能读回 t 与绝对时刻', async function () {
  const ctx = await setupTournament([2, 2])
  const a0 = ctx.teams[0].memberIds[0]

  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    status: 'live',
    points: [
      { team: 'A', scorer: a0, assist: null, t: 0 },
      { team: 'A', scorer: a0, assist: null, t: 90 },
      { team: 'B', scorer: ctx.teams[1].memberIds[0], assist: null, t: 150 },
    ],
  })))

  const list = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  const m = list.list.filter(function (x) { return x._id === saved._id })[0]
  eq(JSON.stringify(m.points.map(function (p) { return p.t })), JSON.stringify([0, 90, 150]))
  ok(m.startedAt > 0)
  eq(m.points[1].at, m.startedAt + 90 * 1000, '绝对时刻 = 开表时刻 + 相对秒数')
  eq(m.points[2].at - m.points[1].at, 60 * 1000, '两分之间正好 60 秒')
})

add('得分时刻：倒退的时刻与跑到未来的时刻都被拒', async function () {
  const ctx = await setupTournament([2, 2])
  const a0 = ctx.teams[0].memberIds[0]

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    status: 'live',
    points: [
      { team: 'A', scorer: a0, assist: null, t: 100 },
      { team: 'A', scorer: a0, assist: null, t: 50 },
    ],
  })), 'INVALID_POINT', '第 2 分的时刻比第 1 分还早')

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    status: 'live',
    points: [{ team: 'A', scorer: a0, assist: null, t: 99999 }],
  })), 'INVALID_POINT', '时刻超出了已进行时长')
})

add('得分时刻：不带 t 的老比赛照常能存（事后补记没有时间轴）', async function () {
  const ctx = await setupTournament([2, 2])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    status: 'live',
    points: [
      { team: 'A', scorer: ctx.teams[0].memberIds[0], assist: null },
      { team: 'A', scorer: ctx.teams[0].memberIds[1], assist: null },
    ],
  })))
  const list = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  const m = list.list.filter(function (x) { return x._id === saved._id })[0]
  eq(m.points[0].t, null, '没有 t 就是 null')
  eq(m.points[0].at, 0)
})

add('每场备注：能存能读，结束比赛后留在记录上', async function () {
  const ctx = await setupTournament([2, 2])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    status: 'live', notes: '因雨中断 10 分钟',
  })))
  eq(mock.get('matches', saved._id).notes, '因雨中断 10 分钟')

  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: saved._id, status: 'finished', notes: '因雨中断 10 分钟',
  })))
  const list = await expectOk(as(OWNER, hatMatch, 'listMatches', { tournamentId: ctx.tournamentId }))
  const m = list.list.filter(function (x) { return x._id === saved._id })[0]
  eq(m.notes, '因雨中断 10 分钟')
  ok(m.endedAt > 0, '结束时刻要记下来，时间轴才能定格')
})

add('备注超长被截断，不会把文档撑爆', async function () {
  const ctx = await setupTournament([2, 2])
  const long = new Array(400).join('啊')
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    status: 'live', notes: long,
  })))
  eq(mock.get('matches', saved._id).notes.length, 200)
})

add('规则快照：改赛事规则不会倒改已经录好的比赛', async function () {
  const ctx = await setupTournament([2, 2])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    status: 'live', scoreA: 3, scoreB: 1,
  })))
  eq(mock.get('matches', saved._id).matchRules.targetScore, 13, '建比赛时快照了当时的规则')

  await expectOk(as(OWNER, hatMatch, 'setMatchRules', {
    tournamentId: ctx.tournamentId,
    rules: { targetScore: 15, halftimeMinutes: 30, softCapMinutes: 60, halftimeBreakMinutes: 3 },
  }))
  eq(mock.get('matches', saved._id).matchRules.targetScore, 13, '历史比赛不受影响')

  const next = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    status: 'live', scoreA: 1, scoreB: 0,
    participantsA: ctx.teams[0].memberIds, participantsB: ctx.teams[1].memberIds,
  })))
  eq(mock.get('matches', next._id).matchRules.targetScore, 15, '新比赛用新规则')
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
