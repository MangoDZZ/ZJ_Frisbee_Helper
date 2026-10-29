'use strict'

const assert = require('assert')
const parser = require('../cloudfunctions/hat-signup/lib/import-list.js')

function ok (v, msg) { assert.ok(v, msg) }
function eq (a, b, msg) { assert.strictEqual(a, b, msg) }

const rows = [
  ['1、姓名', '2、性别', '3、能力'],
  ['曹越铭', '男', 'L3'],
  ['王紫涵', '女', 'L4'],
  ['空白行', 'F', '2'],
  ['', '', ''],
]
const result = parser.parseRows(rows)
ok(!result.error)
eq(result.value.length, 3)
eq(result.value[0].name, '曹越铭')
eq(result.value[0].gender, 'M')
eq(result.value[0].selfLevel, 3)
eq(result.value[1].gender, 'F')
eq(result.value[2].selfLevel, 2)

ok(parser.parseRows([
  ['姓名', '性别', '能力'],
  ['张三', '男', 'L6'],
]).error)
ok(parser.parseRows([
  ['姓名', '性别'],
  ['张三', '男'],
]).error)
eq(parser.parseLevel(' L5 '), 5)
eq(parser.parseGender('female'), 'F')

// ---------------------------------------------------------------- 报错要具体到行
// 导入失败的提示是唯一能告诉用户"哪一行错了"的东西，所以措辞本身就是需求。

const badLevel = parser.parseRows([
  ['姓名', '性别', '能力'],
  ['张三', '男', 'L3'],
  ['李四', '女', 'L9'],
])
ok(badLevel.error, '能力超出范围应报错')
ok(badLevel.error.message.indexOf('第 3 行') >= 0,
  '提示里要带上行号（表格第 3 行），实际是：' + badLevel.error.message)
ok(badLevel.error.message.indexOf('能力') >= 0, '要说明是哪一列的问题')

const badGender = parser.parseRows([
  ['姓名', '性别', '能力'],
  ['张三', '未知', 'L3'],
])
ok(badGender.error.message.indexOf('性别必须是') >= 0, '性别要说清可接受的写法')
ok(badGender.error.message.indexOf('「未知」') >= 0,
  '要回显这一格实际写了什么，实际是：' + badGender.error.message)

// 空单元格和写错要能区分：一个是漏填，一个是填错
const emptyGender = parser.parseRows([
  ['姓名', '性别', '能力'],
  ['张三', '', 'L3'],
])
ok(emptyGender.error.message.indexOf('这一格是空的') >= 0,
  '空单元格要说成"空的"，而不是回显一对空引号')

const badName = parser.parseRows([
  ['姓名', '性别', '能力'],
  ['', '男', 'L3'],
])
ok(badName.error.message.indexOf('缺少姓名') >= 0, '空姓名要说清缺什么')

// 一处问题都不放过：多行多列同时出错时逐条列出，且保留完整明细
const manyBad = parser.parseRows([['姓名', '性别', '能力']].concat(
  Array.apply(null, Array(12)).map(function (_, i) { return ['球员' + i, 'x', 'L9'] })
))
ok(manyBad.error, '多行出错应报错')
eq(manyBad.error.detail.errors.length, 24, '12 行 × 2 个问题都要留在明细里')
ok(manyBad.error.message.indexOf('共 24 处问题') >= 0,
  '超过 10 条时要说明总数，实际是：' + manyBad.error.message)
ok(manyBad.error.message.indexOf('只列出前 10 条') >= 0, '要说明只列了一部分')

// 空表要能和"格式不对"区分开：用户看到的原因不同，处理方式也不同
eq(parser.parseRows([]).error.message, '表格为空')
eq(parser.parseRows([['姓名', '性别', '能力']]).error.message, '表格没有有效名单')

// 表头对不上时，必须把"读到的第一行"原样说出来：
// 第一行是合并大标题、或者表头写成别的词，这两种情况用户都以为自己的表头没问题。
const badHeader = parser.parseRows([['2026 年 10 月无限杯报名表'], ['孙达', '男', 'L3']])
ok(badHeader.error.message.indexOf('表头必须包含') >= 0)
// 单元格会截断到 12 个字，断言前缀就够了
ok(badHeader.error.message.indexOf('2026 年 10 月无') >= 0,
  '要把实际读到的第一行内容带出来，实际是：' + badHeader.error.message)

// 带序号和标点的表头要认得出来（Excel 里很常见）
const numbered = parser.parseRows([
  ['1、姓名', '2、性别', '3、能力'],
  ['孙达', '男', 'L3'],
])
ok(!numbered.error, '带序号+顿号的表头应当识别成功')

console.log('名单导入解析测试通过')
