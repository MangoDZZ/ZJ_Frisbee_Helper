'use strict'

/**
 * 角色与权限判定。
 *
 * 这份文件在每个云函数里各有一份副本——云函数各自独立部署，没法跨目录共享代码，
 * 这和已有的 loadEvent / loadSignups 重复是同一个原因。改管理员名单要改全部副本。
 *
 * 权限一律在云函数里判，绝不能依赖客户端：miniprogram/config.js 是前端代码，
 * 改一行就能冒充任何身份，那里的角色信息只用来控制按钮显隐。
 */

/**
 * 管理员 openid 白名单。
 * 加人时记得把所有云函数里的这份文件一起改掉并重新部署。
 */
const ADMIN_OPENIDS = [
  'o6zAJs1Gu-uGvF8CdCYLPQJ6z4h8',
]

const ROLE_SCORER = 'scorer'

function isAdmin (openid) {
  return ADMIN_OPENIDS.indexOf(openid) >= 0
}

/** 记分员存在 roles 集合里，由管理员增删。 */
async function isScorer (db, openid) {
  if (!openid) return false
  const res = await db.collection('roles').where({
    openid: openid, role: ROLE_SCORER,
  }).limit(1).get()
  return !!(res.data && res.data.length > 0)
}

/** 活动创建者或管理员。管理员拥有组织者的全部权限——计划书里"维护系统运行"的含义。 */
function isOrganizer (evt, openid) {
  return !!evt && (evt.ownerOpenid === openid || isAdmin(openid))
}

/** 能录战绩的人：记分员、组织者、管理员。 */
async function canScore (db, evt, openid) {
  if (isOrganizer(evt, openid)) return true
  return isScorer(db, openid)
}

/**
 * 能看到球员水平的人。参与者只能在报名页看到自己的自评，
 * 其他任何出口都不该带上 level。
 */
function canSeeLevel (evt, openid) {
  return isOrganizer(evt, openid)
}

module.exports = {
  ADMIN_OPENIDS: ADMIN_OPENIDS,
  ROLE_SCORER: ROLE_SCORER,
  isAdmin: isAdmin,
  isScorer: isScorer,
  isOrganizer: isOrganizer,
  canScore: canScore,
  canSeeLevel: canSeeLevel,
}
