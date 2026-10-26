'use strict'

/**
 * 比赛规则与时间轴。**唯一源头是本文件**，两处副本由 `node scripts/sync-shared.js` 生成：
 *
 *  - `cloudfunctions/hat-match/lib/match-rules.js` —— 服务端校验规则
 *  - `miniprogram/utils/match-rules.js` —— 客户端算时间轴、渲染提示
 *
 * 两个副本都是生成物，**不要直接改**。之所以能共用一份：本文件是纯 JS，
 * 既不用 wx API 也不用 Node API，两边都能跑。这样"目标分 13、时间中场 30 分钟"
 * 这些常量只有一处，不会出现"组织者改成 15、记分页还按 13 提示可以结束"。
 *
 * 规则来自 plan.md v1.1.4：
 *  - 初始目标分：任一队到达即比赛结束（默认 13）
 *  - 软时限：到点之后的**下一次得分完成时**，场上分数较高者 +1 成为新目标分（默认 60min）
 *  - 硬时限（可选）：到点即必须结束，与比分无关
 *  - 时间中场（可选）：中场条件的**时间分支**（默认 30min）
 *  - 中场条件：时间中场与「任一队达到 ceil(目标分/2)」取**较早**者；
 *    时间中场不设时只看分数分支
 *  - 中场休息时长：只是个提示用的倒计时，**不停表**
 */

const DEFAULT_RULES = {
  targetScore: 13,
  halftimeMinutes: 30,
  softCapMinutes: 60,
  hardCapMinutes: null,
  halftimeBreakMinutes: 3,
}

/**
 * 可留空的项。0 / '' / null / 缺省之外的"不设"都归一到 null。
 * 注意「缺省」与「显式不设」是两回事：老数据没有这个字段要拿到默认值，
 * 而组织者主动清空要真的变成"不设"。见 normalizeRules。
 */
const OPTIONAL_KEYS = ['halftimeMinutes', 'hardCapMinutes']

const LIMITS = {
  targetScore: { min: 1, max: 99 },
  halftimeMinutes: { min: 1, max: 180 },
  softCapMinutes: { min: 1, max: 300 },
  hardCapMinutes: { min: 1, max: 600 },
  halftimeBreakMinutes: { min: 0, max: 30 },
}

function intOf (v) {
  if (typeof v === 'number') return isFinite(v) && Math.floor(v) === v ? v : null
  const s = typeof v === 'string' ? v.trim() : ''
  if (s === '') return null
  const n = Number(s)
  return isFinite(n) && Math.floor(n) === n ? n : null
}

function clamp (n, lim) {
  if (n < lim.min) return lim.min
  if (n > lim.max) return lim.max
  return n
}

/** 表单里表示"不设"的各种写法：空串、null、0。 */
function isEmptyValue (v) {
  return v === null || v === undefined || v === '' || v === 0
}

/**
 * 把任意输入规整成完整规则：缺字段用默认值，越界截断。
 *
 * 越界**截断**而不是报错，是给"读"这条路径用的：老赛事没有 matchRules，
 * 或者数据被人手改过，页面仍然要能画出合理的规则和时间轴。
 * 保存走 validateRules，那里越界会明确报错。
 *
 * 可选字段的两种"空"要区分开：
 *  - **字段不存在** → 用默认值（老赛事没有 halftimeMinutes，应当拿到 30）
 *  - **字段存在但为空**（null/''/0）→ 就是不设（组织者主动清空过）
 */
function normalizeRules (raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}

  const target = intOf(src.targetScore)
  out.targetScore = target === null ? DEFAULT_RULES.targetScore
    : clamp(target, LIMITS.targetScore)

  const soft = intOf(src.softCapMinutes)
  out.softCapMinutes = soft === null ? DEFAULT_RULES.softCapMinutes
    : clamp(soft, LIMITS.softCapMinutes)

  const brk = intOf(src.halftimeBreakMinutes)
  out.halftimeBreakMinutes = brk === null ? DEFAULT_RULES.halftimeBreakMinutes
    : clamp(brk, LIMITS.halftimeBreakMinutes)

  OPTIONAL_KEYS.forEach(function (key) {
    if (src[key] === undefined) {
      out[key] = DEFAULT_RULES[key]
      return
    }
    if (isEmptyValue(src[key])) {
      out[key] = null
      return
    }
    const n = intOf(src[key])
    out[key] = n === null ? null : clamp(n, LIMITS[key])
  })

  return out
}

/**
 * 严格校验（保存规则时用）。与 normalize 的差别：这里**报错而不是截断**，
 * 否则组织者把目标分误填成 100 只会被悄悄改成 99，他还以为存上了。
 */
function validateRules (raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}

  const fields = ['targetScore', 'softCapMinutes', 'halftimeBreakMinutes']
  const labels = {
    targetScore: '初始目标分',
    halftimeMinutes: '时间中场',
    softCapMinutes: '软时限',
    halftimeBreakMinutes: '中场休息时长',
  }
  for (let i = 0; i < fields.length; i++) {
    const key = fields[i]
    const lim = LIMITS[key]
    const n = intOf(src[key])
    if (n === null) {
      return { error: { code: 'INVALID_INPUT', message: labels[key] + '需要填整数' } }
    }
    if (n < lim.min || n > lim.max) {
      return {
        error: {
          code: 'INVALID_INPUT',
          message: labels[key] + '需要是 ' + lim.min + ' 到 ' + lim.max + ' 之间的整数',
        },
      }
    }
    out[key] = n
  }

  // 两个可选项：空 / null / 0 都表示不设
  for (let i = 0; i < OPTIONAL_KEYS.length; i++) {
    const key = OPTIONAL_KEYS[i]
    if (isEmptyValue(src[key])) {
      out[key] = null
      continue
    }
    const lim = LIMITS[key]
    const n = intOf(src[key])
    if (n === null || n < lim.min || n > lim.max) {
      return {
        error: {
          code: 'INVALID_INPUT',
          message: labels[key] + '需要是 ' + lim.min + ' 到 ' + lim.max + ' 之间的整数，或者留空',
        },
      }
    }
    out[key] = n
  }

  if (out.halftimeMinutes !== null && out.halftimeMinutes > out.softCapMinutes) {
    return { error: { code: 'INVALID_INPUT', message: '时间中场不能晚于软时限' } }
  }
  if (out.hardCapMinutes !== null && out.hardCapMinutes <= out.softCapMinutes) {
    return { error: { code: 'INVALID_INPUT', message: '硬时限必须晚于软时限' } }
  }

  return { value: out }
}

/** 中场门限分：初始目标分的一半向上取整。13 → 7。 */
function halfTargetOf (targetScore) {
  const n = intOf(targetScore)
  return Math.ceil((n === null ? DEFAULT_RULES.targetScore : n) / 2)
}

/** 秒 → "12:34"；超过一小时 → "1:02:03"。 */
function formatClock (sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const mm = h > 0 && m < 10 ? '0' + m : String(m)
  return (h > 0 ? h + ':' : '') + mm + ':' + (ss < 10 ? '0' + ss : String(ss))
}

/**
 * 算出一场比赛在当前时刻的全部时间轴状态。
 *
 * @param {object} rules      normalizeRules 的产物（传原始值也行，内部会再规整一次）
 * @param {number} startedAt  开表时刻（毫秒）。0/null 表示还没开表
 * @param {Array}  points     [{ team, t }]，t 是**相对开表的秒数**；老比赛没有 t
 * @param {number} now        当前时刻（毫秒）。测试里随便传
 */
function clockState (rules, startedAt, points, now) {
  const r = normalizeRules(rules)
  const list = Array.isArray(points) ? points : []
  const running = !!startedAt && startedAt > 0
  const elapsedSec = running ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0

  const baseTarget = r.targetScore
  const halfTarget = halfTargetOf(baseTarget)
  const softSec = r.softCapMinutes * 60

  let a = 0
  let b = 0
  let halfByScoreSec = null
  let raisedTarget = null
  let raisedAtSec = null

  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (p.team === 'A') a++
    else if (p.team === 'B') b++
    const t = intOf(p.t)
    if (t === null) continue

    if (halfByScoreSec === null && Math.max(a, b) >= halfTarget) {
      halfByScoreSec = t
    }
    // 软时限之后**完成**的第一分：场上分数较高者 +1 成为新目标
    if (raisedTarget === null && t >= softSec) {
      raisedTarget = Math.max(a, b) + 1
      raisedAtSec = t
    }
  }

  const target = raisedTarget === null ? baseTarget : Math.max(baseTarget, raisedTarget)

  // 中场条件：时间中场与分数分支取较早者。时间中场不设时只看分数分支；
  // 时间分支只要"到点"就算，不必等某一次得分——否则一直不得分就永远不到中场。
  const halfByTimeSec = r.halftimeMinutes === null ? null : r.halftimeMinutes * 60
  let halfAtSec = null
  let halfReason = ''
  if (halfByScoreSec !== null) {
    halfAtSec = halfByScoreSec
    halfReason = 'score'
  }
  if (halfByTimeSec !== null && elapsedSec >= halfByTimeSec &&
      (halfAtSec === null || halfByTimeSec < halfAtSec)) {
    halfAtSec = halfByTimeSec
    halfReason = 'time'
  }
  const halfReached = halfAtSec !== null
  const breakEndSec = halfReached ? halfAtSec + r.halftimeBreakMinutes * 60 : null

  let phase = 'first'
  if (halfReached) phase = elapsedSec < breakEndSec ? 'halftime' : 'second'

  const hardSec = r.hardCapMinutes === null ? null : r.hardCapMinutes * 60
  const hardReached = hardSec !== null && elapsedSec >= hardSec

  const lead = Math.max(a, b)
  const targetReached = lead >= target
  const tied = a === b

  return {
    running: running,
    elapsedSec: elapsedSec,
    scoreA: a,
    scoreB: b,
    baseTarget: baseTarget,
    halfTarget: halfTarget,
    target: target,
    targetRaised: raisedTarget !== null && target > baseTarget,
    targetRaisedAtSec: raisedAtSec,
    halfReached: halfReached,
    halfAtSec: halfAtSec,
    halfReason: halfReason,
    breakEndSec: breakEndSec,
    breakRemainSec: halfReached ? Math.max(0, breakEndSec - elapsedSec) : 0,
    inBreak: phase === 'halftime',
    phase: phase,
    softReached: elapsedSec >= softSec,
    softSec: softSec,
    hardSec: hardSec,
    hardReached: hardReached,
    targetReached: targetReached,
    // 硬时限到了但比分相同：必须继续记到分出胜负（结束的比赛不允许平局）
    tieAtHardCap: hardReached && tied,
    canFinish: targetReached || (hardReached && !tied),
  }
}

/**
 * 记分页显示的一句提示，空串表示没什么要说的。
 * 只做文案，判定全在 clockState 里——测试只用测一个地方。
 */
function clockHint (state) {
  if (!state || !state.running) return ''
  if (state.tieAtHardCap) return '已到硬时限但比分相同，请继续记到分出胜负'
  if (state.targetReached) {
    return state.targetRaised
      ? '已达到软时限后的新目标分，可以结束比赛'
      : '已达到目标分 ' + state.target + '，可以结束比赛'
  }
  if (state.hardReached) return '已到硬时限，可以结束比赛'
  if (state.inBreak) return '中场休息中，还有 ' + formatClock(state.breakRemainSec)
  if (state.softReached && !state.targetRaised) {
    return '已到软时限，下一次得分后目标分将调整为领先方 +1'
  }
  return ''
}

module.exports = {
  DEFAULT_RULES: DEFAULT_RULES,
  LIMITS: LIMITS,
  normalizeRules: normalizeRules,
  validateRules: validateRules,
  halfTargetOf: halfTargetOf,
  formatClock: formatClock,
  clockState: clockState,
  clockHint: clockHint,
}
