'use strict'

/**
 * 活动管理云函数。按 action 路由。
 *
 * 云函数属管理端，不受数据库安全规则限制——这正是"核心集合设为客户端不可读写、
 * 全部经云函数"的实现方式。
 */

const cloud = require('wx-server-sdk')

// DYNAMIC_CURRENT_ENV 跟随当前函数所在环境，避免写死环境 ID 导致测试/生产串环境。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const common = require('./lib/common.js')
const roles = require('./lib/roles.js')
const store = require('./lib/store.js')

const db = cloud.database()
const events = db.collection('events')
const signups = db.collection('signups')

const ok = common.ok
const err = common.err
const trimStr = common.trimStr
const asInt = common.asInt
const fetchAll = common.fetchAll
const removeWhere = common.removeWhere

const MAX_TEAM_COUNT = 20
const MAX_CAPACITY = 500

/** 校验活动表单。create 和 update 共用，避免两边规则漂移。 */
function validateForm (d) {
  const name = trimStr(d.name)
  if (!name) return { error: err('INVALID_INPUT', '请填写活动名称') }
  if (name.length > 40) return { error: err('INVALID_INPUT', '活动名称不要超过 40 个字') }

  const teamCount = asInt(d.teamCount)
  if (teamCount === null || teamCount < 2 || teamCount > MAX_TEAM_COUNT) {
    return { error: err('INVALID_INPUT', '队伍数需要是 2 到 ' + MAX_TEAM_COUNT + ' 之间的整数') }
  }

  const capacity = asInt(d.capacity)
  if (capacity === null || capacity < teamCount || capacity > MAX_CAPACITY) {
    return {
      error: err('INVALID_INPUT',
        '人数上限需要是 ' + teamCount + ' 到 ' + MAX_CAPACITY + ' 之间的整数（不能少于队伍数）'),
    }
  }

  const startTime = asInt(d.startTime)
  if (startTime === null || startTime <= 0) {
    return { error: err('INVALID_INPUT', '请选择开始时间') }
  }
  const endTime = d.endTime == null || d.endTime === '' ? null : asInt(d.endTime)
  if (endTime !== null && endTime < startTime) {
    return { error: err('INVALID_INPUT', '结束时间不能早于开始时间') }
  }
  const signupDeadline = d.signupDeadline == null || d.signupDeadline === ''
    ? null : asInt(d.signupDeadline)
  if (signupDeadline !== null && signupDeadline > startTime) {
    return { error: err('INVALID_INPUT', '报名截止时间不能晚于活动开始时间') }
  }

  return {
    value: {
      name: name,
      location: trimStr(d.location).slice(0, 60),
      notes: trimStr(d.notes).slice(0, 500),
      teamCount: teamCount,
      capacity: capacity,
      startTime: startTime,
      endTime: endTime,
      signupDeadline: signupDeadline,
    },
  }
}

/**
 * 管理权校验。管理员和组织者可以管任意活动，创建者管自己建的活动。
 * openid 由微信在服务端注入，客户端伪造不了，所以这个判断是可信的。
 */
function requireManage (evt, r) {
  if (!roles.canManageEvent(r, evt)) {
    return err('FORBIDDEN', '只有活动创建者、组织者或管理员可以进行此操作')
  }
  return null
}

const actions = {
  async create (d, r) {
    // 一般用户只能报名，不能发起活动。
    if (!roles.canCreateEvent(r)) return err('FORBIDDEN', '只有组织者可以发起活动')

    const v = validateForm(d)
    if (v.error) return v.error

    const now = Date.now()
    const doc = Object.assign({}, v.value, {
      // 比赛分类：目前只实现 hat，联赛后续再加
      type: 'hat',
      ownerOpenid: r.openid,
      status: 'open',
      signupCount: 0,
      remaining: v.value.capacity,
      createTime: now,
      updateTime: now,
    })
    const res = await events.add({ data: doc })
    return ok({ _id: res._id })
  },

  async update (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireManage(evt, r)
    if (forbidden) return forbidden

    const v = validateForm(d)
    if (v.error) return v.error

    if (v.value.capacity < evt.signupCount) {
      return err('INVALID_INPUT',
        '已有 ' + evt.signupCount + ' 人报名，人数上限不能低于这个数')
    }
    if (evt.status === 'divided') {
      return err('INVALID_STATE', '已分队的活动不能再改设置，请先撤销分队')
    }

    // capacity 变了要同步 remaining，否则名额会算错。
    const patch = Object.assign({}, v.value, {
      remaining: v.value.capacity - evt.signupCount,
      updateTime: Date.now(),
    })
    await events.doc(evt._id).update({ data: patch })
    return ok({ _id: evt._id })
  },

  /** 活动列表。任何人可见，附带"我是否是创建者""我是否已报名"。 */
  async list (d, r) {
    const scope = d.scope === 'mine' ? 'mine' : 'all'
    const list = await fetchAll(function () {
      const q = scope === 'mine'
        ? events.where({ ownerOpenid: r.openid })
        : events
      return q.orderBy('startTime', 'desc')
    }, { label: '活动列表' })

    // 我报了哪些：按 openid 查自己的报名再取交集，比在活动列表里塞一个几百项的
    // in 条件更快，也不受 in 数组长度影响。
    const signedIds = {}
    if (list.length > 0) {
      const mine = await fetchAll(function () {
        return signups.where({ openid: r.openid, status: 'signed' }).field({ eventId: true })
      }, { label: '我的报名' })
      for (let i = 0; i < mine.length; i++) signedIds[mine[i].eventId] = true
    }

    // 权限判定是纯函数：角色已经取过一次，这里不能再逐条查库。
    const out = list.map(function (e) {
      return {
        _id: e._id,
        name: e.name,
        location: e.location,
        startTime: e.startTime,
        endTime: e.endTime,
        signupDeadline: e.signupDeadline,
        teamCount: e.teamCount,
        capacity: e.capacity,
        signupCount: e.signupCount,
        remaining: e.remaining,
        status: e.status,
        // isOwner 是"我创建的"（列表上打标签用），canManage 是"我能管"（组织者能管所有活动）。
        isOwner: e.ownerOpenid === r.openid,
        canManage: roles.canManageEvent(r, e),
        signed: !!signedIds[e._id],
      }
    })
    return ok({ list: out })
  },

  /** 活动详情。不回传其他人的报名信息——手机号只有管理身份能看到。 */
  async detail (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const canManage = roles.canManageEvent(r, evt)

    const mine = await signups.where({
      eventId: evt._id,
      openid: r.openid,
      status: 'signed',
    }).limit(1).get()
    const mySignup = (mine.data && mine.data[0]) || null

    return ok({
      event: {
        _id: evt._id,
        name: evt.name,
        location: evt.location,
        notes: evt.notes,
        startTime: evt.startTime,
        endTime: evt.endTime,
        signupDeadline: evt.signupDeadline,
        teamCount: evt.teamCount,
        capacity: evt.capacity,
        signupCount: evt.signupCount,
        remaining: evt.remaining,
        status: evt.status,
        createTime: evt.createTime,
      },
      isOwner: evt.ownerOpenid === r.openid,
      canManage: canManage,
      mySignup: mySignup ? {
        _id: mySignup._id,
        name: mySignup.name,
        gender: mySignup.gender,
        selfLevel: mySignup.selfLevel,
        phone: mySignup.phone,
        remark: mySignup.remark,
        createTime: mySignup.createTime,
      } : null,
    })
  },

  async closeSignup (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden
    if (e.value.status === 'open') {
      await events.doc(e.value._id).update({
        data: { status: 'closed', updateTime: Date.now() },
      })
    }
    return ok({ status: 'closed' })
  },

  async reopenSignup (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden
    if (e.value.status === 'divided') {
      return err('INVALID_STATE', '已分队的活动不能重开报名，请先撤销分队')
    }
    await events.doc(e.value._id).update({
      data: { status: 'open', updateTime: Date.now() },
    })
    return ok({ status: 'open' })
  },

  /** 删除活动，连带清掉报名、约束、分队、比赛记录。 */
  async remove (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden

    const id = e.value._id
    const collections = ['signups', 'constraints', 'divisions', 'matches', 'tournaments']
    for (let i = 0; i < collections.length; i++) {
      await removeWhere(db, collections[i], { eventId: id })
    }
    await events.doc(id).remove()
    return ok({ removed: true })
  },
}

exports.main = async function (event) {
  // getWXContext 只能在 main 内调用——模块加载期没有调用上下文，拿不到值。
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return err('NO_AUTH', '无法获取用户身份')

  const action = event && event.action
  const handler = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null
  if (!handler) return err('UNKNOWN_ACTION', '未知操作：' + action)

  try {
    // 角色只查一次，之后所有权限判定都是纯函数（列表页要逐条判权限）。
    const r = await roles.loadRoles(db, openid)
    return await handler(event.data || {}, r)
  } catch (e) {
    // 合并路由后日志里必须带 action 名，否则排查时分不清是哪个分支报的。
    console.error('[hat-event] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
