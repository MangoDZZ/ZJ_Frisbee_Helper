'use strict'

/**
 * 粘贴名单的解析与匹配。纯 Node，不需要微信环境。
 *
 *   node tests/name-match.test.js
 *
 * 这里盯住的是"尽最大努力认人"的边界：编号、备注、分隔符、重名、没报名的人。
 * 认不出来不是错误——但那一条必须出现在未识别名单里，不能静默吞掉。
 */

const nm = require('../miniprogram/utils/name-match.js')

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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((msg ? msg + '：' : '') + '期望 ' + b + '，实际 ' + a)
}

// ---------------------------------------------------------------- 解析

test('计划里的样例：编号 + 换行', function () {
  const r = nm.parseNames('1.张三\n2.李四\n3.王五')
  eq(r.tokens, ['张三', '李四', '王五'])
  eq(r.skipped, 0)
})

test('各种编号写法都能剥掉', function () {
  const r = nm.parseNames('1.张三\n2、李四\n3)王五\n(4)赵六\n⑤孙七\n- 周八\n•吴九\n10：郑十')
  eq(r.tokens, ['张三', '李四', '王五', '赵六', '孙七', '周八', '吴九', '郑十'])
})

test('逗号/顿号/分号分隔的横排名单', function () {
  const r = nm.parseNames('张三、李四，王五;赵六\u3000孙七')
  eq(r.tokens, ['张三', '李四', '王五', '赵六', '孙七'])
})

test('空行、纯标点行被跳过并计入 skipped', function () {
  const r = nm.parseNames('张三\n\n   \n、\n李四')
  eq(r.tokens, ['张三', '李四'])
  eq(r.skipped, 3)
})

test('重复的名字只算一次（粘贴常见：名单里同一个人出现两遍）', function () {
  const r = nm.parseNames('1.张三\n2.张三\n3.李四')
  eq(r.tokens, ['张三', '李四'])
  eq(r.skipped, 1)
})

test('空文本不炸，返回空列表', function () {
  eq(nm.parseNames('').tokens, [])
  eq(nm.parseNames(null).tokens, [])
  eq(nm.parseNames(undefined).tokens, [])
})

test('编号后面的名字原样保留（不做 trim 之外的加工）', function () {
  const r = nm.parseNames('1. 张三 ')
  eq(r.tokens, ['张三'])
})

// ---------------------------------------------------------------- 匹配

const ROSTER = [
  { id: 's1', name: '张三' },
  { id: 's2', name: '李四' },
  { id: 's3', name: '王五' },
  { id: 's4', name: '张三丰' },
]

test('完全一致的名字全部匹配上', function () {
  const r = nm.matchNames(['张三', '李四'], ROSTER)
  eq(r.matched.map(function (m) { return m.id }), ['s1', 's2'])
  eq(r.unmatched, [])
})

test('没报名的人进未识别名单，不静默丢弃', function () {
  const r = nm.matchNames(['张三', '路人甲'], ROSTER)
  eq(r.matched.map(function (m) { return m.id }), ['s1'])
  eq(r.unmatched, ['路人甲'])
})

test('名字后面带备注也能认出来', function () {
  const r = nm.matchNames(['李四（迟到）', '王五 请假半小时'], ROSTER)
  eq(r.matched.map(function (m) { return m.id }), ['s2', 's3'])
  eq(r.unmatched, [])
})

test('同时存在"张三"和"张三丰"时，两个都能精确对上，不串位', function () {
  const r = nm.matchNames(['张三', '张三丰'], ROSTER)
  eq(r.matched.map(function (m) { return m.id }), ['s1', 's4'])
})

test('多出来的字更长的一方优先（张三丰→张三丰而不是张三）', function () {
  const r = nm.matchNames(['张三丰老师'], ROSTER)
  eq(r.matched.length, 1)
  eq(r.matched[0].id, 's4', '应当对上更长的那个名字')
})

test('每个人最多被匹配一次（名单里两个相近的名字不会落到同一人）', function () {
  const r = nm.matchNames(['张三', '张三（替补）'], ROSTER)
  eq(r.matched.length, 1, '同一个报名者不能被勾两次')
  eq(r.matched[0].id, 's1')
  eq(r.unmatched, ['张三（替补）'], '第二条没有可匹配的人，进未识别')
})

test('单个字不参与包含匹配（避免"王"匹配一堆人）', function () {
  const r = nm.matchNames(['王'], ROSTER)
  eq(r.matched, [])
  eq(r.unmatched, ['王'])
})

test('两边一样长且都能包含时判为有歧义，不瞎猜', function () {
  const roster = [
    { id: 'a', name: '张三A' },
    { id: 'b', name: '张三B' },
  ]
  // "张三"同时是两个人的前缀，长度相同 → 有歧义
  const r = nm.matchNames(['张三'], roster)
  eq(r.matched, [])
  eq(r.ambiguous, ['张三'])
})

test('名单里没有 openid 或名字为空的条目被忽略', function () {
  const r = nm.matchNames(['张三'], [{ id: '', name: '张三' }, { id: 'x', name: '' }, ROSTER[0]])
  eq(r.matched.map(function (m) { return m.id }), ['s1'])
})

test('解析 + 匹配的完整链路', function () {
  const parsed = nm.parseNames('1.张三\n2.李四（迟到）\n3.没报名的人\n4.张三')
  const r = nm.matchNames(parsed.tokens, ROSTER)
  eq(r.matched.map(function (m) { return m.name }), ['张三', '李四'])
  eq(r.unmatched, ['没报名的人'])
  eq(parsed.skipped, 1, '重复的张三被去重')
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
  process.exit(1)
}
