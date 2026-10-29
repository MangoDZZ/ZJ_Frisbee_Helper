'use strict'

// 解析活动名单导入表。输入是 xlsx 库 sheet_to_json(..., { header: 1 }) 的二维数组，
// 单独放在这里让字段识别和校验可以脱离微信云环境测试。

const MIN_LEVEL = 1
const MAX_LEVEL = 5

function text (v) {
  return v === null || v === undefined ? '' : String(v).trim()
}

function normalizeHeader (v) {
  return text(v).replace(/[\s\u3000:：、.．()（）]/g, '').toLowerCase()
}

function headerKind (v) {
  const h = normalizeHeader(v)
  if (h.indexOf('姓名') >= 0 || h === 'name' || h === '昵称') return 'name'
  if (h.indexOf('性别') >= 0 || h === 'gender' || h === 'sex') return 'gender'
  if (h.indexOf('能力') >= 0 || h.indexOf('水平') >= 0 || h.indexOf('等级') >= 0 ||
      h === 'level' || h === 'selflevel') return 'level'
  if (h.indexOf('手机') >= 0 || h.indexOf('电话') >= 0 || h === 'phone') return 'phone'
  if (h.indexOf('备注') >= 0 || h === 'remark' || h === 'note') return 'remark'
  return null
}

function parseLevel (v) {
  const s = text(v).toUpperCase()
  const m = s.match(/^(?:L)?([1-5])$/)
  if (!m) return null
  return Number(m[1])
}

function parseGender (v) {
  const s = text(v).toLowerCase()
  if (s === '男' || s === 'm' || s === 'male') return 'M'
  if (s === '女' || s === 'f' || s === 'female') return 'F'
  return null
}

function parseRows (rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: { code: 'INVALID_IMPORT', message: '表格为空' } }
  }

  const header = rows[0] || []
  const columns = {}
  for (let i = 0; i < header.length; i++) {
    const kind = headerKind(header[i])
    if (kind && columns[kind] === undefined) columns[kind] = i
  }
  if (columns.name === undefined || columns.gender === undefined || columns.level === undefined) {
    return {
      error: {
        code: 'INVALID_IMPORT',
        message: '表头必须包含姓名、性别、能力（或水平）三列',
      },
    }
  }

  const list = []
  const errors = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || []
    const allBlank = row.every(function (v) { return text(v) === '' })
    if (allBlank) continue
    const line = i + 1
    const name = text(row[columns.name])
    const gender = parseGender(row[columns.gender])
    const level = parseLevel(row[columns.level])
    if (!name) errors.push('第 ' + line + ' 行缺少姓名')
    else if (name.length > 20) errors.push('第 ' + line + ' 行姓名超过 20 个字')
    if (!gender) errors.push('第 ' + line + ' 行性别必须是男/女或 M/F')
    if (level === null || level < MIN_LEVEL || level > MAX_LEVEL) {
      errors.push('第 ' + line + ' 行能力必须是 L1-L5 或 1-5')
    }
    if (name && gender && level !== null) {
      list.push({
        name: name,
        gender: gender,
        selfLevel: level,
        phone: columns.phone === undefined ? '' : text(row[columns.phone]),
        remark: columns.remark === undefined ? '' : text(row[columns.remark]),
        sourceRow: line,
      })
    }
  }
  if (errors.length > 0) {
    // 一次列全只会让提示长到看不完，前 10 条足够定位问题；但要说明"还有几处"，
    // 否则用户改完这 10 条、再导入又失败，会以为程序在循环报错。
    const head = errors.slice(0, 10).join('；')
    const tail = errors.length > 10 ? '（共 ' + errors.length + ' 处问题，上面只列出前 10 条）' : ''
    return {
      error: { code: 'INVALID_IMPORT', message: head + tail, detail: { errors: errors } },
    }
  }
  if (list.length === 0) return { error: { code: 'INVALID_IMPORT', message: '表格没有有效名单' } }
  return { value: list }
}

module.exports = { parseRows: parseRows, parseLevel: parseLevel, parseGender: parseGender }
