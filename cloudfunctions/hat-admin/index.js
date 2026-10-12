'use strict'

/**
 * 角色管理云函数。只有管理员能改角色；whoami 对所有人开放，
 * 供前端决定要不要显示管理入口（显隐而已，真正的拦截在各云函数里）。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const roles = require('./lib/roles.js')

const db = cloud.database()
const signups = db.collection('signups')
const rolesCol = db.collection('roles')

const MAX_USERS = 500

function ok (data) { return { ok: true, data: data === undefined ? null : data } }
function err (code, message, detail) {
  return { ok: false, error: { code: code, message: message, detail: detail || null } }
}

function trimStr (v) { return typeof v === 'string' ? v.trim() : '' }

function requireAdmin (openid) {
  if (!roles.isAdmin(openid)) {
    return err('FORBIDDEN', '只有管理员可以进行此操作')
  }
  return null
}

const actions = {
  /** 当前用户的身份。前端拿它决定显示哪些入口。 */
  async whoami (d, openid) {
    const admin = roles.isAdmin(openid)
    const scorer = admin ? true : await roles.isScorer(db, openid)
    return ok({ openid: openid, isAdmin: admin, isScorer: scorer })
  },

  /**
   * 所有报过名的人，按 openid 去重、取最近一次报名填的姓名。
   *
   * 管理员没法手输别人的 openid，所以直接从报名记录里把人列出来点选。
   */
  async listUsers (d, openid) {
    const forbidden = requireAdmin(openid)
    if (forbidden) return forbidden

    const all = []
    for (let skip = 0; skip < MAX_USERS * 2; skip += 100) {
      const page = await signups.orderBy('createTime', 'desc').skip(skip).limit(100).get()
      const rows = page.data || []
      for (let i = 0; i < rows.length; i++) all.push(rows[i])
      if (rows.length < 100) break
    }

    // createTime 倒序遍历，第一次见到的就是最近一次报名，名字取它。
    const byOpenid = {}
    const order = []
    for (let i = 0; i < all.length; i++) {
      const s = all[i]
      if (!s.openid || byOpenid[s.openid]) continue
      byOpenid[s.openid] = {
        openid: s.openid,
        name: s.name,
        gender: s.gender,
        lastSignupTime: s.createTime,
        signupCount: 0,
      }
      order.push(s.openid)
    }
    for (let i = 0; i < all.length; i++) {
      if (all[i].openid && byOpenid[all[i].openid]) byOpenid[all[i].openid].signupCount++
    }

    const scorerRes = await rolesCol.where({ role: roles.ROLE_SCORER }).limit(200).get()
    const scorerSet = {}
    ;(scorerRes.data || []).forEach(function (r) { scorerSet[r.openid] = true })

    const list = order.slice(0, MAX_USERS).map(function (id) {
      return Object.assign({}, byOpenid[id], {
        isScorer: !!scorerSet[id],
        isAdmin: roles.isAdmin(id),
      })
    })

    return ok({ list: list, adminCount: roles.ADMIN_OPENIDS.length })
  },

  /** 给某人加上或取消记分员身份。 */
  async setScorer (d, openid) {
    const forbidden = requireAdmin(openid)
    if (forbidden) return forbidden

    const target = trimStr(d.openid)
    if (!target) return err('INVALID_INPUT', '缺少目标用户')
    const on = d.isScorer === true || d.isScorer === 'true'

    const existing = await rolesCol.where({
      openid: target, role: roles.ROLE_SCORER,
    }).limit(1).get()
    const has = !!(existing.data && existing.data.length > 0)

    if (on && !has) {
      await rolesCol.add({
        data: {
          openid: target,
          role: roles.ROLE_SCORER,
          name: trimStr(d.name),
          createTime: Date.now(),
          createdBy: openid,
        },
      })
    } else if (!on && has) {
      await rolesCol.doc(existing.data[0]._id).remove()
    }

    return ok({ openid: target, isScorer: on })
  },

  /** 当前记分员名单。 */
  async listScorers (d, openid) {
    const forbidden = requireAdmin(openid)
    if (forbidden) return forbidden
    const res = await rolesCol.where({ role: roles.ROLE_SCORER })
      .orderBy('createTime', 'desc').limit(200).get()
    const list = (res.data || []).map(function (r) {
      return { _id: r._id, openid: r.openid, name: r.name, createTime: r.createTime }
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
    console.error('[hat-admin] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
