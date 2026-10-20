'use strict'

/**
 * 角色管理云函数。
 *
 *   whoami        对所有人开放，供前端决定显示哪些入口（显隐而已，真正的拦截在各云函数里）
 *   listUsers     管理员和组织者都可以看名单（要给人指派组织者得先在名单里找到他）
 *   setOrganizer  增删组织者，只有管理员
 *   transferAdmin 移交管理员身份，只有管理员
 *   listOrganizers 当前组织者名单
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const common = require('./lib/common.js')
const roles = require('./lib/roles.js')

const db = cloud.database()
const signups = db.collection('signups')
const rolesCol = db.collection('roles')

const ok = common.ok
const err = common.err
const trimStr = common.trimStr
const fetchAll = common.fetchAll
const removeWhere = common.removeWhere

const MAX_USERS = 500

/** 谁能看名单：管理员和组织者。 */
function requireAdminOrOrganizer (r) {
  if (!r.isAdmin && !r.isOrganizer) {
    return err('FORBIDDEN', '只有管理员或组织者可以进行此操作')
  }
  return null
}

/** 谁能改角色：只有管理员。 */
function requireAdmin (r) {
  if (!roles.canManageRoles(r)) return err('FORBIDDEN', '只有管理员可以进行此操作')
  return null
}

/**
 * 管理员记录（含姓名）。库里一条都没有时回落到云函数里写死的初始管理员
 * —— 那批人没有 name 字段，界面上会显示成"未报名过"或取其报名记录的姓名。
 */
async function adminRows () {
  const res = await rolesCol.where({ role: roles.ROLE_ADMIN })
    .limit(roles.MAX_ROLE_DOCS).get()
  const rows = (res.data || [])
    .map(function (x) { return { openid: x.openid, name: x.name || '' } })
    .filter(function (x) { return !!x.openid })
  if (rows.length > 0) return rows
  return roles.ADMIN_OPENIDS.map(function (id) { return { openid: id, name: '' } })
}

/** 当前管理员 openid 名单（数据库里的，没有就回落到初始管理员）。 */
async function currentAdminOpenids () {
  return (await adminRows()).map(function (x) { return x.openid })
}

/**
 * 现有组织者记录，按 openid 去重。
 *
 * 合并前的老角色名（scorer）也一并读出来：升级之后老数据还在库里，界面上不认它
 * 就会出现"whoami 说是组织者、名单里却找不到人"这种自相矛盾。
 */
async function organizerRows () {
  const rows = []
  const seen = {}
  const names = [roles.ROLE_ORGANIZER, roles.LEGACY_ROLE_SCORER]
  for (let i = 0; i < names.length; i++) {
    const res = await rolesCol.where({ role: names[i] })
      .orderBy('createTime', 'desc').limit(MAX_USERS).get()
    ;(res.data || []).forEach(function (x) {
      if (!x.openid || seen[x.openid]) return
      seen[x.openid] = true
      rows.push(x)
    })
  }
  return rows
}

/** 目标必须是真实报过名的人：测试数据和导入名单没有微信账号，设了身份也登不进来。 */
async function findRealUser (openid) {
  const res = await signups.where({ openid: openid }).limit(5).get()
  const rows = res.data || []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].isTest || rows[i].isImported) continue
    return rows[i]
  }
  return null
}

const actions = {
  /** 当前用户的身份。前端拿它决定显示哪些入口。 */
  async whoami (d, r) {
    return ok({
      openid: r.openid,
      isAdmin: r.isAdmin,
      isOrganizer: r.isOrganizer,
      // 一般用户不能发起活动，前端据此决定要不要显示"创建活动"
      canCreateEvent: roles.canCreateEvent(r),
    })
  },

  /**
   * 所有报过名的人，按 openid 去重、取最近一次报名填的姓名。
   *
   * 管理员没法手输别人的 openid，所以直接从报名记录里把人列出来点选。
   */
  async listUsers (d, r) {
    const forbidden = requireAdminOrOrganizer(r)
    if (forbidden) return forbidden

    const all = await fetchAll(function () {
      return signups.orderBy('createTime', 'desc')
    }, { label: '报名记录' })

    // createTime 倒序遍历，第一次见到的就是最近一次报名，名字取它。
    const byOpenid = {}
    const order = []
    for (let i = 0; i < all.length; i++) {
      const s = all[i]
      // 测试数据和导入名单都没有真实微信账号，不能被设成组织者或管理员
      if (s.isTest || s.isImported) continue
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

    const orgSet = {}
    const orgName = {}
    ;(await organizerRows()).forEach(function (x) {
      orgSet[x.openid] = true
      if (x.name) orgName[x.openid] = x.name
    })

    const adminIds = await currentAdminOpenids()
    const adminSet = {}
    const adminName = {}
    adminIds.forEach(function (id) { adminSet[id] = true })
    ;(await adminRows()).forEach(function (x) {
      if (x.name) adminName[x.openid] = x.name
    })

    /**
     * 只有角色、没有任何报名记录的人也要列出来。
     *
     * 这是 v1.0.2 修的问题：报名记录是这份名单的**唯一来源**，所以把某个组织者的报名
     * 删掉之后，他的角色记录还在、权限照常生效，但后台列表里再也看不到他——
     * 既没法发现，也没法撤销，成了一个看不见的权限。
     */
    const roleOnly = []
    function addRoleOnly (openid, name) {
      if (!openid || byOpenid[openid]) return
      if (roleOnly.some(function (x) { return x.openid === openid })) return
      roleOnly.push({
        openid: openid,
        name: name || '(未报名过)',
        gender: '',
        lastSignupTime: null,
        signupCount: 0,
        noSignup: true,
      })
    }
    Object.keys(orgSet).forEach(function (id) { addRoleOnly(id, orgName[id]) })
    adminIds.forEach(function (id) { addRoleOnly(id, adminName[id]) })

    function decorate (u) {
      return Object.assign({}, u, {
        isOrganizer: !!orgSet[u.openid],
        isAdmin: !!adminSet[u.openid],
        noSignup: !!u.noSignup,
      })
    }

    const list = order.slice(0, MAX_USERS).map(function (id) {
      return decorate(byOpenid[id])
    })
    // 没有报名记录的角色持有者排在最后：正常名单保持按报名时间排序，
    // 这类人是异常情况，靠「无报名」标签 + 排在最末引起注意，不去打扰常用列表。
    const tail = roleOnly.slice(0, Math.max(0, MAX_USERS - list.length)).map(decorate)

    return ok({
      list: list.concat(tail),
      adminOpenids: adminIds,
      canEditRoles: roles.canManageRoles(r),
      myOpenid: r.openid,
    })
  },

  /** 给某人加上或取消组织者身份。只有管理员可以改。 */
  async setOrganizer (d, r) {
    const forbidden = requireAdmin(r)
    if (forbidden) return forbidden

    const target = trimStr(d.openid)
    if (!target) return err('INVALID_INPUT', '缺少目标用户')

    const admins = await currentAdminOpenids()
    if (admins.indexOf(target) >= 0) {
      return err('INVALID_INPUT', '管理员本来就有组织者的全部权限，不用再设一次')
    }

    const on = d.isOrganizer === true || d.isOrganizer === 'true'
    const existing = await rolesCol.where({
      openid: target, role: roles.ROLE_ORGANIZER,
    }).limit(1).get()
    const has = !!(existing.data && existing.data.length > 0)

    if (on && !has) {
      await rolesCol.add({
        data: {
          openid: target,
          role: roles.ROLE_ORGANIZER,
          name: trimStr(d.name),
          createTime: Date.now(),
          createdBy: r.openid,
        },
      })
    } else if (!on && has) {
      await rolesCol.doc(existing.data[0]._id).remove()
    }
    // 老数据里那条 scorer 记录一并清掉，否则"取消"看起来没生效。
    if (!on) {
      await removeWhere(db, 'roles', { openid: target, role: roles.LEGACY_ROLE_SCORER })
    }

    return ok({ openid: target, isOrganizer: on })
  },

  /**
   * 移交管理员身份。
   *
   * 顺序是**先加新的、再删旧的**：反过来的话，一旦写入失败库里就一个管理员都没有了。
   * 管理员名单存在 roles 集合里；云函数里那份写死的初始名单只在库里完全没有
   * role=admin 记录时才生效，所以这一步是真正的转移，而不是把权限再复制一份。
   */
  async transferAdmin (d, r) {
    const forbidden = requireAdmin(r)
    if (forbidden) return forbidden

    const target = trimStr(d.openid)
    if (!target) return err('INVALID_INPUT', '缺少目标用户')
    if (target === r.openid) return err('INVALID_INPUT', '你已经是管理员了')

    const user = await findRealUser(target)
    if (!user) {
      return err('NOT_FOUND', '找不到这个用户。请让对方先报名一次活动，再移交。')
    }

    const now = Date.now()
    await rolesCol.add({
      data: {
        openid: target,
        role: roles.ROLE_ADMIN,
        name: user.name,
        createTime: now,
        createdBy: r.openid,
      },
    })

    const existing = await rolesCol.where({ role: roles.ROLE_ADMIN })
      .limit(roles.MAX_ROLE_DOCS).get()
    for (let i = 0; i < (existing.data || []).length; i++) {
      const row = existing.data[i]
      if (row.openid === target) continue
      await rolesCol.doc(row._id).remove()
    }

    return ok({ openid: target, name: user.name })
  },

  /** 当前组织者名单。 */
  async listOrganizers (d, r) {
    const forbidden = requireAdminOrOrganizer(r)
    if (forbidden) return forbidden

    const list = (await organizerRows()).map(function (x) {
      return { _id: x._id, openid: x.openid, name: x.name, createTime: x.createTime }
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
    console.error('[hat-admin] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
