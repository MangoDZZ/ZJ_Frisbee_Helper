'use strict'

/**
 * 分队与约束云函数。
 *
 * 分队算法在小程序端跑（毫秒级，"重新分队"按钮能秒响应，也省云函数调用配额），
 * 这里只负责校验和持久化。校验不能省：
 *  - 名单必须与真实报名记录完全一致，防止客户端塞进不存在的人或漏人；
 *  - 统计一律服务端按报名记录重算，不采信客户端传来的数字，避免伪造或漂移。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const events = db.collection('events')
const signups = db.collection('signups')
const constraints = db.collection('constraints')
const divisions = db.collection('divisions')
const matchesCol = db.collection('matches')

const STAR_LEVEL = 4
const MAX_CONSTRAINTS = 200

function ok (data) { return { ok: true, data: data === undefined ? null : data } }
function err (code, message, detail) {
  return { ok: false, error: { code: code, message: message, detail: detail || null } }
}

function trimStr (v) { return typeof v === 'string' ? v.trim() : '' }

async function loadEvent (eventId) {
  const id = trimStr(eventId)
  if (!id) return { error: err('INVALID_INPUT', '缺少活动 id') }
  const res = await events.doc(id).get().catch(function () { return null })
  if (!res || !res.data) return { error: err('NOT_FOUND', '活动不存在或已被删除') }
  return { value: Object.assign({ _id: id }, res.data) }
}

function requireOwner (evt, openid) {
  if (evt.ownerOpenid !== openid) {
    return err('FORBIDDEN', '只有活动创建者可以进行此操作')
  }
  return null
}

/** 取这场活动的全部有效报名，返回 id → 记录的映射。 */
async function loadSignups (eventId) {
  const all = []
  for (let skip = 0; skip < 1000; skip += 100) {
    const page = await signups.where({ eventId: eventId, status: 'signed' })
      .orderBy('createTime', 'asc').skip(skip).limit(100).get()
    const rows = page.data || []
    for (let i = 0; i < rows.length; i++) all.push(rows[i])
    if (rows.length < 100) break
  }
  const byId = {}
  for (let i = 0; i < all.length; i++) {
    const s = all[i]
    byId[s._id] = {
      _id: s._id,
      name: s.name,
      gender: s.gender,
      level: s.adminLevel == null ? s.selfLevel : s.adminLevel,
    }
  }
  return { list: all, byId: byId }
}

const actions = {
  /** 覆盖式写入这场活动的全部约束。 */
  async setConstraints (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const forbidden = requireOwner(e.value, openid)
    if (forbidden) return forbidden

    const raw = Array.isArray(d.constraints) ? d.constraints : []
    if (raw.length > MAX_CONSTRAINTS) {
      return err('INVALID_INPUT', '约束不要超过 ' + MAX_CONSTRAINTS + ' 条')
    }

    const su = await loadSignups(e.value._id)
    const clean = []
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (!c || (c.type !== 'together' && c.type !== 'apart')) {
        return err('INVALID_INPUT', '第 ' + (i + 1) + ' 条约束类型不对')
      }
      const ids = Array.isArray(c.signupIds) ? c.signupIds
        : Array.isArray(c.ids) ? c.ids : []
      if (ids.length < 2) {
        return err('INVALID_INPUT', '第 ' + (i + 1) + ' 条约束至少需要 2 个人')
      }
      const uniq = []
      for (let j = 0; j < ids.length; j++) {
        const id = trimStr(ids[j])
        if (!su.byId[id]) {
          return err('UNKNOWN_PLAYER', '约束引用了不存在的报名记录：' + id, { id: id })
        }
        if (uniq.indexOf(id) < 0) uniq.push(id)
      }
      if (uniq.length < 2) {
        return err('INVALID_INPUT', '第 ' + (i + 1) + ' 条约束不能只指向同一个人')
      }
      clean.push({ type: c.type, signupIds: uniq })
    }

    for (;;) {
      const removed = await constraints.where({ eventId: e.value._id }).limit(100).remove()
      if (!removed.stats || removed.stats.removed < 100) break
    }
    const now = Date.now()
    for (let i = 0; i < clean.length; i++) {
      await constraints.add({
        data: {
          eventId: e.value._id,
          type: clean[i].type,
          signupIds: clean[i].signupIds,
          createTime: now,
        },
      })
    }
    return ok({ count: clean.length })
  },

  async listConstraints (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const forbidden = requireOwner(e.value, openid)
    if (forbidden) return forbidden

    const res = await constraints.where({ eventId: e.value._id })
      .orderBy('createTime', 'asc').limit(MAX_CONSTRAINTS).get()
    const list = (res.data || []).map(function (c) {
      return { _id: c._id, type: c.type, signupIds: c.signupIds }
    })
    return ok({ list: list })
  },

  /**
   * 保存一次分队结果，每次存一个新版本（可对比、可回滚）。
   * 手动换人也走这里——客户端改完整个名单再提交，不另开一条改动路径。
   */
  async saveDivision (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireOwner(evt, openid)
    if (forbidden) return forbidden

    const teamsIn = Array.isArray(d.teams) ? d.teams : []
    if (teamsIn.length < 1) return err('INVALID_INPUT', '没有队伍数据')

    // 已经录了比赛就不能再改分队：比赛记录引用的是队伍序号和队员 id，
    // 重新分队会让这些引用全部失效，产生"某人的积分属于一支不存在的队"这种
    // 说不清的状态。宁可让组织者多一步，也不要留下对不上的数据。
    const played = await matchesCol.where({ eventId: evt._id }).count()
    if (played.total > 0) {
      return err('MATCHES_EXIST',
        '已经记录了 ' + played.total + ' 场比赛，不能再重新分队。' +
        '如果确实要重分，请先删掉全部比赛记录。',
        { matchCount: played.total })
    }

    const su = await loadSignups(evt._id)
    const expected = Object.keys(su.byId)

    // 名单必须与真实报名记录完全一致：不重复、不遗漏、无幽灵成员。
    const seen = {}
    const teams = []
    for (let i = 0; i < teamsIn.length; i++) {
      const t = teamsIn[i] || {}
      const ids = Array.isArray(t.memberIds) ? t.memberIds : []
      const members = []
      let count = 0; let male = 0; let female = 0
      let star = 0; let levelSum = 0
      for (let j = 0; j < ids.length; j++) {
        const id = trimStr(ids[j])
        const p = su.byId[id]
        if (!p) return err('UNKNOWN_PLAYER', '分队名单里有不存在的报名记录：' + id, { id: id })
        if (seen[id]) return err('INVALID_INPUT', p.name + ' 被分到了多个队', { id: id })
        seen[id] = true
        members.push(id)
        count++
        if (p.gender === 'M') male++
        else if (p.gender === 'F') female++
        if (p.level >= STAR_LEVEL) star++
        levelSum += p.level
      }
      teams.push({
        index: i,
        name: trimStr(t.name) || (i + 1) + '队',
        memberIds: members,
        // 统计服务端重算，不采信客户端传来的数字。
        stats: {
          count: count,
          male: male,
          female: female,
          star: star,
          levelSum: levelSum,
          avgLevel: count > 0 ? Math.round((levelSum / count) * 100) / 100 : 0,
        },
      })
    }

    const missing = expected.filter(function (id) { return !seen[id] })
    if (missing.length > 0) {
      const names = missing.slice(0, 5).map(function (id) { return su.byId[id].name })
      return err('INCOMPLETE_DIVISION',
        '有 ' + missing.length + ' 人没有被分到队：' + names.join('、') +
        (missing.length > 5 ? ' 等' : ''),
        { missing: missing })
    }

    const last = await divisions.where({ eventId: evt._id })
      .orderBy('version', 'desc').limit(1).get()
    const version = last.data && last.data[0] ? last.data[0].version + 1 : 1

    const res = await divisions.add({
      data: {
        eventId: evt._id,
        version: version,
        seed: d.seed == null ? null : String(d.seed),
        teams: teams,
        published: false,
        createTime: Date.now(),
      },
    })
    return ok({ _id: res._id, version: version, teams: teams })
  },

  /**
   * 读取分队结果。创建者看最新版本；参与者只能看已发布的版本，
   * 否则会在组织者还在调整时就看到中间状态。
   */
  async getDivision (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const isOwner = evt.ownerOpenid === openid

    let query = divisions.where({ eventId: evt._id })
    if (!isOwner) query = divisions.where({ eventId: evt._id, published: true })

    const res = await query.orderBy('version', 'desc').limit(1).get()
    const div = res.data && res.data[0]
    if (!div) return ok({ division: null, isOwner: isOwner })

    const su = await loadSignups(evt._id)
    const teams = (div.teams || []).map(function (t) {
      const members = (t.memberIds || []).map(function (id) {
        const p = su.byId[id]
        // 报名记录被删掉的情况下给个占位，避免整页渲染不出来。
        return p || { _id: id, name: '(已退出)', gender: 'U', level: 0 }
      })
      members.sort(function (a, b) {
        if (b.level !== a.level) return b.level - a.level
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
      return { index: t.index, name: t.name, stats: t.stats, members: members }
    })

    return ok({
      isOwner: isOwner,
      division: {
        _id: div._id,
        version: div.version,
        seed: div.seed,
        published: div.published,
        createTime: div.createTime,
        teams: teams,
      },
    })
  },

  async publish (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireOwner(evt, openid)
    if (forbidden) return forbidden

    const divisionId = trimStr(d.divisionId)
    if (!divisionId) return err('INVALID_INPUT', '缺少分队记录 id')
    const target = await divisions.doc(divisionId).get().catch(function () { return null })
    if (!target || !target.data) return err('NOT_FOUND', '分队记录不存在')
    if (target.data.eventId !== evt._id) {
      return err('FORBIDDEN', '该分队记录不属于这场活动')
    }

    // 同一活动只保留一个已发布版本，避免参与者读到两个"最新"。
    const others = await divisions.where({
      eventId: evt._id, published: true, _id: _.neq(divisionId),
    }).limit(100).get()
    for (let i = 0; i < (others.data || []).length; i++) {
      await divisions.doc(others.data[i]._id).update({ data: { published: false } })
    }

    await divisions.doc(divisionId).update({ data: { published: true } })
    await events.doc(evt._id).update({
      data: { status: 'divided', updateTime: Date.now() },
    })
    return ok({ published: true })
  },

  /** 撤销发布，活动回到"报名已关闭"，可以重新分队。 */
  async unpublish (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireOwner(evt, openid)
    if (forbidden) return forbidden

    const all = await divisions.where({ eventId: evt._id, published: true }).limit(100).get()
    for (let i = 0; i < (all.data || []).length; i++) {
      await divisions.doc(all.data[i]._id).update({ data: { published: false } })
    }
    await events.doc(evt._id).update({
      data: { status: 'closed', updateTime: Date.now() },
    })
    return ok({ published: false })
  },

  /** 历史版本列表，供对比与回滚。 */
  async listDivisions (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const forbidden = requireOwner(e.value, openid)
    if (forbidden) return forbidden

    const res = await divisions.where({ eventId: e.value._id })
      .orderBy('version', 'desc').limit(20).get()
    const list = (res.data || []).map(function (x) {
      return {
        _id: x._id,
        version: x.version,
        seed: x.seed,
        published: x.published,
        createTime: x.createTime,
        teamCount: (x.teams || []).length,
      }
    })
    return ok({ list: list })
  },
}

exports.main = async function (event) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return err('NO_AUTH', '无法获取用户身份')

  const action = event && event.action
  const handler = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null
  if (!handler) return err('UNKNOWN_ACTION', '未知操作：' + action)

  try {
    return await handler(event.data || {}, openid)
  } catch (e) {
    console.error('[hat-team] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
