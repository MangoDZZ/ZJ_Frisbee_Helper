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
const eventConfig = require('./lib/event-config.js')

const db = cloud.database()
const events = db.collection('events')
const signups = db.collection('signups')
const _ = db.command

const ok = common.ok
const err = common.err
const ensureEnvelope = common.ensureEnvelope
const trimStr = common.trimStr
const asInt = common.asInt
const fetchAll = common.fetchAll
const removeWhere = common.removeWhere

const MAX_TEAM_COUNT = 20
const MAX_CAPACITY = 500

/**
 * 「仅限群聊转发可见」的分享口令长度。
 *
 * 它不是密码，只是一个够长到猜不中的随机串：活动的 id 是可以被枚举猜到的
 * （群成员、日志、分享记录里都可能出现），所以入口靠这个随机串而不是 id。
 */
const SHARE_TOKEN_LEN = 20

/** 记录谁通过分享链接进来过。一个人只留一条，上限远大于活动人数就够了。 */
const MAX_VISITORS = 500

function makeShareToken () {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < SHARE_TOKEN_LEN; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return out
}

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
      // 报名表要采集哪些字段、哪些必填。老活动没有这个字段，normalize 会给出默认值，
      // 而默认值就等于原来硬编码的行为（手机号选填，其余不采集）。
      signupFields: eventConfig.normalizeSignupFields(d.signupFields),
      visibility: d.visibility === eventConfig.VISIBILITY_GROUP
        ? eventConfig.VISIBILITY_GROUP
        : eventConfig.VISIBILITY_PUBLIC,
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

/**
 * 记录"这个人通过分享链接进来过"，之后他在列表里就能看到这场活动。
 *
 * 用 addToSet 而不是读出来再写回去：并发进来两个人时后者不会把前者覆盖掉。
 * 也刻意不 await 失败——记不上只是下次还得从群链接进来，不该让详情页打不开。
 */
function noteVisitor (eventId, openid, evt) {
  if (!openid) return Promise.resolve()
  const visitors = Array.isArray(evt.visitors) ? evt.visitors : []
  if (visitors.indexOf(openid) >= 0) return Promise.resolve()
  if (visitors.length >= MAX_VISITORS) return Promise.resolve()
  return events.doc(eventId).update({ data: { visitors: _.addToSet(openid) } })
    .catch(function () {})
}

const actions = {
  async create (d, r) {
    // 一般用户只能报名，不能发起活动。
    if (!roles.canCreateEvent(r)) return err('FORBIDDEN', '只有组织者可以发起活动')

    // 活动类型只在创建时确定，之后不可改：它决定了"只能有一个赛事"这类结构约束，
    // 中途改会把已录入的赛事/比赛记录留在说不清的状态里（update 里根本不含 type）。
    const type = d.type === undefined || d.type === null || d.type === ''
      ? eventConfig.TYPE_PERSONAL
      : String(d.type)
    if (!eventConfig.TYPES[type]) {
      return err('INVALID_INPUT', '未知的活动类型：' + type)
    }

    const v = validateForm(d)
    if (v.error) return v.error

    const now = Date.now()
    const doc = Object.assign({}, v.value, {
      type: type,
      ownerOpenid: r.openid,
      status: 'open',
      signupCount: 0,
      remaining: v.value.capacity,
      // 分享口令只对「仅限群聊转发可见」的活动有意义，但一律生成：
      // 组织者事后把公开活动改成群内可见时，链接不会突然变。
      shareToken: makeShareToken(),
      visitors: [],
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
    // 注：这里原来还有一道「已分队就不能改设置」的判断，但它靠 evt.status === 'divided'，
    // 而活动状态只会是 open/closed（"已分队"是赛事级的，见 tournaments.status），
    // 永远不成立。真正需要拦的"改了会让已有数据对不上"的情况，在各赛事那边按具体操作拦
    // （比如已录比赛就不能改检录名单）。改活动自身的设置不会让任何引用失效。

    // capacity 变了要同步 remaining，否则名额会算错。
    const patch = Object.assign({}, v.value, {
      remaining: v.value.capacity - evt.signupCount,
      updateTime: Date.now(),
    })
    // 部署窗口期内线上还可能是旧版前端，它不知道这两个字段，提交时根本不会带上。
    // 那就保持原值——否则组织者只是改个名字，精心配好的报名表就被重置成默认了。
    if (d.signupFields === undefined) patch.signupFields = evt.signupFields
    if (d.visibility === undefined) patch.visibility = eventConfig.visibilityOf(evt)
    // 老活动没有 shareToken，第一次被改成"群内可见"时补一个。
    if (!trimStr(evt.shareToken)) patch.shareToken = makeShareToken()
    await events.doc(evt._id).update({ data: patch })
    return ok({ _id: evt._id })
  },

  /** 活动列表。公开活动人人可见，群内可见的只对"能看到的人"出现。 */
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
    const out = []
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      // 「仅限群聊转发可见」的活动不能出现在公开列表里，否则等于没设。
      if (!roles.canViewEvent(r, e, { hasSignup: !!signedIds[e._id] })) continue
      out.push({
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
        type: eventConfig.typeOf(e),
        typeLabel: eventConfig.typeLabel(e),
        groupOnly: eventConfig.visibilityOf(e) === eventConfig.VISIBILITY_GROUP,
        // isOwner 是"我创建的"（列表上打标签用），canManage 是"我能管"（组织者能管所有活动）。
        isOwner: e.ownerOpenid === r.openid,
        canManage: roles.canManageEvent(r, e),
        signed: !!signedIds[e._id],
      })
    }
    return ok({ list: out })
  },

  /**
   * 活动详情。不回传其他人的报名信息——手机号只有管理身份能看到。
   *
   * 「仅限群聊转发可见」的活动要凭分享口令进：口令对得上就记一笔 visitor，
   * 之后这个人再看列表就能看到它（见 roles.canViewEvent）。
   */
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

    const visible = roles.canViewEvent(r, evt, { hasSignup: !!mySignup })
    if (!visible) {
      const token = trimStr(d.t)
      if (!token || token !== trimStr(evt.shareToken)) {
        return err('FORBIDDEN', '这个活动仅限群内成员查看，请从群里的分享链接进入')
      }
      // 口令对得上：记一笔，之后他在活动列表里也能看到这场活动
      noteVisitor(evt._id, r.openid, evt)
    }

    const fields = eventConfig.normalizeSignupFields(evt.signupFields)
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
        type: eventConfig.typeOf(evt),
        typeLabel: eventConfig.typeLabel(evt),
        groupOnly: eventConfig.visibilityOf(evt) === eventConfig.VISIBILITY_GROUP,
        // 报名表的字段配置要给报名页用；它不是秘密，公开活动的报名表本来就人人可见
        signupFields: fields,
        createTime: evt.createTime,
      },
      // 分享口令只给"已经能看到这场活动"的人，好让他继续把链接转到别的群/人
      shareToken: eventConfig.visibilityOf(evt) === eventConfig.VISIBILITY_GROUP
        ? trimStr(evt.shareToken) : '',
      isOwner: evt.ownerOpenid === r.openid,
      canManage: canManage,
      mySignup: mySignup ? {
        _id: mySignup._id,
        name: mySignup.name,
        gender: mySignup.gender,
        selfLevel: mySignup.selfLevel,
        phone: mySignup.phone || '',
        age: mySignup.age === undefined ? '' : mySignup.age,
        className: mySignup.className || '',
        studentId: mySignup.studentId || '',
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
    // 重开报名只是让新人能报名；已经在各赛事检录/分队里的人不受影响，所以不拦。
    // （原来这里靠 evt.status === 'divided' 拦，但那个值永远不成立，见 update 里的说明。）
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
    const collections = [
      'signups', 'constraints', 'divisions', 'matches', 'tournaments',
      // 随机事件的定义和触发记录也挂在活动上，一并清掉
      'randomEvents', 'randomDraws',
    ]
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
    return ensureEnvelope(await handler(event.data || {}, r), action)
  } catch (e) {
    // 合并路由后日志里必须带 action 名，否则排查时分不清是哪个分支报的。
    console.error('[hat-event] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
