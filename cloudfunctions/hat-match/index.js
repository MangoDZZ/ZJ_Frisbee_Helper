'use strict'

/**
 * 比赛战绩与积分云函数。
 *
 * 比赛挂在**赛事**上；积分榜是**活动级汇总**（把该活动下所有赛事的得分按人合并）。
 * 组织者（含管理员）可以录战绩、看积分，角色增删仍由 hat-admin 单独限制给管理员。
 *
 * 积分不入库，每次由比赛记录实时推导（见 lib/score.js）。校验在这里从严，
 * 因为任何一条录错的比赛都会变成一个说不通的积分，而且事后很难发现。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const common = require('./lib/common.js')
const score = require('./lib/score.js')
const roles = require('./lib/roles.js')
const store = require('./lib/store.js')

const db = cloud.database()
const divisions = db.collection('divisions')
const tournaments = db.collection('tournaments')
const matches = db.collection('matches')

const ok = common.ok
const err = common.err
const trimStr = common.trimStr
const asInt = common.asInt
const fetchAll = common.fetchAll

const MAX_MVP = 2
const MAX_MATCHES = 200

async function loadPublishedDivision (tournamentId) {
  const res = await divisions.where({ tournamentId: tournamentId, published: true })
    .orderBy('version', 'desc').limit(1).get()
  const div = res.data && res.data[0]
  if (!div) {
    return { error: err('DIVISION_NOT_PUBLISHED', '请先完成分队并发布，再记录比赛') }
  }
  return { value: div }
}

async function loadMatchesOfTournament (tournamentId) {
  const res = await matches.where({ tournamentId: tournamentId })
    .orderBy('createTime', 'asc').limit(MAX_MATCHES).get()
  return res.data || []
}

/** 活动下所有赛事的比赛，用于汇总积分榜。 */
async function loadMatchesOfEvent (eventId) {
  return fetchAll(function () {
    return matches.where({ eventId: eventId }).orderBy('createTime', 'asc')
  }, { label: '活动全部比赛' })
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

  // 弃赛人员必须属于本场两队，且不能同时记为上场人员。
  const allowedForfeit = (teams[a].memberIds || []).concat(teams[b].memberIds || [])
  const rawForfeit = Array.isArray(d.forfeitIds) ? d.forfeitIds : []
  const forfeitIds = []
  for (let i = 0; i < rawForfeit.length; i++) {
    const id = trimStr(rawForfeit[i])
    if (!id) continue
    if (allowedForfeit.indexOf(id) < 0) {
      return { error: err('INVALID_FORFEIT', '弃赛人员不属于本场对阵队伍', { id: id }) }
    }
    if (pa.value.indexOf(id) >= 0 || pb.value.indexOf(id) >= 0) {
      return { error: err('INVALID_FORFEIT', '弃赛人员不能同时出现在上场名单中', { id: id }) }
    }
    if (forfeitIds.indexOf(id) >= 0) {
      return { error: err('INVALID_INPUT', '同一个人不能重复登记弃赛', { id: id }) }
    }
    forfeitIds.push(id)
  }

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
      return { error: err('INVALID_MVP', 'MVP 只能从败方的上场队员里选', { id: id }) }
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
      forfeitIds: forfeitIds,
    },
  }
}

/** 把一条比赛记录补上队名和人名。不带 level——球员水平不公开。 */
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
    forfeits: (m.forfeitIds || []).map(nameOf),
    createTime: m.createTime,
  }
}

/** 录战绩的权限：组织者、管理员，以及活动的创建者。 */
function requireManage (evt, r) {
  if (!roles.canManageEvent(r, evt)) {
    return err('FORBIDDEN', '只有组织者或管理员可以录入比赛')
  }
  return null
}

const actions = {
  async saveMatch (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const tour = t.value.tournament
    const evt = t.value.evt

    const forbidden = requireManage(evt, r)
    if (forbidden) return forbidden

    const dv = await loadPublishedDivision(tour._id)
    if (dv.error) return dv.error
    const division = dv.value

    const v = validateMatch(d, division)
    if (v.error) return v.error

    const matchId = trimStr(d.matchId)
    const now = Date.now()

    if (matchId) {
      const target = await matches.doc(matchId).get().catch(function () { return null })
      if (!target || !target.data) return err('NOT_FOUND', '比赛记录不存在')
      if (target.data.tournamentId !== tour._id) {
        return err('FORBIDDEN', '该比赛记录不属于这场赛事')
      }
      await matches.doc(matchId).update({
        data: Object.assign({}, v.value, { updateTime: now }),
      })
      return ok({ _id: matchId, updated: true })
    }

    const existing = await matches.where({ tournamentId: tour._id }).count()
    if (existing.total >= MAX_MATCHES) {
      return err('TOO_MANY', '一场赛事最多记录 ' + MAX_MATCHES + ' 场比赛')
    }

    const res = await matches.add({
      data: Object.assign({}, v.value, {
        tournamentId: tour._id,
        // 冗余存一份 eventId，汇总积分榜要按活动一次查出所有比赛。
        eventId: tour.eventId,
        divisionId: division._id,
        createTime: now,
        updateTime: now,
        createdBy: r.openid,
      }),
    })
    return ok({ _id: res._id, updated: false })
  },

  async removeMatch (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const forbidden = requireManage(t.value.evt, r)
    if (forbidden) return forbidden

    const matchId = trimStr(d.matchId)
    if (!matchId) return err('INVALID_INPUT', '缺少比赛记录 id')
    const target = await matches.doc(matchId).get().catch(function () { return null })
    if (!target || !target.data) return err('NOT_FOUND', '比赛记录不存在')
    if (target.data.tournamentId !== t.value.tournament._id) {
      return err('FORBIDDEN', '该比赛记录不属于这场赛事')
    }

    await matches.doc(matchId).remove()
    return ok({ removed: true })
  },

  /** 单场赛事的比赛列表。参与者需要该赛事已发布分队。 */
  async listMatches (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const tour = t.value.tournament
    const evt = t.value.evt

    // 组织者和管理员既能录战绩也能看未发布的分队；其他人只能看已发布的。
    const canScore = roles.canManageEvent(r, evt)
    const isOrganizer = canScore

    const dv = await loadPublishedDivision(tour._id)
    if (dv.error) {
      if (isOrganizer) return dv.error
      return err('DIVISION_NOT_PUBLISHED', '分队结果还没发布')
    }

    const su = await store.loadSignups(db, tour.eventId)
    const rows = await loadMatchesOfTournament(tour._id)
    const list = rows.map(function (m) {
      return decorateMatch(m, dv.value, su.byId)
    })

    return ok({
      isOwner: canScore,
      isOrganizer: isOrganizer,
      canScore: canScore,
      tournamentName: tour.name,
      eventId: tour.eventId,
      list: list,
      teams: (dv.value.teams || []).map(function (x) {
        return { index: x.index, name: x.name, memberIds: x.memberIds }
      }),
      teamRecords: score.computeTeamRecords(rows, dv.value),
    })
  },

  /**
   * 积分榜：整个活动的汇总，把该活动下所有赛事的得分按人合并。
   * 实时推导，不读任何存量积分字段。返回里不含球员水平。
   */
  async leaderboard (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const isOrganizer = roles.canManageEvent(r, evt)

    // 参与者至少要有一场赛事已发布，才看得到积分榜。
    const pub = await divisions.where({ eventId: evt._id, published: true }).limit(1).count()
    if (pub.total === 0 && !isOrganizer) {
      return err('DIVISION_NOT_PUBLISHED', '分队结果还没发布')
    }

    const su = await store.loadSignups(db, evt._id)
    const rows = await loadMatchesOfEvent(evt._id)
    const standings = score.computeStandings(rows, su.byId)

    const tourCount = await tournaments.where({ eventId: evt._id }).count()

    return ok({
      isOrganizer: isOrganizer,
      eventName: evt.name,
      tournamentCount: tourCount.total,
      rows: standings.rows,
      totals: standings.totals,
      rules: {
        win: score.WIN,
        loss: score.LOSS,
        mvp: score.MVP_BONUS,
        forfeit: score.FORFEIT,
        forfeitReset: score.FORFEIT_RESET,
      },
    })
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
    // 角色只查一次，之后所有权限判定都是纯函数。
    const r = await roles.loadRoles(db, openid)
    return await handler(event.data || {}, r)
  } catch (e) {
    console.error('[hat-match] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
