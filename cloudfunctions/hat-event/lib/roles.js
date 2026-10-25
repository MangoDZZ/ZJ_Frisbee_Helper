'use strict'

/**
 * 角色与权限判定。**唯一源头是本文件**，各云函数 lib/ 下的副本由
 * `node scripts/sync-shared.js` 生成，不要直接改副本——测试会检查副本与源头是否一致。
 *
 * 权限一律在云函数里判，绝不能依赖客户端：miniprogram 是前端代码，改一行就能冒充任何
 * 身份，那里的角色信息只用来控制按钮显隐。
 *
 * 三种身份：
 *   参与者  默认。报名、看积分榜和战绩，不能发起活动
 *   组织者  roles 集合里的记录。可以发起活动，并管理**任意**活动的报名、分队、战绩与积分
 *   管理员  存在 roles 集合里（同一时间只有一个）。组织者的全部权限，外加增删组织者、
 *           移交管理员身份
 */

/**
 * 初始管理员。
 *
 * 只在数据库里**还没有**任何 role=admin 记录时生效：新环境要靠它进后台，
 * 而「移交管理员身份」一旦写入新管理员记录，这份名单就自动失效——否则权限根本交不出去。
 */
const ADMIN_OPENIDS = [
  'oKkBt3SP024_uuaA3MUik9oP43h8',
]

const ROLE_ADMIN = 'admin'
const ROLE_ORGANIZER = 'organizer'

/** 合并前"记分员"用的角色名。老数据里还有，按组织者对待，免得升级后凭空掉权限。 */
const LEGACY_ROLE_SCORER = 'scorer'

/** 一个人的角色记录不会多，用来给查询兜个上限。 */
const MAX_ROLE_DOCS = 20

/**
 * 取一次调用者的角色。之后的判定全部是纯函数。
 *
 * 列表页要逐条判权限（"这个活动我能不能管"），每条都查库会变成 N 次串行往返，
 * 所以角色只查一次，后面全部在内存里算。
 */
async function loadRoles (db, openid) {
  if (!openid) return { openid: '', isAdmin: false, isOrganizer: false }
  const rolesCol = db.collection('roles')

  const mineRes = await rolesCol.where({ openid: openid }).limit(MAX_ROLE_DOCS).get()
  const mine = mineRes.data || []

  const adminRes = await rolesCol.where({ role: ROLE_ADMIN }).limit(MAX_ROLE_DOCS).get()
  const admins = (adminRes.data || [])
    .map(function (r) { return r.openid })
    .filter(Boolean)

  return {
    openid: openid,
    isAdmin: (admins.length > 0 ? admins : ADMIN_OPENIDS).indexOf(openid) >= 0,
    isOrganizer: mine.some(function (r) {
      return r.role === ROLE_ORGANIZER || r.role === LEGACY_ROLE_SCORER
    }),
  }
}

/** 谁能发起活动：组织者和管理员。一般用户只能报名。 */
function canCreateEvent (r) {
  return !!r && (r.isAdmin || r.isOrganizer)
}

/** 谁能增删组织者、移交管理员：只有管理员。 */
function canManageRoles (r) {
  return !!r && r.isAdmin
}

/**
 * 谁能管这场活动：管理员、组织者，以及活动的创建者。
 *
 * 创建者这条不能去掉——组织者身份被取消后，自己建的活动还要有人管。
 */
function canManageEvent (r, evt) {
  if (!r) return false
  if (r.isAdmin || r.isOrganizer) return true
  return !!evt && evt.ownerOpenid === r.openid
}

/**
 * 谁能**看到**这场活动。
 *
 * 「仅限群聊转发可见」的活动不进公开列表，也不允许靠猜 id 打开：只有管理身份、
 * 已经报名的人、以及**通过带 token 的分享链接进来过**的人能看到。
 *
 * 为什么要有"进来过"这一条：群里有人点开链接报了名，之后从「最近使用」重新进入、
 * 或者在活动列表里找它，都不该突然消失。所以第一次用正确 token 打开时会把它记进
 * evt.visitors，此后这个人就正常可见了。
 *
 * 注意这是**可见性**判定，不是权限：能看到不等于能操作任何东西，那些仍然由
 * canManageEvent 和各自的业务校验把关。
 *
 * @param {object} r        调用者角色
 * @param {object} evt      活动文档
 * @param {object} [opts]   { hasSignup: 调用者是否已报名 }
 */
function canViewEvent (r, evt, opts) {
  if (!evt) return false
  if (evt.visibility !== 'group') return true
  if (canManageEvent(r, evt)) return true
  if (opts && opts.hasSignup) return true
  const visitors = Array.isArray(evt.visitors) ? evt.visitors : []
  return !!r && visitors.indexOf(r.openid) >= 0
}

module.exports = {
  ADMIN_OPENIDS: ADMIN_OPENIDS,
  ROLE_ADMIN: ROLE_ADMIN,
  ROLE_ORGANIZER: ROLE_ORGANIZER,
  LEGACY_ROLE_SCORER: LEGACY_ROLE_SCORER,
  MAX_ROLE_DOCS: MAX_ROLE_DOCS,
  loadRoles: loadRoles,
  canCreateEvent: canCreateEvent,
  canManageRoles: canManageRoles,
  canManageEvent: canManageEvent,
  canViewEvent: canViewEvent,
}
