'use strict'

/**
 * 赛事、约束与分队云函数。
 *
 * 层级：活动(event) → 赛事(tournament) → 分队(division) → 比赛(match)
 * 报名在活动层，所以 signupId 是活动内的人员主键；赛事各自记录「赛前检录名单」，
 * 分队只从当次检录的人里抽。
 *
 * 分队算法在小程序端跑，这里只负责校验和持久化。校验不能省：
 *  - 名单必须与该赛事的赛前检录名单完全一致，防止客户端塞进不存在的人或漏人；
 *  - 统计一律服务端按报名记录重算，不采信客户端传来的数字。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const common = require('./lib/common.js')
const roles = require('./lib/roles.js')
const store = require('./lib/store.js')

const db = cloud.database()
const constraints = db.collection('constraints')
const divisions = db.collection('divisions')
const tournaments = db.collection('tournaments')
const matchesCol = db.collection('matches')

const ok = common.ok
const err = common.err
const trimStr = common.trimStr
const asInt = common.asInt
const removeWhere = common.removeWhere

// 与 miniprogram/utils/divide.js 的 STAR_LEVEL 必须一致：这里是"高分球员"的界线，
// 客户端拿它分队、这里拿它重算队伍统计，两边不一致就会出现"分队时按 5 分算、
// 展示时说 4 分算高分"的怪数字。tests/check-pages.js 会断言两者相同。
const STAR_LEVEL = 5
const MAX_CONSTRAINTS = 200
const MAX_TOURNAMENTS = 50
const MIN_TEAMS = 2
const MAX_TEAMS = 20

/**
 * 队内名单的展示顺序：按姓名。**不能按水平排**——分队结果是发布给所有人看的，
 * 按水平从高到低排等于把组织者对每个人的评级直接念出来。
 */
function compareName (a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
}

/** 管理权校验。管理员和组织者可以管任意活动，创建者管自己建的活动。 */
function requireManage (evt, r) {
  if (!roles.canManageEvent(r, evt)) {
    return err('FORBIDDEN', '只有活动创建者、组织者或管理员可以进行此操作')
  }
  return null
}

async function countMatchesOf (tournamentId) {
  const res = await matchesCol.where({ tournamentId: tournamentId }).count()
  return res.total
}

/**
 * 按身份裁掉水平信息。
 *
 * 必须在云函数出口剥离，不能只靠前端不渲染——数据照样发到了客户端，
 * 在调试工具里一看就有。
 */
function stripLevel (member) {
  return { _id: member._id, name: member.name, gender: member.gender }
}

function stripTeamStats (stats) {
  // 人数和男女比例是公开信息，水平相关的一律拿掉。
  return { count: stats.count, male: stats.male, female: stats.female }
}

/** 校验赛前检录名单：必须是该活动报名记录的子集，去重，且够分队。 */
function pickAttendees (raw, signupsById, teamCount) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const id = trimStr(list[i])
    if (!id) continue
    if (!signupsById[id]) {
      return { error: err('UNKNOWN_PLAYER', '赛前检录名单里有不属于这场活动的人：' + id, { id: id }) }
    }
    if (out.indexOf(id) < 0) out.push(id)
  }
  if (out.length < teamCount) {
    return {
      error: err('NOT_ENOUGH_ATTENDEES',
        '赛前检录 ' + out.length + ' 人，少于 ' + teamCount + ' 个队，无法分队'),
    }
  }
  return { value: out }
}

const actions = {
  // ---------------------------------------------------------------- 赛事

  async createTournament (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireManage(evt, r)
    if (forbidden) return forbidden

    const name = trimStr(d.name)
    if (!name) return err('INVALID_INPUT', '请填写赛事名称')
    if (name.length > 30) return err('INVALID_INPUT', '赛事名称不要超过 30 个字')

    const teamCount = asInt(d.teamCount)
    if (teamCount === null || teamCount < MIN_TEAMS || teamCount > MAX_TEAMS) {
      return err('INVALID_INPUT', '队伍数需要是 ' + MIN_TEAMS + ' 到 ' + MAX_TEAMS + ' 之间的整数')
    }

    const su = await store.loadSignups(db, evt._id)
    const att = pickAttendees(d.attendeeIds, su.byId, teamCount)
    if (att.error) return att.error

    const existing = await tournaments.where({ eventId: evt._id }).count()
    if (existing.total >= MAX_TOURNAMENTS) {
      return err('TOO_MANY', '一个活动最多 ' + MAX_TOURNAMENTS + ' 场赛事')
    }

    const now = Date.now()
    const res = await tournaments.add({
      data: {
        eventId: evt._id,
        name: name,
        teamCount: teamCount,
        attendeeIds: att.value,
        status: 'draft',
        createTime: now,
        updateTime: now,
        createdBy: r.openid,
      },
    })
    return ok({ _id: res._id })
  },

  async updateTournament (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const forbidden = requireManage(t.value.evt, r)
    if (forbidden) return forbidden
    const tour = t.value.tournament

    const name = trimStr(d.name)
    if (!name) return err('INVALID_INPUT', '请填写赛事名称')
    const teamCount = asInt(d.teamCount)
    if (teamCount === null || teamCount < MIN_TEAMS || teamCount > MAX_TEAMS) {
      return err('INVALID_INPUT', '队伍数需要是 ' + MIN_TEAMS + ' 到 ' + MAX_TEAMS + ' 之间的整数')
    }

    const su = await store.loadSignups(db, tour.eventId)
    const att = pickAttendees(d.attendeeIds, su.byId, teamCount)
    if (att.error) return att.error

    // 已录比赛就不能再动赛前检录名单和队伍数——比赛记录引用的是队员 id 和队伍序号。
    const played = await countMatchesOf(tour._id)
    if (played > 0) {
      const sameTeams = teamCount === tour.teamCount
      const sameAtt = att.value.length === (tour.attendeeIds || []).length &&
        att.value.every(function (id) { return (tour.attendeeIds || []).indexOf(id) >= 0 })
      if (!sameTeams || !sameAtt) {
        return err('MATCHES_EXIST',
          '这场赛事已经记录了 ' + played + ' 场比赛，不能再改赛前检录名单或队伍数。' +
          '如果确实要改，请先删掉这场赛事的比赛记录。',
          { matchCount: played })
      }
    }

    await tournaments.doc(tour._id).update({
      data: {
        name: name,
        teamCount: teamCount,
        attendeeIds: att.value,
        updateTime: Date.now(),
      },
    })
    return ok({ _id: tour._id })
  },

  async listTournaments (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const isOrganizer = roles.canManageEvent(r, evt)
    // 群内可见的活动，赛事列表同样不能对外人开放
    const noView = await store.requireEventView(db, evt, r)
    if (noView) return noView

    const res = await tournaments.where({ eventId: evt._id })
      .orderBy('createTime', 'asc').limit(MAX_TOURNAMENTS).get()
    const rows = res.data || []

    const list = []
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i]
      const pub = await divisions.where({ tournamentId: t._id, published: true })
        .limit(1).count()
      const played = await countMatchesOf(t._id)
      list.push({
        _id: t._id,
        name: t.name,
        teamCount: t.teamCount,
        attendeeCount: (t.attendeeIds || []).length,
        published: pub.total > 0,
        matchCount: played,
        createTime: t.createTime,
      })
    }

    return ok({ isOrganizer: isOrganizer, eventName: evt.name, list: list })
  },

  /** 赛事详情。赛前检录名单带水平只给管理身份——参与者看不到任何人的水平。 */
  async getTournament (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const tour = t.value.tournament
    const evt = t.value.evt
    const isOrganizer = roles.canManageEvent(r, evt)
    const seeLevel = isOrganizer
    const noView = await store.requireEventView(db, evt, r)
    if (noView) return noView

    const su = await store.loadSignups(db, tour.eventId)
    const attendees = (tour.attendeeIds || []).map(function (id) {
      const p = su.byId[id] || { _id: id, name: '(已退出)', gender: 'U', level: 0 }
      return seeLevel ? p : stripLevel(p)
    })
    const played = await countMatchesOf(tour._id)

    return ok({
      isOrganizer: isOrganizer,
      eventId: tour.eventId,
      eventName: evt.name,
      tournament: {
        _id: tour._id,
        name: tour.name,
        teamCount: tour.teamCount,
        attendeeIds: tour.attendeeIds || [],
        status: tour.status,
        createTime: tour.createTime,
      },
      attendees: attendees,
      matchCount: played,
    })
  },

  /** 删赛事，连带清掉它的分队和比赛记录。 */
  async removeTournament (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const forbidden = requireManage(t.value.evt, r)
    if (forbidden) return forbidden
    const tour = t.value.tournament

    await removeWhere(db, 'matches', { tournamentId: tour._id })
    await removeWhere(db, 'divisions', { tournamentId: tour._id })
    await tournaments.doc(tour._id).remove()
    return ok({ removed: true })
  },

  // ---------------------------------------------------------------- 约束

  /**
   * 覆盖式写入约束。约束挂在**活动**层：「这两个人别同队」对该活动的每场赛事都适用，
   * 不需要每开一场赛事重设一遍。
   */
  async setConstraints (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden

    const raw = Array.isArray(d.constraints) ? d.constraints : []
    if (raw.length > MAX_CONSTRAINTS) {
      return err('INVALID_INPUT', '约束不要超过 ' + MAX_CONSTRAINTS + ' 条')
    }

    const su = await store.loadSignups(db, e.value._id)
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

    await removeWhere(db, 'constraints', { eventId: e.value._id })
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

  async listConstraints (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden

    const res = await constraints.where({ eventId: e.value._id })
      .orderBy('createTime', 'asc').limit(MAX_CONSTRAINTS).get()
    const list = (res.data || []).map(function (c) {
      return { _id: c._id, type: c.type, signupIds: c.signupIds }
    })
    return ok({ list: list })
  },

  // ---------------------------------------------------------------- 分队

  /**
   * 保存一次分队结果，每次存一个新版本（可对比、可回滚）。
   * 手动换人也走这里——客户端改完整个名单再提交，不另开一条改动路径。
   */
  async saveDivision (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const forbidden = requireManage(t.value.evt, r)
    if (forbidden) return forbidden
    const tour = t.value.tournament

    const teamsIn = Array.isArray(d.teams) ? d.teams : []
    if (teamsIn.length < 1) return err('INVALID_INPUT', '没有队伍数据')

    // 已经录了比赛就不能再改分队：比赛记录引用的是队伍序号和队员 id，
    // 重新分队会让这些引用全部失效，产生"某人的积分属于一支不存在的队"这种
    // 说不清的状态。宁可让组织者多一步，也不要留下对不上的数据。
    const played = await countMatchesOf(tour._id)
    if (played > 0) {
      return err('MATCHES_EXIST',
        '这场赛事已经记录了 ' + played + ' 场比赛，不能再重新分队。' +
        '如果确实要重分，请先删掉这场赛事的比赛记录。',
        { matchCount: played })
    }

    const su = await store.loadSignups(db, tour.eventId)
    // 名单基准是这场赛事的**赛前检录名单**，不是活动的全部报名。
    const expected = (tour.attendeeIds || []).slice()

    const seen = {}
    const teams = []
    for (let i = 0; i < teamsIn.length; i++) {
      const ti = teamsIn[i] || {}
      const ids = Array.isArray(ti.memberIds) ? ti.memberIds : []
      const members = []
      let count = 0; let male = 0; let female = 0
      let star = 0; let levelSum = 0
      for (let j = 0; j < ids.length; j++) {
        const id = trimStr(ids[j])
        if (expected.indexOf(id) < 0) {
          const p = su.byId[id]
          return err('UNKNOWN_PLAYER',
            '分队名单里有不在本场赛前检录名单中的人：' + (p ? p.name : id), { id: id })
        }
        if (seen[id]) {
          return err('INVALID_INPUT', su.byId[id].name + ' 被分到了多个队', { id: id })
        }
        seen[id] = true
        const p = su.byId[id]
        members.push(id)
        count++
        if (p.gender === 'M') male++
        else if (p.gender === 'F') female++
        if (p.level >= STAR_LEVEL) star++
        levelSum += p.level
      }
      teams.push({
        index: i,
        name: trimStr(ti.name) || (i + 1) + '队',
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
      const names = missing.slice(0, 5).map(function (id) {
        return su.byId[id] ? su.byId[id].name : id
      })
      return err('INCOMPLETE_DIVISION',
        '有 ' + missing.length + ' 人没有被分到队：' + names.join('、') +
        (missing.length > 5 ? ' 等' : ''),
        { missing: missing })
    }

    const last = await divisions.where({ tournamentId: tour._id })
      .orderBy('version', 'desc').limit(1).get()
    const version = last.data && last.data[0] ? last.data[0].version + 1 : 1

    const res = await divisions.add({
      data: {
        tournamentId: tour._id,
        eventId: tour.eventId,
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
   * 读取分队结果。管理身份看最新版本；参与者只能看已发布的版本，
   * 否则会在组织者还在调整时就看到中间状态。水平按身份剥离。
   */
  async getDivision (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const tour = t.value.tournament
    const evt = t.value.evt
    const isOrganizer = roles.canManageEvent(r, evt)
    const seeLevel = isOrganizer
    const noView = await store.requireEventView(db, evt, r)
    if (noView) return noView

    let query = divisions.where({ tournamentId: tour._id })
    if (!isOrganizer) query = divisions.where({ tournamentId: tour._id, published: true })

    const res = await query.orderBy('version', 'desc').limit(1).get()
    const div = res.data && res.data[0]
    if (!div) {
      return ok({ division: null, isOwner: isOrganizer, isOrganizer: isOrganizer })
    }

    const su = await store.loadSignups(db, tour.eventId)
    const teams = (div.teams || []).map(function (team) {
      const members = (team.memberIds || []).map(function (id) {
        // 报名记录被删掉的情况下给个占位，避免整页渲染不出来。
        return su.byId[id] || { _id: id, name: '(已退出)', gender: 'U', level: 0 }
      })
      members.sort(compareName)
      return {
        index: team.index,
        name: team.name,
        stats: seeLevel ? team.stats : stripTeamStats(team.stats),
        members: seeLevel ? members : members.map(stripLevel),
      }
    })

    return ok({
      isOwner: isOrganizer,
      isOrganizer: isOrganizer,
      canSeeLevel: seeLevel,
      tournamentName: tour.name,
      eventId: tour.eventId,
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

  async publish (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const forbidden = requireManage(t.value.evt, r)
    if (forbidden) return forbidden
    const tour = t.value.tournament

    const divisionId = trimStr(d.divisionId)
    if (!divisionId) return err('INVALID_INPUT', '缺少分队记录 id')
    const target = await divisions.doc(divisionId).get().catch(function () { return null })
    if (!target || !target.data) return err('NOT_FOUND', '分队记录不存在')
    if (target.data.tournamentId !== tour._id) {
      return err('FORBIDDEN', '该分队记录不属于这场赛事')
    }

    // 同一赛事只保留一个已发布版本，避免参与者读到两个"最新"。
    const others = await divisions.where({
      tournamentId: tour._id, published: true,
    }).limit(100).get()
    for (let i = 0; i < (others.data || []).length; i++) {
      if (others.data[i]._id === divisionId) continue
      await divisions.doc(others.data[i]._id).update({ data: { published: false } })
    }

    await divisions.doc(divisionId).update({ data: { published: true } })
    await tournaments.doc(tour._id).update({
      data: { status: 'divided', updateTime: Date.now() },
    })
    return ok({ published: true })
  },

  async unpublish (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const forbidden = requireManage(t.value.evt, r)
    if (forbidden) return forbidden
    const tour = t.value.tournament

    const all = await divisions.where({
      tournamentId: tour._id, published: true,
    }).limit(100).get()
    for (let i = 0; i < (all.data || []).length; i++) {
      await divisions.doc(all.data[i]._id).update({ data: { published: false } })
    }
    await tournaments.doc(tour._id).update({
      data: { status: 'draft', updateTime: Date.now() },
    })
    return ok({ published: false })
  },

  async listDivisions (d, r) {
    const t = await store.loadTournament(db, d.tournamentId)
    if (t.error) return t.error
    const forbidden = requireManage(t.value.evt, r)
    if (forbidden) return forbidden

    const res = await divisions.where({ tournamentId: t.value.tournament._id })
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
    // 角色只查一次，之后所有权限判定都是纯函数。
    const r = await roles.loadRoles(db, openid)
    return await handler(event.data || {}, r)
  } catch (e) {
    console.error('[hat-team] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
