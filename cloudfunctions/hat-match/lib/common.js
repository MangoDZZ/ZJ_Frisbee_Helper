'use strict'

/**
 * 云函数共用的小工具。**唯一源头是本文件**，各云函数 lib/ 下的副本由
 * `node scripts/sync-shared.js` 生成，不要直接改副本。
 *
 * 之所以要靠"一份源 + 同步"而不是直接 require：云函数各自独立部署，
 * 没法引用部署包以外的代码。
 */

/** 成功信封。 */
function ok (data) { return { ok: true, data: data === undefined ? null : data } }

/** 失败信封。code 给前端分流用，message 是可以直接弹给用户的中文。 */
function err (code, message, detail) {
  return { ok: false, error: { code: code, message: message, detail: detail || null } }
}

/**
 * 保证 action 的返回值一定是一个完整的信封。
 *
 * 为什么需要这道闸：`ok()` / `err()` 是手写的，很容易忘。真的发生过——导入名单时
 * 把纯模块返回的 `{code, message}` 原样 `return` 出去，响应里既没有 `ok` 也没有
 * `error`，客户端只能显示一句「操作失败」，而真实原因（表格第 22 行性别写错）
 * 一个字都没传出去。这种错误在服务端看起来是"成功返回"，日志里也不会报错。
 *
 * 所以这里做两件事：结构不对就当场包成能看的错误，并打日志留线索。
 * 它不改变任何正常返回——`{ ok: boolean }` 的东西原样放行。
 */
function ensureEnvelope (result, action) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result

  console.error('[envelope] action=' + (action || '?') + ' 返回了非信封结构', result)
  if (result && typeof result === 'object' && result.message) {
    // 纯模块的错误对象：救回来，别把唯一的线索丢掉
    return err(result.code || 'BAD_RESULT', result.message, result.detail)
  }
  return err('BAD_RESULT',
    '服务内部返回了无法识别的内容（action=' + (action || '?') + '），请查看云函数日志')
}

function trimStr (v) { return typeof v === 'string' ? v.trim() : '' }

/**
 * 解析整数。不能直接用 Number()：Number(null) / Number('') / Number([]) 都是 0，
 * 会把缺失值静默当成 0。其他字段靠范围校验碰巧拦住了，但比分本来就允许 0，
 * 一条 scoreB: null 会被静默录成 15:0。
 */
function asInt (v) {
  if (typeof v === 'number') {
    return isFinite(v) && Math.floor(v) === v ? v : null
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return null
    const n = Number(s)
    return isFinite(n) && Math.floor(n) === n ? n : null
  }
  return null
}

/** 单次查询的取数条数。云数据库单次出包有上限，100 是官方示例里的常用值。 */
const PAGE_SIZE = 100

/**
 * 一次查询累计能取多少条。
 *
 * 以前各处写的是 `for (skip = 0; skip < 1000; skip += 100)`，超出就**静默**少拿数据。
 * 分队和积分都是按报名名单算的，少拿几个人会算出一个看起来正常、其实错的结果，
 * 比直接报错难查得多。这个上限只用来兜住"查询条件写错导致取不完"，
 * 正常数据量远够：活动人数上限 500，一个活动最多 50 场赛事 × 200 场比赛。
 */
const MAX_ROWS = 20000

/**
 * 分页取全。
 *
 * buildQuery 必须是**每次调用都新建查询**的函数：wx-server-sdk 的 Query 是链式可变对象，
 * 复用同一个实例反复 skip() 会互相污染。
 *
 * 取到 max 还没取完就抛错，不静默截断。
 */
async function fetchAll (buildQuery, opts) {
  const o = opts || {}
  const pageSize = o.pageSize || PAGE_SIZE
  const max = o.max != null ? o.max : MAX_ROWS
  const label = o.label || '查询'
  const out = []
  for (let skip = 0; skip < max; skip += pageSize) {
    const res = await buildQuery().skip(skip).limit(pageSize).get()
    const rows = (res && res.data) || []
    for (let i = 0; i < rows.length; i++) out.push(rows[i])
    if (rows.length < pageSize) return out
  }
  throw new Error(label + '的结果超过 ' + max + ' 条上限，已中止以免静默截断')
}

/** `in` 查询单批塞多少个 id。云数据库没规定上限，但几百个 id 一次查会明显变慢。 */
const IN_CHUNK = 100

/** 按 _id 批量取记录。同一条记录只会落在某一批里，不会重复。 */
async function fetchByIds (db, collection, ids, opts) {
  const out = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    const rows = await fetchAll(function () {
      return db.collection(collection).where({ _id: db.command.in(chunk) })
    }, Object.assign({ label: collection + ' 按 id 取数' }, opts))
    for (let j = 0; j < rows.length; j++) out.push(rows[j])
  }
  return out
}

/**
 * 按条件清空一批记录。云数据库单次批量删除有上限（这里按 100 算），
 * 所以循环删到删完为止。
 */
async function removeWhere (db, collection, cond, opts) {
  const o = opts || {}
  const pageSize = o.pageSize || PAGE_SIZE
  const max = o.max != null ? o.max : MAX_ROWS
  let removed = 0
  while (removed < max) {
    const res = await db.collection(collection).where(cond).limit(pageSize).remove()
    const n = (res && res.stats && res.stats.removed) || 0
    removed += n
    if (n < pageSize) return removed
  }
  return removed
}

module.exports = {
  PAGE_SIZE: PAGE_SIZE,
  MAX_ROWS: MAX_ROWS,
  ok: ok,
  err: err,
  ensureEnvelope: ensureEnvelope,
  trimStr: trimStr,
  asInt: asInt,
  fetchAll: fetchAll,
  fetchByIds: fetchByIds,
  removeWhere: removeWhere,
}
