'use strict'

/**
 * 数据读取。**唯一源头是本文件**，各云函数 lib/ 下的副本由
 * `node scripts/sync-shared.js` 生成，不要直接改副本。
 *
 * 这些读取原先在 2~4 个云函数里各写了一遍，改一处漏一处不会报错、只会静默不一致，
 * 所以收到这里。所有函数第一个参数都是 db——模块本身不 require wx-server-sdk，
 * 这样它在离线测试里能直接跑。
 */

const common = require('./common.js')

const trimStr = common.trimStr
const err = common.err
const fetchAll = common.fetchAll

const events = 'events'
const signups = 'signups'
const tournaments = 'tournaments'

async function loadEvent (db, eventId) {
  const id = trimStr(eventId)
  if (!id) return { error: err('INVALID_INPUT', '缺少活动 id') }
  const res = await db.collection(events).doc(id).get().catch(function () { return null })
  if (!res || !res.data) return { error: err('NOT_FOUND', '活动不存在或已被删除') }
  return { value: Object.assign({ _id: id }, res.data) }
}

/** 赛事连同它所属的活动一起取出来——权限判断要用活动的 ownerOpenid。 */
async function loadTournament (db, tournamentId) {
  const id = trimStr(tournamentId)
  if (!id) return { error: err('INVALID_INPUT', '缺少赛事 id') }
  const res = await db.collection(tournaments).doc(id).get().catch(function () { return null })
  if (!res || !res.data) return { error: err('NOT_FOUND', '赛事不存在或已被删除') }
  const t = Object.assign({ _id: id }, res.data)
  const e = await loadEvent(db, t.eventId)
  if (e.error) return e
  return { value: { tournament: t, evt: e.value } }
}

/**
 * 取这场活动的全部有效报名，同时给出 id → 记录的映射。
 *
 * 有效水平统一在这里算（adminLevel 覆盖 selfLevel），前后端和其他云函数都不要再算一遍。
 */
async function loadSignups (db, eventId) {
  const list = await fetchAll(function () {
    return db.collection(signups).where({ eventId: eventId, status: 'signed' })
      .orderBy('createTime', 'asc')
  }, { label: '活动报名名单' })

  const byId = {}
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    byId[s._id] = {
      _id: s._id,
      name: s.name,
      gender: s.gender,
      level: s.adminLevel == null ? s.selfLevel : s.adminLevel,
    }
  }
  return { list: list, byId: byId }
}

module.exports = {
  loadEvent: loadEvent,
  loadTournament: loadTournament,
  loadSignups: loadSignups,
}
