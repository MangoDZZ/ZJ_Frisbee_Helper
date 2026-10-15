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

console.log('名单导入解析测试通过')
