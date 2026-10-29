'use strict'

/**
 * 「高分球员」的界线。**唯一源头是本文件**，`miniprogram/utils/` 和
 * `cloudfunctions/hat-team/lib/` 下的副本由 `scripts/sync-shared.js` 生成。
 *
 * 为什么必须共用一份：分队时客户端按这条线统计明星人数、算代价；保存分队时
 * 云函数要用**同一条线**重算队伍统计。两边算得不一样，就会出现"分队时按 5 分算、
 * 展示时说 4 分算高分"这种自相矛盾的数字，而这种错误没有任何报错提示。
 *
 * 这条线原来是写死的 L5。问题是大部分业余局里根本没有 L5：整条"高分均衡"的
 * 代价项等于不存在，组织者以为已经均衡了。现在改成"本次上场的人里最高的那一档"，
 * 也就是说：**比自己这组人最强的那档**要分散到各队去。
 *
 * 两条规则：
 *  - 线 = 参与分队的人里的最高有效等级（1-5）。缺席的 L5 不影响本场，
 *    "活动中存在的最高等级"按这一场到场的这批人算。
 *  - 所有人同档（比如全是 L3）时，返回 null，谁都不算高分。否则所有人都算高分，
 *    这一项就退化成"人数均衡"的加权版本，和文档写的权重语义不一致了。
 */

const MIN_LEVEL = 1
const MAX_LEVEL = 5

/**
 * @param {number[]} levels 参与分队者的等级（允许混入无效值，会被忽略）
 * @returns {number|null} 高分线；没有任何有效等级或全员同档时返回 null
 */
function starLevelOf (levels) {
  let max = null
  let min = null
  const list = Array.isArray(levels) ? levels : []
  for (let i = 0; i < list.length; i++) {
    const n = list[i]
    if (typeof n !== 'number' || !isFinite(n)) continue
    if (n < MIN_LEVEL || n > MAX_LEVEL) continue
    if (max === null || n > max) max = n
    if (min === null || n < min) min = n
  }
  if (max === null) return null
  // 全员同档 → 没有"高分"可言，这一项不参与打分
  if (max === min) return null
  return max
}

/** 这个人算不算高分。starLevel 为 null（无分档）时一律不算。 */
function isStar (level, starLevel) {
  if (starLevel === null || starLevel === undefined) return false
  return typeof level === 'number' && isFinite(level) && level >= starLevel
}

/** 一批人里有几个高分。 */
function countStars (levels, starLevel) {
  const list = Array.isArray(levels) ? levels : []
  let n = 0
  for (let i = 0; i < list.length; i++) {
    if (isStar(list[i], starLevel)) n++
  }
  return n
}

module.exports = {
  MIN_LEVEL: MIN_LEVEL,
  MAX_LEVEL: MAX_LEVEL,
  starLevelOf: starLevelOf,
  isStar: isStar,
  countStars: countStars,
}
