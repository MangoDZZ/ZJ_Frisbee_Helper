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

// ---------------------------------------------------------------- 测试框架

let passed = 0
const failures = []

async function test (name, fn) {
  mock.reset()
  try {
    await fn()
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

// ---------------------------------------------------------------- 调用助手

const OWNER = 'openid-owner'
const ALICE = 'openid-alice'
const BOB = 'openid-bob'

function as (openid, fn, action, data) {
  mock.setOpenid(openid)
  return fn({ action: action, data: data || {} })
}

async function expectOk (p, msg) {
  const r = await p
  ok(r.ok, (msg || '应当成功') + '，实际：' +
    (r.error ? r.error.code + ' ' + r.error.message : '?'))
  return r.data
}

async function expectErr (p, code, msg) {
  const r = await p
  ok(!r.ok, (msg || '应当失败') + '，但实际成功了')
  if (code) eq(r.error.code, code, msg || '错误码')
  return r.error
}

const DAY = 86400000

function eventForm (over) {
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

function signupForm (over) {
  return Object.assign({
    name: '张三', gender: 'M', selfLevel: 3, phone: '13800000000', remark: '',
  }, over || {})
}

async function createEvent (over) {
  const d = await expectOk(as(OWNER, hatEvent, 'create', eventForm(over)), '建活动')
  return d._id
}

// ================================================================ 活动

const tests = []
function add (name, fn) { tests.push({ name: name, fn: fn }) }

add('创建活动：写入初始状态与名额', async function () {
  const id = await createEvent()
  const doc = mock.get('events', id)
  eq(doc.status, 'open')
  eq(doc.signupCount, 0)
  eq(doc.remaining, 24)
  eq(doc.ownerOpenid, OWNER, '创建者应当是调用方')
})

add('创建活动：表单校验', async function () {
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

  async function naiveSubmit () {
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

add('只有创建者能改水平、设约束、存分队', async function () {
  const id = await createEvent()
  await expectOk(as(ALICE, hatSignup, 'submit', Object.assign({ eventId: id }, signupForm())))
  const sid = mock.all('signups')[0]._id

  await expectErr(as(ALICE, hatSignup, 'updateLevel',
    { eventId: id, signupId: sid, adminLevel: 5 }), 'FORBIDDEN', '改水平')
  await expectErr(as(ALICE, hatTeam, 'setConstraints',
    { eventId: id, constraints: [] }), 'FORBIDDEN', '设约束')
  await expectErr(as(ALICE, hatTeam, 'listConstraints', { eventId: id }), 'FORBIDDEN', '读约束')
  await expectErr(as(ALICE, hatTeam, 'saveDivision',
    { eventId: id, teams: [{ name: '1队', memberIds: [sid] }] }), 'FORBIDDEN', '存分队')
  await expectErr(as(ALICE, hatTeam, 'publish',
    { eventId: id, divisionId: 'x' }), 'FORBIDDEN', '发布')
})

add('创建者覆盖水平，有效水平随之改变；传 null 可恢复自评', async function () {
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

// ================================================================ 约束与分队

async function seedRoster (id, n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    mock.setOpenid('player-' + i)
    await hatSignup({
      action: 'submit',
      data: Object.assign({ eventId: id }, signupForm({
        name: '球员' + i,
        gender: i % 2 ? 'F' : 'M',
        selfLevel: (i % 5) + 1,
      })),
    })
  }
  mock.all('signups').forEach(function (s) { ids.push(s._id) })
  return ids
}

add('约束覆盖式保存，并校验引用的人是否存在', async function () {
  const id = await createEvent()
  const ids = await seedRoster(id, 4)

  await expectOk(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id,
    constraints: [
      { type: 'together', signupIds: [ids[0], ids[1]] },
      { type: 'apart', signupIds: [ids[2], ids[3]] },
    ],
  }))
  let list = await expectOk(as(OWNER, hatTeam, 'listConstraints', { eventId: id }))
  eq(list.list.length, 2)

  // 再存一次只带一条 → 应当覆盖而不是累加
  await expectOk(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id,
    constraints: [{ type: 'together', signupIds: [ids[0], ids[1]] }],
  }))
  list = await expectOk(as(OWNER, hatTeam, 'listConstraints', { eventId: id }))
  eq(list.list.length, 1, '应当是覆盖写入')

  const e = await expectErr(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id,
    constraints: [{ type: 'together', signupIds: [ids[0], 'ghost-id'] }],
  }), 'UNKNOWN_PLAYER')
  ok(e.message.indexOf('ghost-id') >= 0, '错误信息应带上那个 id')

  await expectErr(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id, constraints: [{ type: 'together', signupIds: [ids[0]] }],
  }), 'INVALID_INPUT', '只有一个人')

  await expectErr(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id, constraints: [{ type: 'together', signupIds: [ids[0], ids[0]] }],
  }), 'INVALID_INPUT', '去重后只剩一个人')

  await expectErr(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id, constraints: [{ type: 'whatever', signupIds: [ids[0], ids[1]] }],
  }), 'INVALID_INPUT', '类型不对')
})

add('存分队：名单必须与真实报名完全一致', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)

  // 漏人
  const e1 = await expectErr(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2]] }],
  }), 'INCOMPLETE_DIVISION')
  ok(e1.message.indexOf('球员3') >= 0 || e1.detail.missing.length === 1, '应指出漏了谁')

  // 幽灵成员
  await expectErr(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2], ids[3], 'ghost'] }],
  }), 'UNKNOWN_PLAYER')

  // 一个人被分到两队
  await expectErr(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1], ids[2]] },
      { name: '2队', memberIds: [ids[2], ids[3]] }],
  }), 'INVALID_INPUT')

  // 正确的
  const d = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    seed: 12345,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2], ids[3]] }],
  }))
  eq(d.version, 1)
})

add('统计由服务端重算，不采信客户端传来的数字', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)

  const d = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [
      // 故意塞一份伪造的统计
      { name: '1队', memberIds: [ids[0], ids[1]], stats: { count: 999, male: 999, avgLevel: 5 } },
      { name: '2队', memberIds: [ids[2], ids[3]] },
    ],
  }))
  eq(d.teams[0].stats.count, 2, '人数应按真实名单重算')
  ok(d.teams[0].stats.male !== 999, '伪造的统计不能被采信')

  // 与真实报名核对
  const roster = await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))
  const byId = {}
  roster.list.forEach(function (s) { byId[s._id] = s })
  d.teams.forEach(function (t) {
    let male = 0; let female = 0; let sum = 0
    t.memberIds.forEach(function (mid) {
      if (byId[mid].gender === 'M') male++
      else female++
      sum += byId[mid].level
    })
    eq(t.stats.male, male, t.name + ' 男生数')
    eq(t.stats.female, female, t.name + ' 女生数')
    eq(t.stats.levelSum, sum, t.name + ' 水平总和')
  })
})

add('每次保存产生新版本，版本号递增', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)
  const teams = [{ name: '1队', memberIds: [ids[0], ids[1]] },
    { name: '2队', memberIds: [ids[2], ids[3]] }]

  eq((await expectOk(as(OWNER, hatTeam, 'saveDivision', { eventId: id, teams: teams }))).version, 1)
  eq((await expectOk(as(OWNER, hatTeam, 'saveDivision', { eventId: id, teams: teams }))).version, 2)
  eq((await expectOk(as(OWNER, hatTeam, 'saveDivision', { eventId: id, teams: teams }))).version, 3)

  const hist = await expectOk(as(OWNER, hatTeam, 'listDivisions', { eventId: id }))
  eq(hist.list.length, 3)
  eq(hist.list[0].version, 3, '历史应按版本倒序')
})

add('未发布时参与者看不到分队，发布后才能看到', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)
  const saved = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2], ids[3]] }],
  }))

  let asPlayer = await expectOk(as('player-0', hatTeam, 'getDivision', { eventId: id }))
  eq(asPlayer.division, null, '未发布时参与者应看不到')

  const asOwner = await expectOk(as(OWNER, hatTeam, 'getDivision', { eventId: id }))
  ok(asOwner.division !== null, '创建者应能看到未发布版本')
  eq(asOwner.division.published, false)

  await expectOk(as(OWNER, hatTeam, 'publish', { eventId: id, divisionId: saved._id }))
  asPlayer = await expectOk(as('player-0', hatTeam, 'getDivision', { eventId: id }))
  ok(asPlayer.division !== null, '发布后参与者应能看到')
  eq(mock.get('events', id).status, 'divided', '活动状态应变成已分队')

  // 成员要带上姓名和水平，供页面直接渲染
  const t0 = asPlayer.division.teams[0]
  ok(t0.members.length > 0 && typeof t0.members[0].name === 'string', '应回传成员姓名')
})

add('同一活动只保留一个已发布版本', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)
  const teams = [{ name: '1队', memberIds: [ids[0], ids[1]] },
    { name: '2队', memberIds: [ids[2], ids[3]] }]

  const v1 = await expectOk(as(OWNER, hatTeam, 'saveDivision', { eventId: id, teams: teams }))
  const v2 = await expectOk(as(OWNER, hatTeam, 'saveDivision', { eventId: id, teams: teams }))
  await expectOk(as(OWNER, hatTeam, 'publish', { eventId: id, divisionId: v1._id }))
  await expectOk(as(OWNER, hatTeam, 'publish', { eventId: id, divisionId: v2._id }))

  const published = mock.all('divisions').filter(function (d) { return d.published })
  eq(published.length, 1, '只应有一个已发布版本')
  eq(published[0].version, 2)
})

add('撤销发布后活动回到报名关闭，参与者又看不到了', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)
  const saved = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2], ids[3]] }],
  }))
  await expectOk(as(OWNER, hatTeam, 'publish', { eventId: id, divisionId: saved._id }))
  await expectOk(as(OWNER, hatTeam, 'unpublish', { eventId: id }))

  eq(mock.get('events', id).status, 'closed')
  const asPlayer = await expectOk(as('player-0', hatTeam, 'getDivision', { eventId: id }))
  eq(asPlayer.division, null)
})

add('已分队的活动不能报名、不能改设置', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 6 })
  const ids = await seedRoster(id, 4)
  const saved = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2], ids[3]] }],
  }))
  await expectOk(as(OWNER, hatTeam, 'publish', { eventId: id, divisionId: saved._id }))

  await expectErr(as('newcomer', hatSignup, 'submit',
    Object.assign({ eventId: id }, signupForm())), 'SIGNUP_CLOSED')
  await expectErr(as('player-0', hatSignup, 'cancel', { eventId: id }), 'INVALID_STATE')
  await expectErr(as(OWNER, hatEvent, 'update',
    Object.assign({ eventId: id }, eventForm())), 'INVALID_STATE')
  await expectErr(as(OWNER, hatEvent, 'reopenSignup', { eventId: id }), 'INVALID_STATE')
})

add('删除活动会连带清掉报名、约束和分队记录', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)
  await expectOk(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id, constraints: [{ type: 'together', signupIds: [ids[0], ids[1]] }],
  }))
  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2], ids[3]] }],
  }))

  // 另一场活动的数据不能被牵连
  const other = await createEvent({ name: '别的活动' })
  mock.setOpenid('outsider')
  await hatSignup({ action: 'submit', data: Object.assign({ eventId: other }, signupForm()) })

  await expectOk(as(OWNER, hatEvent, 'remove', { eventId: id }))
  eq(mock.all('events').length, 1)
  eq(mock.all('signups').length, 1, '只应剩下另一场活动的报名')
  eq(mock.all('constraints').length, 0)
  eq(mock.all('divisions').length, 0)
  eq(mock.all('signups')[0].eventId, other)
})

add('活动列表带上"我是否创建""我是否已报名"', async function () {
  const mineId = await createEvent({ name: '我建的' })
  mock.setOpenid(ALICE)
  const otherId = (await hatEvent({
    action: 'create', data: eventForm({ name: '别人建的' }),
  })).data._id

  await expectOk(as(OWNER, hatSignup, 'submit',
    Object.assign({ eventId: otherId }, signupForm())))

  const all = await expectOk(as(OWNER, hatEvent, 'list', { scope: 'all' }))
  eq(all.list.length, 2)
  const byId = {}
  all.list.forEach(function (e) { byId[e._id] = e })
  eq(byId[mineId].isOwner, true)
  eq(byId[mineId].signed, false)
  eq(byId[otherId].isOwner, false)
  eq(byId[otherId].signed, true, '应标记我已报名')

  const mine = await expectOk(as(OWNER, hatEvent, 'list', { scope: 'mine' }))
  eq(mine.list.length, 1)
  eq(mine.list[0]._id, mineId)

  // 列表不能泄露创建者 openid
  ok(JSON.stringify(all).indexOf('ownerOpenid') < 0, '列表不该回传 ownerOpenid 字段')
})

add('分队后有人退出，读取时用占位而不是整页崩掉', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)
  const saved = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2], ids[3]] }],
  }))
  await expectOk(as(OWNER, hatTeam, 'publish', { eventId: id, divisionId: saved._id }))

  // 直接删掉一条报名，模拟"组织者在数据库里清了人"
  const sdk = require('./mock-wx-server-sdk.js')
  await sdk.database().collection('signups').doc(ids[0]).remove()

  const d = await expectOk(as(OWNER, hatTeam, 'getDivision', { eventId: id }))
  const flat = []
  d.division.teams.forEach(function (t) {
    t.members.forEach(function (m) { flat.push(m.name) })
  })
  eq(flat.length, 4, '成员数不变')
  ok(flat.indexOf('(已退出)') >= 0, '缺失的成员应显示占位')
})

// ================================================================ 端到端

add('端到端：报名 → 改水平 → 设约束 → 算分队 → 存 → 发布', async function () {
  // 这条用例跨过"客户端算法"和"云端校验"的接缝：divide() 的输出必须能原样
  // 通过 saveDivision 的完整性校验，两边对名单的理解不能有偏差。
  const divider = require('../miniprogram/utils/divide.js')

  const id = await createEvent({ teamCount: 4, capacity: 24 })

  // 24 人报名：13 男 11 女，水平分布不均
  const levels = [5, 5, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 1]
  const fLevels = [5, 4, 4, 3, 3, 3, 2, 2, 1, 1, 1]
  for (let i = 0; i < 13; i++) {
    mock.setOpenid('m-' + i)
    await hatSignup({
      action: 'submit',
      data: Object.assign({ eventId: id }, signupForm({
        name: '男' + i, gender: 'M', selfLevel: levels[i],
      })),
    })
  }
  for (let i = 0; i < 11; i++) {
    mock.setOpenid('f-' + i)
    await hatSignup({
      action: 'submit',
      data: Object.assign({ eventId: id }, signupForm({
        name: '女' + i, gender: 'F', selfLevel: fLevels[i],
      })),
    })
  }
  eq(mock.get('events', id).signupCount, 24)
  eq(mock.get('events', id).remaining, 0)

  // 组织者拉名单
  let roster = (await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))).list
  eq(roster.length, 24)

  // 把一个自评偏低的人上调，确认分队用的是覆盖后的有效水平
  const bumped = roster.filter(function (s) { return s.name === '男12' })[0]
  await expectOk(as(OWNER, hatSignup, 'updateLevel',
    { eventId: id, signupId: bumped._id, adminLevel: 5 }))

  // 设两条约束：一对必须同队、一对必须拆开
  const byName = {}
  roster.forEach(function (s) { byName[s.name] = s })
  await expectOk(as(OWNER, hatTeam, 'setConstraints', {
    eventId: id,
    constraints: [
      { type: 'together', signupIds: [byName['男0']._id, byName['女0']._id] },
      { type: 'apart', signupIds: [byName['男1']._id, byName['男2']._id] },
    ],
  }))

  await expectOk(as(OWNER, hatEvent, 'closeSignup', { eventId: id }))

  // 重新拉名单（水平已被覆盖），跑客户端算法
  roster = (await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))).list
  eq(roster.filter(function (s) { return s.name === '男12' })[0].level, 5,
    '有效水平应当是覆盖后的值')

  const cons = (await expectOk(as(OWNER, hatTeam, 'listConstraints', { eventId: id }))).list
  const result = divider.divide(
    roster.map(function (s) {
      return { id: s._id, name: s.name, gender: s.gender, level: s.level }
    }),
    4,
    cons.map(function (c) { return { type: c.type, ids: c.signupIds } }),
    20260924
  )
  ok(result.ok, '分队应当成功：' + (result.error ? result.error.message : ''))
  eq(result.stats.sizeSpread, 0, '24 人分 4 队应当每队 6 人')
  ok(result.stats.femaleSpread <= 1, '女生极差 ' + result.stats.femaleSpread)

  // 算法输出原样交给云函数
  const saved = await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    seed: result.seed,
    teams: result.teams.map(function (t) {
      return { name: t.name, memberIds: t.memberIds }
    }),
  }), '算法输出应当通过云端校验')

  // 云端重算的统计必须与客户端算的一致
  for (let i = 0; i < saved.teams.length; i++) {
    const a = saved.teams[i].stats
    const b = result.teams[i].stats
    eq(a.count, b.count, '第 ' + i + ' 队人数')
    eq(a.male, b.male, '第 ' + i + ' 队男生数')
    eq(a.female, b.female, '第 ' + i + ' 队女生数')
    eq(a.levelSum, b.levelSum, '第 ' + i + ' 队水平总和')
    eq(a.star, b.star, '第 ' + i + ' 队高分球员数')
  }

  await expectOk(as(OWNER, hatTeam, 'publish', { eventId: id, divisionId: saved._id }))

  // 参与者视角读回，核对约束确实生效
  const seen = await expectOk(as('m-0', hatTeam, 'getDivision', { eventId: id }))
  const teamOf = {}
  seen.division.teams.forEach(function (t, i) {
    t.members.forEach(function (m) { teamOf[m.name] = i })
  })
  eq(teamOf['男0'], teamOf['女0'], '同队约束应当满足')
  ok(teamOf['男1'] !== teamOf['男2'], '拆开约束应当满足')

  // 24 人一个不少、一个不重
  eq(Object.keys(teamOf).length, 24)
  let total = 0
  seen.division.teams.forEach(function (t) { total += t.stats.count })
  eq(total, 24)
})

// ================================================================ 比赛与积分

/** 建活动 + 报名 + 分队 + 发布，返回可直接用来录比赛的上下文。 */
async function setupPublished (teamSizes) {
  const total = teamSizes.reduce(function (a, b) { return a + b }, 0)
  const id = await createEvent({ teamCount: teamSizes.length, capacity: total })

  for (let i = 0; i < total; i++) {
    mock.setOpenid('player-' + i)
    await hatSignup({
      action: 'submit',
      data: Object.assign({ eventId: id }, signupForm({
        name: '球员' + i, gender: i % 2 ? 'F' : 'M', selfLevel: (i % 5) + 1,
      })),
    })
  }
  const roster = (await expectOk(as(OWNER, hatSignup, 'listAll', { eventId: id }))).list
  const ids = roster.map(function (s) { return s._id })

  const teams = []
  let at = 0
  for (let t = 0; t < teamSizes.length; t++) {
    teams.push({ name: (t + 1) + '队', memberIds: ids.slice(at, at + teamSizes[t]) })
    at += teamSizes[t]
  }

  const saved = await expectOk(as(OWNER, hatTeam, 'saveDivision', { eventId: id, teams: teams }))
  await expectOk(as(OWNER, hatTeam, 'publish', { eventId: id, divisionId: saved._id }))

  return { eventId: id, ids: ids, teams: teams, roster: roster }
}

function matchData (ctx, over) {
  return Object.assign({
    eventId: ctx.eventId,
    teamAIndex: 0,
    teamBIndex: 1,
    scoreA: 15,
    scoreB: 10,
    participantsA: ctx.teams[0].memberIds,
    participantsB: ctx.teams[1].memberIds,
    mvpIds: [],
  }, over || {})
}

function pointsOf (board, name) {
  const r = board.rows.filter(function (x) { return x.name === name })[0]
  if (!r) throw new Error('积分榜上找不到 ' + name)
  return r.points
}

add('分队未发布时不能录比赛', async function () {
  const id = await createEvent({ teamCount: 2, capacity: 4 })
  const ids = await seedRoster(id, 4)
  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: id,
    teams: [{ name: '1队', memberIds: [ids[0], ids[1]] },
      { name: '2队', memberIds: [ids[2], ids[3]] }],
  }))
  // 存了但没发布
  await expectErr(as(OWNER, hatMatch, 'saveMatch', {
    eventId: id, teamAIndex: 0, teamBIndex: 1, scoreA: 15, scoreB: 10,
    participantsA: [ids[0]], participantsB: [ids[2]],
  }), 'DIVISION_NOT_PUBLISHED')
})

add('录入一场比赛并按规则计分', async function () {
  const ctx = await setupPublished([3, 3])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: [ctx.teams[1].memberIds[0], ctx.teams[1].memberIds[1]],
  })))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.rows.length, 6)
  eq(board.totals.matchCount, 1)

  // 1队全员获胜 3 分
  eq(pointsOf(board, '球员0'), 3)
  eq(pointsOf(board, '球员1'), 3)
  eq(pointsOf(board, '球员2'), 3)
  // 2队前两人 1 分 + MVP 1 分；第三人只有 1 分
  eq(pointsOf(board, '球员3'), 2)
  eq(pointsOf(board, '球员4'), 2)
  eq(pointsOf(board, '球员5'), 1)
  eq(board.rules.win, 3)
  eq(board.rules.loss, 1)
  eq(board.rules.mvp, 1)
})

add('未上场的人不得分', async function () {
  const ctx = await setupPublished([3, 3])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsA: ctx.teams[0].memberIds.slice(0, 2),   // 球员2 没上
    participantsB: ctx.teams[1].memberIds.slice(0, 2),   // 球员5 没上
  })))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员0'), 3)
  eq(pointsOf(board, '球员2'), 0, '胜方未上场不得分')
  eq(pointsOf(board, '球员5'), 0, '败方未上场不得分')
  eq(board.totals.playedCount, 4)
  eq(board.rows.length, 6, '没上场的人仍要出现在榜上')
})

add('平局被拒绝', async function () {
  const ctx = await setupPublished([2, 2])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: 12, scoreB: 12 })),
    'DRAW_NOT_ALLOWED')
})

add('比分非法：负数、小数、空值', async function () {
  const ctx = await setupPublished([2, 2])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: -1 })),
    'INVALID_INPUT', '负数')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreA: 7.5 })),
    'INVALID_INPUT', '小数')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreB: null })),
    'INVALID_INPUT', '空值')
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { scoreB: 'abc' })),
    'INVALID_INPUT', '非数字')
})

add('两队不能是同一队，队伍序号必须存在', async function () {
  const ctx = await setupPublished([2, 2])
  await expectErr(as(OWNER, hatMatch, 'saveMatch',
    matchData(ctx, { teamBIndex: 0 })), 'INVALID_INPUT', '同一队')
  await expectErr(as(OWNER, hatMatch, 'saveMatch',
    matchData(ctx, { teamBIndex: 9 })), 'INVALID_INPUT', '队伍不存在')
})

add('上场名单混入别队的人 → 被拒', async function () {
  const ctx = await setupPublished([3, 3])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    // 把 2 队的人塞进 1 队的上场名单
    participantsA: ctx.teams[0].memberIds.concat([ctx.teams[1].memberIds[0]]),
  })), 'INVALID_PARTICIPANT')

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsB: ['ghost-id'],
  })), 'INVALID_PARTICIPANT', '不存在的人')
})

add('上场名单不能为空', async function () {
  const ctx = await setupPublished([2, 2])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { participantsA: [] })),
    'INVALID_INPUT')
})

add('MVP 必须来自败方的上场队员', async function () {
  const ctx = await setupPublished([3, 3])

  // 选了胜方的人
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: [ctx.teams[0].memberIds[0]],
  })), 'INVALID_MVP', '胜方的人不能当 MVP')

  // 选了败方但没上场的人
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    participantsB: ctx.teams[1].memberIds.slice(0, 2),
    mvpIds: [ctx.teams[1].memberIds[2]],
  })), 'INVALID_MVP', '未上场的人不能当 MVP')

  // 比分反过来时，方向也要跟着反
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    scoreA: 10, scoreB: 15,
    mvpIds: [ctx.teams[1].memberIds[0]],
  })), 'INVALID_MVP', 'B 队赢时 B 队的人不能当 MVP')

  // B 队赢时，MVP 应当从 A 队里选
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    scoreA: 10, scoreB: 15,
    mvpIds: [ctx.teams[0].memberIds[0]],
  })), 'B 队赢时从 A 队选 MVP 应当成功')
})

add('MVP 最多 2 人且不能重复', async function () {
  const ctx = await setupPublished([3, 3])
  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: ctx.teams[1].memberIds,          // 3 个人
  })), 'INVALID_INPUT', '超过 2 人')

  await expectErr(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: [ctx.teams[1].memberIds[0], ctx.teams[1].memberIds[0]],
  })), 'INVALID_INPUT', '重复')
})

add('MVP 可以先不选，之后补录', async function () {
  const ctx = await setupPublished([2, 2])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, { mvpIds: [] })))

  let board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员2'), 1, '还没选 MVP 时只有败方基础分')

  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    matchId: saved._id,
    mvpIds: [ctx.teams[1].memberIds[0]],
  })))
  board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员2'), 2, '补录 MVP 后应当 +1')
  eq(board.totals.matchCount, 1, '补录是更新不是新增')
})

add('只有创建者能录入、修改、删除比赛', async function () {
  const ctx = await setupPublished([2, 2])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))

  await expectErr(as('player-0', hatMatch, 'saveMatch', matchData(ctx)), 'FORBIDDEN', '录入')
  await expectErr(as('player-0', hatMatch, 'saveMatch',
    matchData(ctx, { matchId: saved._id })), 'FORBIDDEN', '修改')
  await expectErr(as('player-0', hatMatch, 'removeMatch',
    { eventId: ctx.eventId, matchId: saved._id }), 'FORBIDDEN', '删除')
  await expectErr(as('player-0', hatMatch, 'countMatches',
    { eventId: ctx.eventId }), 'FORBIDDEN', '计数')
})

add('参与者能看比赛和积分榜；分队未发布时看不到', async function () {
  const ctx = await setupPublished([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))

  const seen = await expectOk(as('player-0', hatMatch, 'listMatches', { eventId: ctx.eventId }))
  eq(seen.isOwner, false)
  eq(seen.list.length, 1)
  const board = await expectOk(as('player-0', hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.rows.length, 4)

  // 撤销发布后参与者就不该再看到
  await expectOk(as(OWNER, hatTeam, 'unpublish', { eventId: ctx.eventId }))
  await expectErr(as('player-0', hatMatch, 'listMatches', { eventId: ctx.eventId }),
    'DIVISION_NOT_PUBLISHED')
  await expectErr(as('player-0', hatMatch, 'leaderboard', { eventId: ctx.eventId }),
    'DIVISION_NOT_PUBLISHED')
})

add('删除比赛后积分同步扣掉', async function () {
  const ctx = await setupPublished([2, 2])
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx, {
    mvpIds: [ctx.teams[1].memberIds[0]],
  })))

  let board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(pointsOf(board, '球员0'), 3)

  await expectOk(as(OWNER, hatMatch, 'removeMatch',
    { eventId: ctx.eventId, matchId: saved._id }))
  board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  // 积分是实时推导的，删了比赛就该归零，不会留下存量数字
  board.rows.forEach(function (r) { eq(r.points, 0, r.name + ' 应当归零') })
  eq(board.totals.matchCount, 0)
})

add('已录入比赛后不能重新分队', async function () {
  const ctx = await setupPublished([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))

  const e = await expectErr(as(OWNER, hatTeam, 'saveDivision', {
    eventId: ctx.eventId, teams: ctx.teams,
  }), 'MATCHES_EXIST')
  ok(e.message.indexOf('1 场') >= 0, '错误信息应说明有几场比赛：' + e.message)

  // 删光比赛后又可以重分
  const list = await expectOk(as(OWNER, hatMatch, 'listMatches', { eventId: ctx.eventId }))
  await expectOk(as(OWNER, hatMatch, 'removeMatch',
    { eventId: ctx.eventId, matchId: list.list[0]._id }))
  await expectOk(as(OWNER, hatTeam, 'saveDivision', {
    eventId: ctx.eventId, teams: ctx.teams,
  }), '删光比赛后应当可以重新分队')
})

add('不能跨活动改别人活动的比赛记录', async function () {
  const ctxA = await setupPublished([2, 2])
  const other = await createEvent({ name: '另一场' })
  const saved = await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctxA)))

  await expectErr(as(OWNER, hatMatch, 'removeMatch',
    { eventId: other, matchId: saved._id }), 'FORBIDDEN')
})

add('删除活动会连带清掉比赛记录', async function () {
  const ctx = await setupPublished([2, 2])
  await expectOk(as(OWNER, hatMatch, 'saveMatch', matchData(ctx)))
  eq(mock.all('matches').length, 1)

  await expectOk(as(OWNER, hatEvent, 'remove', { eventId: ctx.eventId }))
  eq(mock.all('matches').length, 0, '比赛记录应被级联删除')
})

add('端到端：三场循环赛的积分与手算一致', async function () {
  // 3 队各 2 人，打满单循环 3 场
  const ctx = await setupPublished([2, 2, 2])
  const T = ctx.teams

  // 第 1 场：1队 15:10 胜 2队，MVP 给 2 队两人
  await expectOk(as(OWNER, hatMatch, 'saveMatch', {
    eventId: ctx.eventId,
    teamAIndex: 0, teamBIndex: 1, scoreA: 15, scoreB: 10,
    participantsA: T[0].memberIds, participantsB: T[1].memberIds,
    mvpIds: T[1].memberIds,
  }))
  // 第 2 场：3队 15:12 胜 1队，MVP 只给 1 队第一人
  await expectOk(as(OWNER, hatMatch, 'saveMatch', {
    eventId: ctx.eventId,
    teamAIndex: 2, teamBIndex: 0, scoreA: 15, scoreB: 12,
    participantsA: T[2].memberIds, participantsB: T[0].memberIds,
    mvpIds: [T[0].memberIds[0]],
  }))
  // 第 3 场：3队 15:11 胜 2队，2 队只上了 1 个人
  await expectOk(as(OWNER, hatMatch, 'saveMatch', {
    eventId: ctx.eventId,
    teamAIndex: 2, teamBIndex: 1, scoreA: 15, scoreB: 11,
    participantsA: T[2].memberIds, participantsB: [T[1].memberIds[0]],
    mvpIds: [T[1].memberIds[0]],
  }))

  const board = await expectOk(as(OWNER, hatMatch, 'leaderboard', { eventId: ctx.eventId }))
  eq(board.totals.matchCount, 3)

  // 手算：
  // 球员0(1队) 第1场胜3 + 第2场负1 + MVP1 = 5
  // 球员1(1队) 第1场胜3 + 第2场负1        = 4
  // 球员2(2队) 第1场负1 + MVP1 + 第3场负1 + MVP1 = 4
  // 球员3(2队) 第1场负1 + MVP1 + 第3场未上场     = 2
  // 球员4(3队) 第2场胜3 + 第3场胜3        = 6
  // 球员5(3队) 第2场胜3 + 第3场胜3        = 6
  eq(pointsOf(board, '球员0'), 5)
  eq(pointsOf(board, '球员1'), 4)
  eq(pointsOf(board, '球员2'), 4)
  eq(pointsOf(board, '球员3'), 2)
  eq(pointsOf(board, '球员4'), 6)
  eq(pointsOf(board, '球员5'), 6)

  // 排序与名次：6 分两人并列第 1，之后跳到第 3
  eq(board.rows[0].points, 6)
  eq(board.rows[1].points, 6)
  eq(board.rows[0].rank, 1)
  eq(board.rows[1].rank, 1)
  eq(board.rows[2].rank, 3)

  // 队伍战绩
  const mt = await expectOk(as(OWNER, hatMatch, 'listMatches', { eventId: ctx.eventId }))
  const rec = {}
  mt.teamRecords.forEach(function (r) { rec[r.name] = r })
  eq(rec['1队'].won, 1); eq(rec['1队'].lost, 1)
  eq(rec['2队'].won, 0); eq(rec['2队'].lost, 2)
  eq(rec['3队'].won, 2); eq(rec['3队'].lost, 0)

  // 列表里要带上队名和人名，供页面直接渲染
  eq(mt.list.length, 3)
  ok(mt.list[0].teamAName === '1队' && mt.list[0].teamBName === '2队')
  ok(mt.list[0].mvps.length === 2 && typeof mt.list[0].mvps[0].name === 'string')
  eq(mt.list[0].winner, 'A')
})

// ---------------------------------------------------------------- 运行

;(async function run () {
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
