'use strict'

/**
 * 报名管理云函数。
 *
 * 名额上限的并发控制是这个文件的重点，见 submit。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const events = db.collection('events')
const signups = db.collection('signups')

const MIN_LEVEL = 1
const MAX_LEVEL = 5

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

function validateSignup (d) {
  const name = trimStr(d.name)
  if (!name) return { error: err('INVALID_INPUT', '请填写姓名或昵称') }
  if (name.length > 20) return { error: err('INVALID_INPUT', '姓名不要超过 20 个字') }

  const gender = d.gender === 'M' || d.gender === 'F' ? d.gender : null
  if (!gender) return { error: err('INVALID_INPUT', '请选择性别') }

  const selfLevel = asInt(d.selfLevel)
  if (selfLevel === null || selfLevel < MIN_LEVEL || selfLevel > MAX_LEVEL) {
    return { error: err('INVALID_INPUT', '请选择水平（1-5）') }
  }

  const phone = trimStr(d.phone)
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) {
    return { error: err('INVALID_INPUT', '手机号格式不对') }
  }

  return {
    value: {
      name: name,
      gender: gender,
      selfLevel: selfLevel,
      phone: phone,
      remark: trimStr(d.remark).slice(0, 200),
    },
  }
}

const actions = {
  /**
   * 提交报名。
   *
   * 防超卖用"原子占位 + 失败补偿"，不用 runTransaction：
   * 事务对象只有 doc.get/update/set/remove，没有 where 也没有聚合，
   * "还剩几个名额"这类条件查询在事务内做不了；而且默认只重试 3 次，
   * 开抢瞬间大家争同一个 event 文档的锁很容易耗尽。
   * 更新指令对单条记录本身就是原子的，这里用它足够。
   */
  async submit (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const evt = e.value

    if (evt.status !== 'open') {
      return err('SIGNUP_CLOSED',
        evt.status === 'divided' ? '活动已分队，无法报名' : '报名已关闭')
    }
    if (evt.signupDeadline && Date.now() > evt.signupDeadline) {
      return err('SIGNUP_CLOSED', '报名已截止')
    }

    const v = validateSignup(d)
    if (v.error) return v.error

    // 快速路径：已报名就直接改资料，不再占名额。
    const existing = await signups.where({
      eventId: evt._id, openid: openid, status: 'signed',
    }).limit(1).get()
    if (existing.data && existing.data.length > 0) {
      await signups.doc(existing.data[0]._id).update({
        data: Object.assign({}, v.value, { updateTime: Date.now() }),
      })
      return ok({ _id: existing.data[0]._id, updated: true })
    }

    // 第一步：一条 update 同时完成"检查"和"占位"。这一步是原子的，无锁竞争。
    // remaining 和 signupCount 放在同一次 update 里，保证两者不会脱节。
    const claim = await events.where({
      _id: evt._id,
      remaining: _.gt(0),
    }).update({
      data: { remaining: _.inc(-1), signupCount: _.inc(1) },
    })
    // stats.updated === 0 说明条件没命中，即名额已满。
    if (!claim.stats || claim.stats.updated !== 1) {
      return err('EVENT_FULL', '名额已满')
    }

    // 第二步：占到位了再写明细。写失败必须把名额补偿回去，否则名额会凭空消失。
    try {
      const res = await signups.add({
        data: Object.assign({}, v.value, {
          eventId: evt._id,
          openid: openid,
          adminLevel: null,
          status: 'signed',
          createTime: Date.now(),
          updateTime: Date.now(),
        }),
      })
      return ok({ _id: res._id, updated: false })
    } catch (addError) {
      await events.doc(evt._id).update({
        data: { remaining: _.inc(1), signupCount: _.inc(-1) },
      }).catch(function (e2) {
        // 补偿也失败只能靠日志兜底，名额会少一个，需要人工核对。
        console.error('[hat-signup] 名额补偿失败 eventId=' + evt._id, e2)
      })
      throw addError
    }
  },

  /**
   * 取消报名。先删明细成功再把名额加回，顺序反了会在并发下把名额加多。
   */
  async cancel (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const evt = e.value

    if (evt.status === 'divided') {
      return err('INVALID_STATE', '活动已分队，取消报名请联系组织者')
    }

    const mine = await signups.where({
      eventId: evt._id, openid: openid, status: 'signed',
    }).limit(1).get()
    if (!mine.data || mine.data.length === 0) {
      return err('NOT_FOUND', '你还没有报名这场活动')
    }

    const removed = await signups.doc(mine.data[0]._id).remove()
    if (!removed.stats || removed.stats.removed !== 1) {
      return err('CONFLICT', '取消失败，请重试')
    }
    await events.doc(evt._id).update({
      data: { remaining: _.inc(1), signupCount: _.inc(-1) },
    })
    return ok({ cancelled: true })
  },

  async mine (d, openid) {
    const res = await signups.where({
      openid: openid, status: 'signed',
    }).orderBy('createTime', 'desc').limit(100).get()
    const list = res.data || []
    if (list.length === 0) return ok({ list: [] })

    const eventIds = list.map(function (s) { return s.eventId })
    const evts = await events.where({ _id: _.in(eventIds) }).limit(100).get()
    const byId = {}
    ;(evts.data || []).forEach(function (e) { byId[e._id] = e })

    const out = list.map(function (s) {
      const e = byId[s.eventId]
      return {
        _id: s._id,
        eventId: s.eventId,
        name: s.name,
        gender: s.gender,
        selfLevel: s.selfLevel,
        createTime: s.createTime,
        event: e ? {
          _id: e._id,
          name: e.name,
          location: e.location,
          startTime: e.startTime,
          status: e.status,
        } : null,
      }
    }).filter(function (s) { return s.event !== null })

    return ok({ list: out })
  },

  /** 全部报名名单。仅创建者可调——参与者拿不到别人的手机号。 */
  async listAll (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const forbidden = requireOwner(e.value, openid)
    if (forbidden) return forbidden

    const all = []
    // 单次出包有上限，分页取全。
    for (let skip = 0; skip < 1000; skip += 100) {
      const page = await signups.where({ eventId: e.value._id, status: 'signed' })
        .orderBy('createTime', 'asc').skip(skip).limit(100).get()
      const rows = page.data || []
      for (let i = 0; i < rows.length; i++) all.push(rows[i])
      if (rows.length < 100) break
    }

    const out = all.map(function (s) {
      return {
        _id: s._id,
        name: s.name,
        gender: s.gender,
        selfLevel: s.selfLevel,
        adminLevel: s.adminLevel == null ? null : s.adminLevel,
        // 有效水平统一在这里算，前后端不要各算一遍。
        level: s.adminLevel == null ? s.selfLevel : s.adminLevel,
        phone: s.phone || '',
        remark: s.remark || '',
        createTime: s.createTime,
      }
    })
    return ok({ list: out, count: out.length })
  },

  /** 创建者覆盖某人的水平。传 null 表示清除覆盖、回到自评值。 */
  async updateLevel (d, openid) {
    const e = await loadEvent(d.eventId)
    if (e.error) return e.error
    const forbidden = requireOwner(e.value, openid)
    if (forbidden) return forbidden

    const signupId = trimStr(d.signupId)
    if (!signupId) return err('INVALID_INPUT', '缺少报名记录 id')

    let adminLevel = null
    if (d.adminLevel !== null && d.adminLevel !== '' && d.adminLevel !== undefined) {
      adminLevel = asInt(d.adminLevel)
      if (adminLevel === null || adminLevel < MIN_LEVEL || adminLevel > MAX_LEVEL) {
        return err('INVALID_INPUT', '水平需要是 1 到 5 之间的整数')
      }
    }

    const target = await signups.doc(signupId).get().catch(function () { return null })
    if (!target || !target.data) return err('NOT_FOUND', '报名记录不存在')
    if (target.data.eventId !== e.value._id) {
      return err('FORBIDDEN', '该报名记录不属于这场活动')
    }

    await signups.doc(signupId).update({
      data: { adminLevel: adminLevel, updateTime: Date.now() },
    })
    return ok({
      _id: signupId,
      adminLevel: adminLevel,
      level: adminLevel == null ? target.data.selfLevel : adminLevel,
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
    return await handler(event.data || {}, openid)
  } catch (e) {
    console.error('[hat-signup] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
