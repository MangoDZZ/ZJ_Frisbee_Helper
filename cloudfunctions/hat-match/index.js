'use strict'

/**
 * 比赛战绩与积分云函数。
 *
 * 积分不入库，每次由比赛记录实时推导（见 lib/score.js）。校验在这里从严，
 * 因为任何一条录错的比赛都会变成一个说不通的积分，而且事后很难发现。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const score = require('./lib/score.js')

const db = cloud.database()
const events = db.collection('events')
const signups = db.collection('signups')
const divisions = db.collection('divisions')
const matches = db.collection('matches')

const MAX_MVP = 2
const MAX_MATCHES = 200

function ok (data) { return { ok: true, data: data === undefined ? null : data } }
function err (code, message, detail) {
  return { ok: false, error: { code: code, message: message, detail: detail || null } }
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

/**
 * 比赛必须挂在已发布的分队上——发布之前队伍还可能变，记了也对不上。
 */
async function loadPublishedDivision (eventId) {
  const res = await divisions.where({ eventId: eventId, published: true })
    .orderBy('version', 'desc').limit(1).get()
  const div = res.data && res.data[0]
  if (!div) {
    return { error: err('DIVISION_NOT_PUBLISHED', '请先完成分队并发布，再记录比赛') }
  }
  return { value: div }
}

async function loadMatches (eventId) {
  const res = await matches.where({ eventId: eventId })
    .orderBy('createTime', 'asc').limit(MAX_MATCHES).get()
  return res.data || []
}

/**
 * 校验一场比赛的全部字段。抽出来是因为 saveMatch 新建和更新都要用，
 * 两边各写一份一定会漂移。
 */
function validateMatch (d, division) {
  const teams = division.teams || []

  const a = asInt(d.teamAIndex)
  const b = asInt(d.teamBIndex)
  if (a === null || !teams[a]) return { error: err('INVALID_INPUT', '甲方队伍不存在') }
  if (b === null || !teams[b]) return { error: err('INVALID_INPUT', '乙方队伍不存在') }
  if (a === b) return { error: err('INVALID_INPUT', '两支队伍不能是同一队') }

  const scoreA = asInt(d.scoreA)
  const scoreB = asInt(d.scoreB)
  if (scoreA === null || scoreA < 0) return { error: err('INVALID_INPUT', '甲方比分要是非负整数') }
  if (scoreB === null || scoreB < 0) return { error: err('INVALID_INPUT', '乙方比分要是非负整数') }
  if (scoreA === scoreB) {
    return { error: err('DRAW_NOT_ALLOWED', '不允许平局，请填写分出胜负的比分') }
  }

  // 上场名单必须是该队队员的子集，否则会把别队的人算进积分。
  function pickParticipants (raw, teamIndex, label) {
    const allowed = teams[teamIndex].memberIds || []
    const list = Array.isArray(raw) ? raw : []
    const out = []
    for (let i = 0; i < list.length; i++) {
      const id = trimStr(list[i])
      if (!id) continue
      if (allowed.indexOf(id) < 0) {
        return { error: err('INVALID_PARTICIPANT',
          label + '的上场名单里有不属于该队的人', { id: id, teamIndex: teamIndex }) }
      }
      if (out.indexOf(id) < 0) out.push(id)
    }
    if (out.length === 0) {
      return { error: err('INVALID_INPUT', label + '至少要有 1 名上场队员') }
    }
    return { value: out }
  }

  const pa = pickParticipants(d.participantsA, a, '甲方')
  if (pa.error) return pa
  const pb = pickParticipants(d.participantsB, b, '乙方')
  if (pb.error) return pb

  // MVP 由胜方从败方的上场队员里选，所以只能落在败方且必须上过场。
  const loserParticipants = scoreA > scoreB ? pb.value : pa.value
  const rawMvp = Array.isArray(d.mvpIds) ? d.mvpIds : []
  const mvpIds = []
  for (let i = 0; i < rawMvp.length; i++) {
    const id = trimStr(rawMvp[i])
    if (!id) continue
    if (mvpIds.indexOf(id) >= 0) {
      return { error: err('INVALID_INPUT', '同一个人不能被选为两次 MVP', { id: id }) }
    }
    if (loserParticipants.indexOf(id) < 0) {
      return { error: err('INVALID_MVP',
        'MVP 只能从败方的上场队员里选', { id: id }) }
    }
    mvpIds.push(id)
  }
  if (mvpIds.length > MAX_MVP) {
    return { error: err('INVALID_INPUT', '最多只能选 ' + MAX_MVP + ' 名 MVP') }
  }

  return {
    value: {
      teamAIndex: a,
      teamBIndex: b,
      scoreA: scoreA,
      scoreB: scoreB,
      participantsA: pa.value,
      participantsB: pb.value,
      mvpIds: mvpIds,
    },
  }
}

/** 把一条比赛记录补上队名和人名，让页面能直接渲染。 */
function decorateMatch (m, division, byId) {
  const teams = division.teams || []
  function nameOf (id) {
    const p = byId[id]
    return { _id: id, name: p ? p.name : '(已退出)' }
  }
  const teamA = teams[m.teamAIndex] || { name: '已失效的队' }
  const teamB = teams[m.teamBIndex] || { name: '已失效的队' }
  return {
    _id: m._id,
    teamAIndex: m.teamAIndex,
    teamBIndex: m.teamBIndex,
    teamAName: teamA.name,
    teamBName: teamB.name,
    scoreA: m.scoreA,
    scoreB: m.scoreB,
    winner: score.winnerOf(m),
    participantsA: (m.participantsA || []).map(nameOf),
    participantsB: (m.participantsB || []).map(nameOf),
    mvps: (m.mvpIds || []).map(nameOf),
    createTime: m.createTime,
  }
}

/** 读取类操作的共同前置：参与者只有在分队发布后才能看。 */
async function requireReadable (eventId, openid) {
  const e = await loadEvent(eventId)
  if (e.error) return e
  const evt = e.value
  const isOwner = evt.ownerOpenid === openid

  const d = await loadPublishedDivision(evt._id)
  if (d.error) {
    // 组织者能看到"还没发布"这个状态，参与者直接当作没有数据。
    if (isOwner) return { error: d.error }
    return { error: err('DIVISION_NOT_PUBLISHED', '分队结果还没发布') }
  }
  return { value: { evt: evt, isOwner: isOwner, division: d.value } }
}

const actions = {
  async saveMatch (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireOwner(evt, openid)
    if (forbidden) return forbidden

    const dv = await loadPublishedDivision(evt._id)
    if (dv.error) return dv.error
    const division = dv.value

    const v = validateMatch(d, division)
    if (v.error) return v.error

    const matchId = trimStr(d.matchId)
    const now = Date.now()

    if (matchId) {
      const target = await matches.doc(matchId).get().catch(function () { return null })
      if (!target || !target.data) return err('NOT_FOUND', '比赛记录不存在')
      if (target.data.eventId !== evt._id) {
        return err('FORBIDDEN', '该比赛记录不属于这场活动')
      }
      await matches.doc(matchId).update({
        data: Object.assign({}, v.value, { updateTime: now }),
      })
      return ok({ _id: matchId, updated: true })
    }

    const existing = await matches.where({ eventId: evt._id }).count()
    if (existing.total >= MAX_MATCHES) {
      return err('TOO_MANY', '一场活动最多记录 ' + MAX_MATCHES + ' 场比赛')
    }

    const res = await matches.add({
      data: Object.assign({}, v.value, {
        eventId: evt._id,
        divisionId: division._id,
        createTime: now,
        updateTime: now,
      }),
    })
    return ok({ _id: res._id, updated: false })
  },

  async removeMatch (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const forbidden = requireOwner(e.value, openid)
    if (forbidden) return forbidden

    const matchId = trimStr(d.matchId)
    if (!matchId) return err('INVALID_INPUT', '缺少比赛记录 id')
    const target = await matches.doc(matchId).get().catch(function () { return null })
    if (!target || !target.data) return err('NOT_FOUND', '比赛记录不存在')
    if (target.data.eventId !== e.value._id) {
      return err('FORBIDDEN', '该比赛记录不属于这场活动')
    }

    await matches.doc(matchId).remove()
    return ok({ removed: true })
  },

  async listMatches (d, openid) {
    const r = await requireReadable(d.eventId, openid)
    if (r.error) return r.error
    const ctx = r.value

    const su = await loadSignups(ctx.evt._id)
    const rows = await loadMatches(ctx.evt._id)
    const list = rows.map(function (m) {
      return decorateMatch(m, ctx.division, su.byId)
    })

    return ok({
      isOwner: ctx.isOwner,
      list: list,
      teams: (ctx.division.teams || []).map(function (t) {
        return { index: t.index, name: t.name, memberIds: t.memberIds }
      }),
      teamRecords: score.computeTeamRecords(rows, ctx.division),
    })
  },

  /** 积分榜。实时按比赛记录推导，不读任何存量积分字段。 */
  async leaderboard (d, openid) {
    const r = await requireReadable(d.eventId, openid)
    if (r.error) return r.error
    const ctx = r.value

    const su = await loadSignups(ctx.evt._id)
    const rows = await loadMatches(ctx.evt._id)
    const standings = score.computeStandings(rows, ctx.division, su.byId)

    return ok({
      isOwner: ctx.isOwner,
      eventName: ctx.evt.name,
      rows: standings.rows,
      totals: standings.totals,
      rules: {
        win: score.WIN,
        loss: score.LOSS,
        mvp: score.MVP_BONUS,
      },
    })
  },

  /** 供分队页判断能不能重新分队。 */
  async countMatches (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const forbidden = requireOwner(e.value, openid)
    if (forbidden) return forbidden
    const res = await matches.where({ eventId: e.value._id }).count()
    return ok({ count: res.total })
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
    console.error('[hat-match] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
