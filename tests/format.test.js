'use strict'

/**
 * 时间与展示工具的单元测试。纯 Node，不需要微信环境。
 *
 *   node tests/format.test.js
 *
 * 重点盯住两件事：
 *  1. 时间戳一律由"年月日时分"分量拼出来（不靠 Date 解析字符串），所以跨天、缺时间、
 *     非法输入的行为都要在这里定死；
 *  2. 跨天活动的展示文案——活动可以跨天，列表和详情都靠 formatRange 渲染。
 */

const fmt = require('../miniprogram/utils/format.js')

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

// ---------------------------------------------------------------- toTimestamp

test('toTimestamp：按分量拼，不受时区与字符串格式影响', function () {
  // 显式按分量构造，和 new Date(y, m-1, d, h, min) 一致
  eq(fmt.toTimestamp('2026-09-24', '19:00'), new Date(2026, 8, 24, 19, 0, 0, 0).getTime())
  eq(fmt.toTimestamp('2026-09-24', '09:05'), new Date(2026, 8, 24, 9, 5, 0, 0).getTime())
})

test('toTimestamp：不传时分按 00:00 算', function () {
  eq(fmt.toTimestamp('2026-09-24'), new Date(2026, 8, 24, 0, 0, 0, 0).getTime())
  eq(fmt.toTimestamp('2026-09-24', ''), new Date(2026, 8, 24, 0, 0, 0, 0).getTime())
})

test('toTimestamp：缺日期或格式不对返回 null，不返回 NaN', function () {
  eq(fmt.toTimestamp(''), null)
  eq(fmt.toTimestamp(null), null)
  eq(fmt.toTimestamp(undefined), null)
  eq(fmt.toTimestamp('2026-09'), null, '缺日')
  eq(fmt.toTimestamp('2026/09/24'), null, '斜杠分隔不算合法')
  eq(fmt.toTimestamp('abc-de-fg'), null)
})

test('toTimestamp：跨天的时间戳确实大于开始时间', function () {
  const start = fmt.toTimestamp('2026-09-24', '19:00')
  const sameDay = fmt.toTimestamp('2026-09-24', '21:00')
  const nextDay = fmt.toTimestamp('2026-09-25', '12:00')
  ok(sameDay > start, '同一天晚些时候应当更晚')
  ok(nextDay > sameDay, '跨天应当更晚')
  eq(nextDay - start, 17 * 3600000, '19:00 到次日 12:00 相差 17 小时')
})

// ---------------------------------------------------------------- splitTimestamp

test('splitTimestamp：与 toTimestamp 往返一致', function () {
  const ms = fmt.toTimestamp('2026-09-24', '19:05')
  const s = fmt.splitTimestamp(ms)
  eq(s.date, '2026-09-24')
  eq(s.time, '19:05')
  eq(fmt.toTimestamp(s.date, s.time), ms, '拼回去必须是同一个时间戳')
})

test('splitTimestamp：空值返回空串，不抛错', function () {
  eq(fmt.splitTimestamp(null).date, '')
  eq(fmt.splitTimestamp(0).time, '')
  eq(fmt.splitTimestamp(undefined).date, '')
})

// ---------------------------------------------------------------- formatRange

test('formatRange：同一天只写一次日期', function () {
  const start = fmt.toTimestamp('2026-09-24', '19:00')
  const end = fmt.toTimestamp('2026-09-24', '21:00')
  eq(fmt.formatRange(start, end), '9月24日 19:00-21:00')
})

test('formatRange：跨天要带上结束日期（活动可以跨天）', function () {
  const start = fmt.toTimestamp('2026-09-24', '19:00')
  const end = fmt.toTimestamp('2026-09-25', '12:00')
  eq(fmt.formatRange(start, end), '9月24日 19:00 至 9月25日 12:00')
})

test('formatRange：不填结束时间就只显示开始', function () {
  const start = fmt.toTimestamp('2026-09-24', '19:00')
  eq(fmt.formatRange(start, null), '9月24日 19:00')
  eq(fmt.formatRange(start, ''), '9月24日 19:00')
  eq(fmt.formatRange(null, null), '')
})

// ---------------------------------------------------------------- 状态判定

test('isPast：跨天的活动按结束时间判，结束时间到了才算过去', function () {
  const now = Date.now()
  ok(!fmt.isPast({ startTime: now - 3600000, endTime: now + 3600000 }), '还在进行中')
  ok(fmt.isPast({ startTime: now - 7200000, endTime: now - 3600000 }), '已结束')
  // 没填结束时间就退回开始时间
  ok(fmt.isPast({ startTime: now - 1000 }), '没有结束时间时按开始时间算')
  ok(!fmt.isPast({ startTime: now + 100000 }))
  ok(!fmt.isPast(null), '空活动不算已结束')
})

test('isSignupExpired：按报名截止判，没设就退回开始时间', function () {
  const now = Date.now()
  ok(fmt.isSignupExpired({ signupDeadline: now - 1000, startTime: now + 100000 }), '已截止')
  ok(!fmt.isSignupExpired({ signupDeadline: now + 100000, startTime: now + 200000 }), '未截止')
  ok(fmt.isSignupExpired({ startTime: now - 1000 }), '没设截止时退回开始时间')
  ok(!fmt.isSignupExpired({}), '都没有就不算截止')
})

// ---------------------------------------------------------------- 文案

test('文案：水平 / 状态 / 性别', function () {
  eq(fmt.levelText(3), 'L3(3)')
  eq(fmt.statusText('open'), '报名中')
  eq(fmt.statusText('divided'), '已分队')
  eq(fmt.genderText('M'), '男')
  eq(fmt.genderText('F'), '女')
  eq(fmt.genderText(''), '未填')
})

// ---------------------------------------------------------------- 活动列表的状态泡泡

/** 造一个活动：默认还能报名 */
function evt (over) {
  const now = Date.now()
  return Object.assign({
    status: 'open',
    remaining: 5,
    capacity: 10,
    signupCount: 5,
    startTime: now + 86400000,
    signupDeadline: now + 3600000,
  }, over || {})
}

test('状态泡泡：正常报名中', function () {
  const s = fmt.eventState(evt())
  eq(s.text, '报名中')
  eq(s.className, 'tag-open')
})

test('状态泡泡：报名中但已截止 → 只显示"报名已截止"，不并排"报名中"', function () {
  const s = fmt.eventState(evt({ signupDeadline: Date.now() - 1000 }))
  eq(s.text, '报名已截止', '这时候还给"报名中"就是自相矛盾')
  eq(s.className, 'tag-full')
})

test('状态泡泡：名额已满 → 只显示"名额已满"', function () {
  const s = fmt.eventState(evt({ remaining: 0 }))
  eq(s.text, '名额已满')
  eq(s.className, 'tag-full')
})

test('状态泡泡：既满又截止时优先"名额已满"（更具体）', function () {
  const s = fmt.eventState(evt({ remaining: 0, signupDeadline: Date.now() - 1000 }))
  eq(s.text, '名额已满')
})

test('状态泡泡：报名关闭时按状态显示，不再评估截止/满员', function () {
  const s = fmt.eventState(evt({ status: 'closed', remaining: 0 }))
  eq(s.text, '报名关闭')
  eq(s.className, 'tag-closed')
})

test('状态泡泡：只可能是一个状态——返回里没有第二个泡泡的字段', function () {
  const s = fmt.eventState(evt({ signupDeadline: Date.now() - 1000 }))
  eq(Object.keys(s).sort().join(','), 'className,text', '返回结构决定了不可能并排两个状态')
})

test('状态泡泡：没设截止时间时以开始时间为界', function () {
  const now = Date.now()
  eq(fmt.eventState(evt({ signupDeadline: null, startTime: now - 1000 })).text, '报名已截止')
  eq(fmt.eventState(evt({ signupDeadline: null, startTime: now + 100000 })).text, '报名中')
})

test('状态泡泡：remaining 缺失或非法时不误判为满员', function () {
  eq(fmt.eventState(evt({ remaining: undefined })).text, '报名中')
  eq(fmt.eventState(evt({ remaining: 'abc' })).text, '报名中')
  eq(fmt.eventState(evt({ remaining: null })).text, '报名中')
})

test('状态泡泡：空活动返回空串，不抛错', function () {
  eq(fmt.eventState(null).text, '')
  eq(fmt.eventState(undefined).className, '')
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
  process.exit(1)
}
