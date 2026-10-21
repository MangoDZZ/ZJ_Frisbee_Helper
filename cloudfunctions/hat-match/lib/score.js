'use strict'

/**
 * 积分推导。纯函数，不依赖云环境，可在 Node 里直接测试。
 *
 * 积分刻意不入库，每次按比赛记录实时推导。存一份积分字段就一定会漂移——
 * 改一次比分、删一场比赛、换一次 MVP，存量数字就对不上了。
 *
 * 积分榜是**活动级汇总**：报名在活动层，signupId 就是活动内的人员主键，
 * 所以跨赛事按它合并天然正确，计分过程压根不需要知道分队。
 */

// 规则分值。将来要调分值改这三行即可。
const WIN = 3
const LOSS = 1
const MVP_BONUS = 1
const FORFEIT = -3

/** 累计弃赛达到这个次数，最终积分归零（活动级规则）。 */
const FORFEIT_RESET = 2

/**
 * 单场比赛最多记录多少分（得分记录条数）。正常飞盘一局到 15 分、最多 21 分，
 * 这个上限只是兜住"客户端疯狂提交把文档撑爆"。
 */
const MAX_POINTS_PER_MATCH = 200

/** 得分记录。没有 points 字段的是老比赛（点位明细是 v1.1.0 才加的）。 */
function matchPoints (match) {
  return asArray(match && match.points)
}

/** 这场比赛是否有逐分明细。没有明细的比赛只算积分，不进得分/助攻榜。 */
function hasPoints (match) {
  return matchPoints(match).length > 0
}

/**
 * 比分。明细是唯一来源，但入库时已经把它折算成 scoreA/scoreB 一并存下，
 * 所以这里优先读明细、读不到再退回存量字段——老比赛和积分推导因此都不用改。
 */
function scoresOf (match) {
  const list = matchPoints(match)
  if (list.length > 0) {
    let a = 0
    let b = 0
    for (let i = 0; i < list.length; i++) {
      if (list[i].team === 'A') a++
      else if (list[i].team === 'B') b++
    }
    return { a: a, b: b }
  }
  return { a: match.scoreA, b: match.scoreB }
}

/** 单场比赛的胜负判定。不允许平局，录入时已挡，这里再兜一次底。 */
function winnerOf (match) {
  if (match.scoreA > match.scoreB) return 'A'
  if (match.scoreB > match.scoreA) return 'B'
  return null
}

function asArray (v) { return Array.isArray(v) ? v : [] }

/**
 * @param {Array}  matches     该活动下所有赛事的比赛记录
 * @param {object} signupsById 活动的全部报名 { [signupId]: { name, gender } }
 * @param {Array}  [adjustments] 随机事件调整 [{ signupIds: [...], delta: N }]
 * @returns {{ rows: Array, totals: object }}
 *
 * 行里不带 level：积分榜对所有人可见，而球员水平是不公开的。
 * 也不带队伍——同一个人在不同赛事属于不同队，汇总层面没有唯一队伍。
 */
function computeStandings (matches, signupsById, adjustments) {
  const byId = signupsById || {}

  // 先给每个报名的人建一行，积分 0。一场没打的人也要出现在榜上。
  const rows = []
  const rowOf = {}
  const ids = Object.keys(byId)
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const p = byId[id]
    const row = {
      signupId: id,
      name: p ? p.name : '(已退出)',
      gender: p ? p.gender : 'U',
      points: 0,
      // 比赛得来的分与随机事件调整分分开留档，前端可以标"其中事件 +N"
      matchPoints: 0,
      eventDelta: 0,
      eventCount: 0,
      reset: false,
      played: 0,
      won: 0,
      lost: 0,
      mvpCount: 0,
      forfeitCount: 0,
      tournamentCount: 0,
    }
    rowOf[id] = row
    rows.push(row)
  }

  // 记录每个人上过场的赛事，用来算「参加了几场赛事」
  const tourSeen = {}
  function noteTournament (signupId, tournamentId) {
    if (!tournamentId) return
    const key = signupId + '|' + tournamentId
    if (tourSeen[key]) return
    tourSeen[key] = true
    rowOf[signupId].tournamentCount++
  }

  const list = asArray(matches)
  let counted = 0
  for (let m = 0; m < list.length; m++) {
    const match = list[m]
    const winner = winnerOf(match)
    if (winner === null) continue        // 平局不计分（正常录不进来）
    counted++

    const winners = asArray(winner === 'A' ? match.participantsA : match.participantsB)
    const losers = asArray(winner === 'A' ? match.participantsB : match.participantsA)

    for (let i = 0; i < winners.length; i++) {
      const row = rowOf[winners[i]]
      if (!row) continue                 // 不在报名名单里的人直接忽略
      row.points += WIN
      row.played++
      row.won++
      noteTournament(winners[i], match.tournamentId)
    }
    for (let i = 0; i < losers.length; i++) {
      const row = rowOf[losers[i]]
      if (!row) continue
      row.points += LOSS
      row.played++
      row.lost++
      noteTournament(losers[i], match.tournamentId)
    }

    // MVP 由胜方从败方的上场队员里选出，每人额外 +1。
    const mvps = asArray(match.mvpIds)
    for (let i = 0; i < mvps.length; i++) {
      const row = rowOf[mvps[i]]
      if (!row) continue
      row.points += MVP_BONUS
      row.mvpCount++
    }

    // 弃赛人员单独记录：不计该场胜负分，但扣 3 分。
    const forfeits = asArray(match.forfeitIds)
    for (let i = 0; i < forfeits.length; i++) {
      const row = rowOf[forfeits[i]]
      if (!row) continue
      row.points += FORFEIT
      row.forfeitCount++
      noteTournament(forfeits[i], match.tournamentId)
    }
  }

  // 比赛得来的分在这里定格：随机事件调整和"弃赛归零"都在它之上再算。
  rows.forEach(function (row) { row.matchPoints = row.points })

  // ---- 随机事件调整 ----
  // adjustments 是 [{ signupIds: [...], delta: N }]，由已触发的随机事件摊平而来。
  // 名单里已经不在报名表上的人直接忽略（名单被删过），不凭空造行。
  // 同一条事件里重复出现的人只算一次——否则一个手滑的重复能把分数加两遍。
  const adjs = asArray(adjustments)
  for (let i = 0; i < adjs.length; i++) {
    const a = adjs[i] || {}
    const delta = Number(a.delta)
    if (!isFinite(delta) || delta === 0) continue
    const targets = asArray(a.signupIds)
    const seen = {}
    for (let j = 0; j < targets.length; j++) {
      const id = targets[j]
      if (!id || seen[id]) continue
      seen[id] = true
      const row = rowOf[id]
      if (!row) continue
      row.points += delta
      row.eventDelta += delta
      row.eventCount++
    }
  }

  // 活动级规则：累计弃赛两次及以上，最终积分归零。
  // 连随机事件调整一起归零——规则说的是"积分归零"，那就该看到 0 而不是"归零后又加回来"。
  // 事件调整的数额仍然留在 eventDelta 里，前端可以解释这笔分是怎么没的。
  rows.forEach(function (row) {
    if (row.forfeitCount >= FORFEIT_RESET) {
      row.reset = true
      row.points = 0
    }
  })

  rows.sort(function (a, b) {
    if (b.points !== a.points) return b.points - a.points
    if (b.won !== a.won) return b.won - a.won
    if (b.mvpCount !== a.mvpCount) return b.mvpCount - a.mvpCount
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  // 并列同名次：积分、胜场、MVP 三项都相同才算并列。
  let lastKey = null
  let lastRank = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const key = r.points + '/' + r.won + '/' + r.mvpCount
    if (key !== lastKey) {
      lastRank = i + 1
      lastKey = key
    }
    r.rank = lastRank
  }

  return {
    rows: rows,
    totals: {
      playerCount: rows.length,
      matchCount: counted,
      playedCount: rows.filter(function (r) { return r.played > 0 }).length,
      eventCount: adjs.length,
      eventResetCount: rows.filter(function (r) { return r.reset }).length,
    },
  }
}

/**
 * 得分 / 助攻统计，活动级汇总。
 *
 * 只统计**有逐分明细**的比赛：老比赛只有比分，分不出谁得了哪一分。所以榜单上的
 * 场次数可能小于积分榜的场次数，返回里用 matchCount / pointCount 把这个差异说清楚，
 * 别让组织者以为"统计漏了"。
 *
 * @param {Array}  matches     该活动下所有赛事的比赛记录
 * @param {object} signupsById 活动的全部报名 { [signupId]: { name, gender } }
 */
function computePointStats (matches, signupsById) {
  const byId = signupsById || {}
  const rows = []
  const rowOf = {}
  const ids = Object.keys(byId)
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const p = byId[id]
    const row = {
      signupId: id,
      name: p ? p.name : '(已退出)',
      gender: p ? p.gender : 'U',
      goals: 0,
      assists: 0,
      total: 0,
    }
    rowOf[id] = row
    rows.push(row)
  }

  const list = asArray(matches)
  let matchCount = 0
  let pointCount = 0
  for (let m = 0; m < list.length; m++) {
    const pts = matchPoints(list[m])
    if (pts.length === 0) continue
    matchCount++
    for (let i = 0; i < pts.length; i++) {
      pointCount++
      const scorer = rowOf[pts[i].scorer]
      if (scorer) {
        scorer.goals++
        scorer.total++
      }
      const assist = pts[i].assist
      if (assist && rowOf[assist]) {
        rowOf[assist].assists++
        rowOf[assist].total++
      }
    }
  }

  // 得分优先、再助攻、最后按名字，保证同一份数据每次算出的顺序一致。
  rows.sort(function (a, b) {
    if (b.goals !== a.goals) return b.goals - a.goals
    if (b.assists !== a.assists) return b.assists - a.assists
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  return {
    rows: rows,
    totals: {
      playerCount: rows.length,
      matchCount: matchCount,
      pointCount: pointCount,
    },
  }
}

/**
 * 某个人的得分 / 助攻，含逐场明细。给「我的数据」页用。
 *
 * 返回 null 表示这个 signupId 不在名单里（报名记录被删了）。
 */
function computeMyPoints (matches, signupsById, signupId) {
  const p = signupsById ? signupsById[signupId] : null
  if (!p) return null

  const out = {
    signupId: signupId,
    name: p.name,
    gender: p.gender,
    goals: 0,
    assists: 0,
    total: 0,
    matchCount: 0,
    matches: [],
  }

  const list = asArray(matches)
  for (let m = 0; m < list.length; m++) {
    const match = list[m]
    const pts = matchPoints(match)
    if (pts.length === 0) continue

    let goals = 0
    let assists = 0
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].scorer === signupId) goals++
      if (pts[i].assist && pts[i].assist === signupId) assists++
    }
    if (goals === 0 && assists === 0) continue

    out.goals += goals
    out.assists += assists
    out.matchCount++
    out.matches.push({
      matchId: match._id || '',
      tournamentId: match.tournamentId || '',
      goals: goals,
      assists: assists,
      scoreA: match.scoreA,
      scoreB: match.scoreB,
    })
  }
  out.total = out.goals + out.assists
  return out
}

/** 队伍战绩。只在单场赛事内有意义，所以仍然要传该赛事的分队。 */
function computeTeamRecords (matches, division) {
  const teams = (division && Array.isArray(division.teams)) ? division.teams : []
  const out = teams.map(function (t) {
    return {
      index: t.index,
      name: t.name,
      won: 0,
      lost: 0,
      scoreFor: 0,
      scoreAgainst: 0,
    }
  })
  const byIndex = {}
  out.forEach(function (r) { byIndex[r.index] = r })

  const list = asArray(matches)
  for (let m = 0; m < list.length; m++) {
    const match = list[m]
    const winner = winnerOf(match)
    if (winner === null) continue
    const a = byIndex[match.teamAIndex]
    const b = byIndex[match.teamBIndex]
    if (a) {
      a.scoreFor += match.scoreA
      a.scoreAgainst += match.scoreB
      if (winner === 'A') a.won++
      else a.lost++
    }
    if (b) {
      b.scoreFor += match.scoreB
      b.scoreAgainst += match.scoreA
      if (winner === 'B') b.won++
      else b.lost++
    }
  }
  return out
}

module.exports = {
  WIN: WIN,
  LOSS: LOSS,
  MVP_BONUS: MVP_BONUS,
  FORFEIT: FORFEIT,
  FORFEIT_RESET: FORFEIT_RESET,
  MAX_POINTS_PER_MATCH: MAX_POINTS_PER_MATCH,
  matchPoints: matchPoints,
  hasPoints: hasPoints,
  scoresOf: scoresOf,
  winnerOf: winnerOf,
  computeStandings: computeStandings,
  computePointStats: computePointStats,
  computeMyPoints: computeMyPoints,
  computeTeamRecords: computeTeamRecords,
}
