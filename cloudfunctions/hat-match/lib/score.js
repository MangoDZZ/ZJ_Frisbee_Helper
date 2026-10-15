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
 * @returns {{ rows: Array, totals: object }}
 *
 * 行里不带 level：积分榜对所有人可见，而球员水平是不公开的。
 * 也不带队伍——同一个人在不同赛事属于不同队，汇总层面没有唯一队伍。
 */
function computeStandings (matches, signupsById) {
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

  // 活动级规则：累计弃赛两次及以上，最终积分归零。
  rows.forEach(function (row) {
    if (row.forfeitCount >= FORFEIT_RESET) row.points = 0
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
    },
  }
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
  winnerOf: winnerOf,
  computeStandings: computeStandings,
  computeTeamRecords: computeTeamRecords,
}
