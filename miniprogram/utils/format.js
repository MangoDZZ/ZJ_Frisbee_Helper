'use strict'

/**
 * 时间与展示相关的工具。
 *
 * 时间统一以毫秒时间戳存库，且时间戳一律在客户端由"年月日时分"分量拼出来——
 * 这样时区语义就固定在用户本机，不受云函数运行时区影响。
 */

const LEVEL_TEXT = ['', 'L1', 'L2', 'L3', 'L4', 'L5']
const STATUS_TEXT = { draft: '草稿', open: '报名中', closed: '报名关闭', divided: '已分队' }

function pad (n) { return n < 10 ? '0' + n : '' + n }

/**
 * 由 'YYYY-MM-DD' 和 'HH:mm' 拼出毫秒时间戳。
 *
 * 不用 new Date('2026-09-24 19:00')——这种带空格的格式不是标准格式，
 * 不同引擎解析结果不一致（部分会得到 NaN）。这里按分量显式构造。
 */
function toTimestamp (dateStr, timeStr) {
  if (!dateStr) return null
  const d = String(dateStr).split('-')
  if (d.length !== 3) return null
  const t = String(timeStr || '00:00').split(':')
  const year = Number(d[0])
  const month = Number(d[1])
  const day = Number(d[2])
  const hour = Number(t[0] || 0)
  const minute = Number(t[1] || 0)
  if (!isFinite(year) || !isFinite(month) || !isFinite(day)) return null
  const ms = new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
  return isFinite(ms) ? ms : null
}

/** 时间戳拆回 { date: 'YYYY-MM-DD', time: 'HH:mm' }，供 picker 回填。 */
function splitTimestamp (ms) {
  if (!ms) return { date: '', time: '' }
  const d = new Date(ms)
  return {
    date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
  }
}

function formatDateTime (ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function formatFullDateTime (ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 活动时间范围，同一天只显示一次日期。 */
function formatRange (start, end) {
  if (!start) return ''
  const s = formatDateTime(start)
  if (!end) return s
  const a = new Date(start)
  const b = new Date(end)
  const sameDay = a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  return sameDay
    ? s + '-' + pad(b.getHours()) + ':' + pad(b.getMinutes())
    : s + ' 至 ' + formatDateTime(end)
}

function levelText (level) {
  const n = Number(level)
  return LEVEL_TEXT[n] ? LEVEL_TEXT[n] + '(' + n + ')' : String(level || '')
}

function statusText (status) { return STATUS_TEXT[status] || status || '' }

function genderText (g) { return g === 'M' ? '男' : g === 'F' ? '女' : '未填' }

/** 报名是否已截止（截止时间没设就以开始时间为界）。 */
function isSignupExpired (evt) {
  if (!evt) return false
  const deadline = evt.signupDeadline || evt.startTime
  return !!deadline && Date.now() > deadline
}

function isPast (evt) {
  if (!evt) return false
  const t = evt.endTime || evt.startTime
  return !!t && Date.now() > t
}

module.exports = {
  LEVEL_TEXT: LEVEL_TEXT,
  toTimestamp: toTimestamp,
  splitTimestamp: splitTimestamp,
  formatDateTime: formatDateTime,
  formatFullDateTime: formatFullDateTime,
  formatRange: formatRange,
  levelText: levelText,
  statusText: statusText,
  genderText: genderText,
  isSignupExpired: isSignupExpired,
  isPast: isPast,
}
