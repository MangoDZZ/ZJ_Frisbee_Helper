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
const signups = db.collection('signups')
// 随机事件：randomEvents 是事件池（定义），randomDraws 是已触发的记录
const randomEvents = db.collection('randomEvents')
const randomDraws = db.collection('randomDraws')

const ok = common.ok
const err = common.err
const trimStr = common.trimStr
const asInt = common.asInt
const fetchAll = common.fetchAll
const removeWhere = common.removeWhere

const MAX_MVP = 2
const MAX_MATCHES = 200

/** 随机事件：池子上限、单次说明长度、效果绝对值上限、一次最多返回多少条触发记录 */
const MAX_RANDOM_EVENTS = 100
const MAX_EVENT_TEXT = 60
const MAX_EVENT_DELTA = 10
const MAX_DRAW_LIST = 200

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
 * 活动下每个赛事的最新一份分队，{ [tournamentId]: division }。
 *
 * publishedOnly 为 true 时只看已发布的——参与者不该从摘要里读到组织者还没定稿的分队。
 * 按 version 升序遍历，后写入的覆盖前面的，所以拿到的就是最新版本。
 */
async function loadDivisionByTournament (eventId, publishedOnly) {
  const cond = { eventId: eventId }
  if (publishedOnly) cond.published = true
  const rows = await fetchAll(function () {
    return divisions.where(cond).orderBy('version', 'asc')
  }, { label: '分组记录' })
  const byTour = {}
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].tournamentId) byTour[rows[i].tournamentId] = rows[i]
  }
  return byTour
}

/**
 * 校验一场比赛的全部字段。抽出来是因为 saveMatch 新建和更新都要用，
 * 两边各写一份一定会漂移。
 *
 * 比分有两个来源：
 *  - 有 points 明细时，比分由明细条数**算出来**，客户端传来的 scoreA/scoreB 一概不采信
 *  - 没有明细时，沿用客户端手填的 scoreA/scoreB（v1.1.0 之前的老前端走这条路）
 * 这样新旧前端都能提交，明细也不会和比分对不上。
 *
 * @param {boolean} [allowDraw] 是否允许平局。**比赛中（live）必须允许**：
 *   记分过程中比分本来就会反复持平，不允许的话自动暂存会一直失败，闪退就丢数据。
 *   比赛结束（finished）仍然不允许平局。
 */
function validateMatch (d, division, allowDraw) {
  const teams = division.teams || []

  const a = asInt(d.teamAIndex)
  const b = asInt(d.teamBIndex)
  if (a === null || !teams[a]) return { error: err('INVALID_INPUT', '甲方队伍不存在') }
  if (b === null || !teams[b]) return { error: err('INVALID_INPUT', '乙方队伍不存在') }
  if (a === b) return { error: err('INVALID_INPUT', '两支队伍不能是同一队') }

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

  // ---- 比分与逐分明细 ----
  const rawPoints = Array.isArray(d.points) ? d.points : []
  const points = []
  let scoreA = asInt(d.scoreA)
  let scoreB = asInt(d.scoreB)

  if (rawPoints.length > 0) {
    if (rawPoints.length > score.MAX_POINTS_PER_MATCH) {
      return { error: err('INVALID_INPUT', '一场最多记录 ' + score.MAX_POINTS_PER_MATCH + ' 分') }
    }
    for (let i = 0; i < rawPoints.length; i++) {
      const p = rawPoints[i] || {}
      const team = p.team === 'A' ? 'A' : p.team === 'B' ? 'B' : null
      if (!team) {
        return { error: err('INVALID_POINT', '第 ' + (i + 1) + ' 分的得分队伍不对') }
      }
      const participants = team === 'A' ? pa.value : pb.value
      const label = team === 'A' ? '甲方' : '乙方'

      const scorer = trimStr(p.scorer)
      if (!scorer) return { error: err('INVALID_POINT', '第 ' + (i + 1) + ' 分没有填得分队员') }
      // 得分队员必须是这一队**上过场**的人，否则会把没打的人算进数据。
      if (participants.indexOf(scorer) < 0) {
        return {
          error: err('INVALID_POINT',
            '第 ' + (i + 1) + ' 分的得分队员不在' + label + '的上场名单里', { id: scorer }),
        }
      }

      let assist = null
      if (p.assist !== null && p.assist !== undefined && p.assist !== '') {
        assist = trimStr(p.assist)
        if (participants.indexOf(assist) < 0) {
          return {
            error: err('INVALID_POINT',
              '第 ' + (i + 1) + ' 分的助攻队员不在' + label + '的上场名单里', { id: assist }),
          }
        }
        // 自己助攻自己不算助攻——真发生这种数据，宁可直接报错让人改。
        if (assist === scorer) {
          return { error: err('INVALID_POINT', '第 ' + (i + 1) + ' 分的得分和助攻不能是同一个人') }
        }
      }

      points.push({ team: team, scorer: scorer, assist: assist })
    }
    scoreA = points.filter(function (p) { return p.team === 'A' }).length
    scoreB = points.filter(function (p) { return p.team === 'B' }).length
  } else {
    if (scoreA === null || scoreA < 0) {
      return { error: err('INVALID_INPUT', '甲方比分要是非负整数（或逐分记录得分明细）') }
    }
    if (scoreB === null || scoreB < 0) {
      return { error: err('INVALID_INPUT', '乙方比分要是非负整数（或逐分记录得分明细）') }
    }
  }

  // 比赛中允许平局：这一分记完正好打成平手是常态，不能让暂存失败。
  if (scoreA === scoreB && !allowDraw) {
    return {
      error: err('DRAW_NOT_ALLOWED',
        rawPoints.length > 0
          ? '当前记录是平局，请把分出胜负的每一分都记上'
          : '不允许平局，请填写分出胜负的比分'),
    }
  }

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

  // 注：这里不需要再检查"弃赛的人不能还得过分"。得分队员必须是上场名单里的人，
  // 而弃赛的人按上面这条规则不可能在上场名单里，两个不变量合起来已经把这种情况排除了。

  // MVP 由胜方从败方的上场队员里选，所以只能落在败方且必须上过场。
  // 比分持平时（只可能是比赛中）没有"败方"，此时不做这一项判定，只要求是上场队员：
  // 否则记分员在阶段三重选过 MVP、又回阶段二记了一分打成平手，自动暂存就会整个失败。
  const decided = scoreA !== scoreB
  const loserParticipants = decided
    ? (scoreA > scoreB ? pb.value : pa.value)
    : pa.value.concat(pb.value)
  const rawMvp = Array.isArray(d.mvpIds) ? d.mvpIds : []
  const mvpIds = []
  for (let i = 0; i < rawMvp.length; i++) {
    const id = trimStr(rawMvp[i])
    if (!id) continue
    if (mvpIds.indexOf(id) >= 0) {
      return { error: err('INVALID_INPUT', '同一个人不能被选为两次 MVP', { id: id }) }
    }
    if (loserParticipants.indexOf(id) < 0) {
      return {
        error: err('INVALID_MVP',
          decided ? 'MVP 只能从败方的上场队员里选' : 'MVP 只能是本场上了场的队员', { id: id }),
      }
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
      points: points,
      participantsA: pa.value,
      participantsB: pb.value,
      mvpIds: mvpIds,
      forfeitIds: forfeitIds,
    },
  }
}

/** 比赛状态。老记录没有 status，按"已结束"对待——否则历史数据会从积分榜上消失。 */
function matchStatus (v) {
  return v === 'live' ? 'live' : 'finished'
}

// ---------------------------------------------------------------- 随机事件

/**
 * 校验事件池。覆盖式保存，和 setConstraints 一个路子：整份提交，不做增量，
 * 避免两边状态不一致。
 */
function validateEventPool (raw, signupsById) {
  const list = Array.isArray(raw) ? raw : []
  if (list.length > MAX_RANDOM_EVENTS) {
    return { error: err('INVALID_INPUT', '随机事件不要超过 ' + MAX_RANDOM_EVENTS + ' 条') }
  }

  const clean = []
  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {}
    const text = trimStr(c.text)
    if (!text) return { error: err('INVALID_INPUT', '第 ' + (i + 1) + ' 条缺少事件说明') }
    if (text.length > MAX_EVENT_TEXT) {
      return { error: err('INVALID_INPUT', '第 ' + (i + 1) + ' 条说明不要超过 ' + MAX_EVENT_TEXT + ' 个字') }
    }

    const delta = asInt(c.delta)
    if (delta === null || delta === 0) {
      return { error: err('INVALID_INPUT', '第 ' + (i + 1) + ' 条的效果要是非 0 整数') }
    }
    if (Math.abs(delta) > MAX_EVENT_DELTA) {
      return { error: err('INVALID_INPUT', '第 ' + (i + 1) + ' 条的效果最大 ±' + MAX_EVENT_DELTA) }
    }

    const rawIds = Array.isArray(c.signupIds) ? c.signupIds : []
    const ids = []
    for (let j = 0; j < rawIds.length; j++) {
      const id = trimStr(rawIds[j])
      if (!id) continue
      if (!signupsById[id]) {
        return { error: err('UNKNOWN_PLAYER', '第 ' + (i + 1) + ' 条引用了不存在的报名记录：' + id, { id: id }) }
      }
      if (ids.indexOf(id) < 0) ids.push(id)
    }
    // 触发名单至少 1 人：没有对象的加分/减分没有意义
    if (ids.length === 0) {
      return { error: err('INVALID_INPUT', '第 ' + (i + 1) + ' 条至少要选 1 个触发的人') }
    }
    clean.push({ text: text, delta: delta, signupIds: ids })
  }
  return { value: clean }
}

/** 已触发的记录，按时间正序（老的在前）。 */
async function loadDraws (eventId) {
  return fetchAll(function () {
    return randomDraws.where({ eventId: eventId }).orderBy('createTime', 'asc')
  }, { label: '随机事件触发记录' })
}

/**
 * 把触发记录摊平成积分调整。
 *
 * 只取 signupIds 和 delta：computeStandings 只关心"谁加/减了多少"。
 */
function drawsToAdjustments (draws) {
  return (draws || []).map(function (d) {
    return { signupIds: d.signupIds || [], delta: d.delta }
  })
}

/** 触发记录补上人名，供页面直接渲染。 */
function decorateDraw (d, byId) {
  return {
    _id: d._id,
    text: d.text,
    delta: d.delta,
    deltaText: (d.delta > 0 ? '+' : '') + d.delta,
    names: (d.signupIds || []).map(function (id) {
      const p = byId[id]
      return p ? p.name : '(已退出)'
    }),
    createTime: d.createTime,
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
    status: matchStatus(m.status),
    hasPoints: score.hasPoints(m),
    points: (m.points || []).map(function (p) {
      return {
        team: p.team,
        scorer: nameOf(p.scorer),
        assist: p.assist ? nameOf(p.assist) : null,
      }
    }),
    winner: score.winnerOf(m),
    participantsA: (m.participantsA || []).map(nameOf),
    participantsB: (m.participantsB || []).map(nameOf),
    mvps: (m.mvpIds || []).map(nameOf),
    forfeits: (m.forfeitIds || []).map(nameOf),
    createTime: m.createTime,
    updateTime: m.updateTime,
    createdBy: m.createdBy || '',
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

    // 比赛状态：赛中就存成 live，结束时存 finished。老前端不传，按 finished 处理。
    // 状态要先算出来，因为"能不能是平局"取决于它：比赛中允许平局，结束不允许。
    const status = matchStatus(d.status)

    const v = validateMatch(d, division, status === 'live')
    if (v.error) return v.error

    const patch = Object.assign({}, v.value, { status: status })

    const matchId = trimStr(d.matchId)
    const now = Date.now()

    if (matchId) {
      const target = await matches.doc(matchId).get().catch(function () { return null })
      if (!target || !target.data) return err('NOT_FOUND', '比赛记录不存在')
      if (target.data.tournamentId !== tour._id) {
        return err('FORBIDDEN', '该比赛记录不属于这场赛事')
      }
      await matches.doc(matchId).update({
        data: Object.assign({}, patch, { updateTime: now }),
      })
      return ok({ _id: matchId, updated: true, status: status })
    }

    const existing = await matches.where({ tournamentId: tour._id }).count()
    if (existing.total >= MAX_MATCHES) {
      return err('TOO_MANY', '一场赛事最多记录 ' + MAX_MATCHES + ' 场比赛')
    }

    const res = await matches.add({
      data: Object.assign({}, patch, {
        tournamentId: tour._id,
        // 冗余存一份 eventId，汇总积分榜要按活动一次查出所有比赛。
        eventId: tour.eventId,
        divisionId: division._id,
        createTime: now,
        updateTime: now,
        createdBy: r.openid,
      }),
    })
    return ok({ _id: res._id, updated: false, status: status })
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
    const noView = await store.requireEventView(db, evt, r)
    if (noView) return noView

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
   * 活动顶层的「比赛记录」摘要：最近几场的比分，给活动详情页直接展示。
   *
   * 为什么单开一个 action 而不是让前端逐场赛事去查：活动详情页只需要"最近两场"
   * 这一点信息，为它把每个赛事的比赛列表都拉一遍是 N 次往返，赛事一多就卡。
   *
   * 队伍名要按**各自赛事的**分队解析——不同赛事的队号是不同的队。
   * 参与者只能看到已发布分队的那些比赛，与单场赛事页的口径保持一致。
   */
  async recentMatches (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value

    const canManage = roles.canManageEvent(r, evt)
    // 「仅限群聊转发可见」的活动连摘要都不能漏给看不到它的人
    const noView = await store.requireEventView(db, evt, r)
    if (noView) return noView

    const rawLimit = asInt(d.limit)
    const limit = rawLimit === null || rawLimit < 1 || rawLimit > 10 ? 2 : rawLimit

    const tourRows = await fetchAll(function () {
      return tournaments.where({ eventId: evt._id }).orderBy('createTime', 'asc')
    }, { label: '活动赛事' })
    const tourNameOf = {}
    for (let i = 0; i < tourRows.length; i++) tourNameOf[tourRows[i]._id] = tourRows[i].name

    // 每个赛事取最新（管理身份）或最新已发布（其他人）的一份分队
    const byTour = await loadDivisionByTournament(evt._id, !canManage)

    const all = await loadMatchesOfEvent(evt._id)
    const list = []
    // 倒序取最近的：all 是按 createTime 升序的
    for (let i = all.length - 1; i >= 0 && list.length < limit; i--) {
      const m = all[i]
      const div = byTour[m.tournamentId]
      if (!div) continue                     // 分队被删了 / 还没发布，跳过
      const teams = div.teams || []
      const teamA = teams[m.teamAIndex] || { name: '已失效的队' }
      const teamB = teams[m.teamBIndex] || { name: '已失效的队' }
      list.push({
        _id: m._id,
        tournamentId: m.tournamentId,
        tournamentName: tourNameOf[m.tournamentId] || '赛事',
        teamAName: teamA.name,
        teamBName: teamB.name,
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        status: matchStatus(m.status),
        hasPoints: score.hasPoints(m),
        createTime: m.createTime,
      })
    }

    // 只给"能点进去"的赛事 id：没有比赛时退到最新一场赛事，方便组织者直接去录
    const lastTour = tourRows.length > 0 ? tourRows[tourRows.length - 1] : null
    return ok({
      list: list,
      tournamentCount: tourRows.length,
      entryTournamentId: list.length > 0 ? list[0].tournamentId
        : (lastTour ? lastTour._id : ''),
      entryTournamentName: list.length > 0
        ? list[0].tournamentName
        : (lastTour ? lastTour.name : ''),
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
    // 群内可见的活动：连积分榜都不能对看不到活动的人开放
    const noView = await store.requireEventView(db, evt, r)
    if (noView) return noView

    // 参与者至少要有一场赛事已发布，才看得到积分榜。
    const pub = await divisions.where({ eventId: evt._id, published: true }).limit(1).count()
    if (pub.total === 0 && !isOrganizer) {
      return err('DIVISION_NOT_PUBLISHED', '分队结果还没发布')
    }

    const su = await store.loadSignups(db, evt._id)
    const rows = await loadMatchesOfEvent(evt._id)
    const draws = await loadDraws(evt._id)
    const standings = score.computeStandings(rows, su.byId, drawsToAdjustments(draws))

    const tourCount = await tournaments.where({ eventId: evt._id }).count()

    // 比赛中的比赛也计分（否则记分员忘了点「结束比赛」就会静默少分），
    // 但要把场次数告诉前端，免得组织者以为数字已经定稿。
    let liveCount = 0
    for (let i = 0; i < rows.length; i++) {
      if (matchStatus(rows[i].status) === 'live') liveCount++
    }

    // 最近触发的随机事件，让参与者也能看到"这几分是怎么来的"（趣味性全在这儿）。
    // 倒序取最近若干条，完整历史走 listDraws。
    const recentDraws = draws.slice(-20).reverse().map(function (d) {
      return decorateDraw(d, su.byId)
    })

    return ok({
      isOrganizer: isOrganizer,
      eventName: evt.name,
      tournamentCount: tourCount.total,
      liveMatchCount: liveCount,
      rows: standings.rows,
      totals: standings.totals,
      recentDraws: recentDraws,
      rules: {
        win: score.WIN,
        loss: score.LOSS,
        mvp: score.MVP_BONUS,
        forfeit: score.FORFEIT,
        forfeitReset: score.FORFEIT_RESET,
      },
    })
  },

  // ---------------------------------------------------------------- 随机事件

  /** 事件池。只有管理身份能看——对参与者来说池子里的内容该是惊喜。 */
  async listRandomEvents (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden

    const su = await store.loadSignups(db, e.value._id)
    const list = await fetchAll(function () {
      return randomEvents.where({ eventId: e.value._id }).orderBy('createTime', 'asc')
    }, { label: '随机事件池' })

    return ok({
      eventName: e.value.name,
      list: list.map(function (x) {
        return {
          _id: x._id,
          text: x.text,
          delta: x.delta,
          signupIds: x.signupIds || [],
          names: (x.signupIds || []).map(function (id) {
            const p = su.byId[id]
            return p ? p.name : '(已退出)'
          }),
        }
      }),
    })
  },

  /** 覆盖式保存事件池。传空数组就是清空。 */
  async setRandomEvents (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireManage(evt, r)
    if (forbidden) return forbidden

    const su = await store.loadSignups(db, evt._id)
    const v = validateEventPool(d.events, su.byId)
    if (v.error) return v.error

    await removeWhere(db, 'randomEvents', { eventId: evt._id })
    const now = Date.now()
    for (let i = 0; i < v.value.length; i++) {
      await randomEvents.add({
        data: {
          eventId: evt._id,
          text: v.value[i].text,
          delta: v.value[i].delta,
          signupIds: v.value[i].signupIds,
          createTime: now + i,   // 错开 1ms，池子顺序稳定
          createdBy: r.openid,
        },
      })
    }
    return ok({ count: v.value.length })
  },

  /**
   * 抽取一个随机事件并立即生效。
   *
   * 随机在**服务端**做：一是客户端拿不到池子（惊喜感），二是抽中的结果要落库，
   * 落库的东西就不该由客户端说了算。抽中的事件仍留在池子里，可以继续抽。
   */
  async drawRandomEvent (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireManage(evt, r)
    if (forbidden) return forbidden

    const pool = await fetchAll(function () {
      return randomEvents.where({ eventId: evt._id }).orderBy('createTime', 'asc')
    }, { label: '随机事件池' })
    if (pool.length === 0) {
      return err('NO_RANDOM_EVENT', '还没有设置随机事件，请先在「随机事件」页里添加')
    }

    const picked = pool[Math.floor(Math.random() * pool.length)]
    // 触发记录存**快照**（说明 + 效果 + 名单），不引用事件池里的 id：
    // 池子是覆盖式保存的，id 每次都会变，引用它必然悬空。
    const res = await randomDraws.add({
      data: {
        eventId: evt._id,
        text: picked.text,
        delta: picked.delta,
        signupIds: (picked.signupIds || []).slice(),
        createTime: Date.now(),
        createdBy: r.openid,
      },
    })

    const su = await store.loadSignups(db, evt._id)
    return ok({
      draw: decorateDraw({
        _id: res._id,
        text: picked.text,
        delta: picked.delta,
        signupIds: picked.signupIds || [],
        createTime: Date.now(),
      }, su.byId),
      poolSize: pool.length,
    })
  },

  /**
   * 已触发的记录。
   *
   * 参与者也能看——随机事件就是给大家看个乐子的。门槛与积分榜一致：
   * 参与者至少要有一场赛事已发布，否则连积分都还没公开。
   */
  async listDraws (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const isOrganizer = roles.canManageEvent(r, evt)
    const noView = await store.requireEventView(db, evt, r)
    if (noView) return noView

    const pub = await divisions.where({ eventId: evt._id, published: true }).limit(1).count()
    if (pub.total === 0 && !isOrganizer) {
      return err('DIVISION_NOT_PUBLISHED', '分队结果还没发布')
    }

    const su = await store.loadSignups(db, evt._id)
    const list = await loadDraws(evt._id)
    // 最新的排前面：页面第一眼要看到刚抽的那个
    const out = list.slice(-MAX_DRAW_LIST).reverse().map(function (x) {
      return decorateDraw(x, su.byId)
    })
    return ok({
      eventName: evt.name,
      isOrganizer: isOrganizer,
      total: list.length,
      list: out,
    })
  },

  /** 撤销一条触发记录。积分是实时推导的，删掉记录这笔调整就跟着消失。 */
  async removeDraw (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden

    const drawId = trimStr(d.drawId)
    if (!drawId) return err('INVALID_INPUT', '缺少记录 id')

    const target = await randomDraws.doc(drawId).get().catch(function () { return null })
    if (!target || !target.data) return err('NOT_FOUND', '这条记录不存在')
    if (target.data.eventId !== e.value._id) {
      return err('FORBIDDEN', '该记录不属于这场活动')
    }

    await randomDraws.doc(drawId).remove()
    return ok({ removed: true })
  },

  /**
   * 得分助攻榜：活动级汇总，按逐分明细统计每个人的得分与助攻。
   *
   * 只算有明细的比赛——老比赛只有比分，分不出谁得了哪一分。场次数一并返回，
   * 好让页面把"有几场没有明细"讲清楚，而不是让人以为统计漏了。
   */
  async pointStats (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const isOrganizer = roles.canManageEvent(r, evt)
    const noView = await store.requireEventView(db, evt, r)
    if (noView) return noView

    // 和积分榜同样的门槛：参与者至少要有一场赛事已发布。
    const pub = await divisions.where({ eventId: evt._id, published: true }).limit(1).count()
    if (pub.total === 0 && !isOrganizer) {
      return err('DIVISION_NOT_PUBLISHED', '分队结果还没发布')
    }

    const su = await store.loadSignups(db, evt._id)
    const rows = await loadMatchesOfEvent(evt._id)
    const stats = score.computePointStats(rows, su.byId)
    const tourCount = await tournaments.where({ eventId: evt._id }).count()

    return ok({
      isOrganizer: isOrganizer,
      eventName: evt.name,
      tournamentCount: tourCount.total,
      matchCount: (rows || []).length,
      rows: stats.rows,
      totals: stats.totals,
    })
  },

  /**
   * 我的数据：报名者查看自己的得分与助攻，含逐场明细。
   *
   * 只返回调用者**自己**的数据（按 openid 反查报名记录），所以不需要额外权限，
   * 也不受"分队已发布"的限制——自己的数据随时能看。
   */
  async myStats (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value

    const mine = await signups.where({
      eventId: evt._id, openid: r.openid, status: 'signed',
    }).limit(1).get()
    const mySignup = (mine.data && mine.data[0]) || null
    if (!mySignup) {
      return ok({ found: false, eventName: evt.name, me: null })
    }

    const su = await store.loadSignups(db, evt._id)
    const rows = await loadMatchesOfEvent(evt._id)
    const me = score.computeMyPoints(rows, su.byId, mySignup._id)
    if (!me) return ok({ found: false, eventName: evt.name, me: null })

    // 逐场明细要带赛事名，组织者才看得懂「第 3 场」是哪一场。赛事不多，一次全取。
    const tours = await fetchAll(function () {
      return tournaments.where({ eventId: evt._id }).orderBy('createTime', 'asc')
    }, { label: '活动赛事' })
    const tourById = {}
    const tourSeq = {}
    for (let i = 0; i < tours.length; i++) {
      tourById[tours[i]._id] = tours[i].name
      tourSeq[tours[i]._id] = i + 1
    }

    // 没有明细的比赛照样可能有积分，一并列出来，并标明"无明细"。
    const allOfEvent = (rows || []).filter(function (m) {
      return (m.participantsA || []).indexOf(mySignup._id) >= 0 ||
        (m.participantsB || []).indexOf(mySignup._id) >= 0 ||
        (m.forfeitIds || []).indexOf(mySignup._id) >= 0
    })
    const detailByMatch = {}
    for (let i = 0; i < me.matches.length; i++) detailByMatch[me.matches[i].matchId] = me.matches[i]

    const matchRows = allOfEvent.map(function (m) {
      const detail = detailByMatch[m._id]
      const inA = (m.participantsA || []).indexOf(mySignup._id) >= 0
      return {
        matchId: m._id,
        tournamentId: m.tournamentId,
        tournamentName: tourById[m.tournamentId] || '(已删除的赛事)',
        tournamentSeq: tourSeq[m.tournamentId] || 0,
        teamName: inA
          ? 'A 方'
          : (m.participantsB || []).indexOf(mySignup._id) >= 0 ? 'B 方' : '',
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        goals: detail ? detail.goals : 0,
        assists: detail ? detail.assists : 0,
        hasPoints: score.hasPoints(m),
        forfeited: (m.forfeitIds || []).indexOf(mySignup._id) >= 0,
      }
    })

    return ok({
      found: true,
      eventName: evt.name,
      tournamentCount: tours.length,
      me: {
        signupId: me.signupId,
        name: me.name,
        goals: me.goals,
        assists: me.assists,
        total: me.total,
        matchCount: me.matchCount,
        matches: matchRows,
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
