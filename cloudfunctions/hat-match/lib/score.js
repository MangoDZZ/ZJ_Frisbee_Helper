'use strict'

/**
 * 积分推导。纯函数，不依赖云环境，可在 Node 里直接测试。
 *
 * 积分刻意不入库，每次按比赛记录实时推导。存一份积分字段就一定会漂移——
 * 改一次比分、删一场比赛、换一次 MVP，存量数字就对不上了。一场活动几十人、
 * 十几场比赛，实时算是毫秒级的事，换来的是积分永远和战绩一致。
 */

// 规则分值。将来要调分值改这三行即可。
const WIN = 3
const LOSS = 1
const MVP_BONUS = 1

/** 单场比赛的胜负判定。不允许平局，录入时已挡，这里再兜一次底。 */
function winnerOf (match) {
  if (match.scoreA > match.scoreB) return 'A'
  if (match.scoreB > match.scoreA) return 'B'
  return null
}

function asArray (v) { return Array.isArray(v) ? v : [] }

/**
 * @param {Array}  matches      比赛记录
 * @param {object} division     分队结果 { teams: [{ index, name, memberIds }] }
 * @param {object} signupsById  报名记录映射 { [signupId]: { name, gender, level } }
 * @returns {{ rows: Array, totals: object }}
 */
function computeStandings (matches, division, signupsById) {
  const teams = (division && Array.isArray(division.teams)) ? division.teams : []
  const byId = signupsById || {}

  // 先把分队名单里的每个人都建好一行，积分 0。
  // 一场没打的人也要出现在榜上——组织者需要看到谁还没上过场。
  const rows = []
  const rowOf = {}
  for (let t = 0; t < teams.length; t++) {
    const team = teams[t]
    const ids = asArray(team.memberIds)
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (rowOf[id]) continue
      const p = byId[id]
      const row = {
        signupId: id,
        // 报名记录被删掉时给占位，避免整页渲染不出来（与 getDivision 的处理一致）
        name: p ? p.name : '(已退出)',
        gender: p ? p.gender : 'U',
        level: p ? p.level : 0,
        teamIndex: team.index,
        teamName: team.name,
        points: 0,
        played: 0,
        won: 0,
        lost: 0,
        mvpCount: 0,
      }
      rowOf[id] = row
      rows.push(row)
    }
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
      if (!row) continue                 // 不在当前分队名单里的人直接忽略
      row.points += WIN
      row.played++
      row.won++
    }
    for (let i = 0; i < losers.length; i++) {
      const row = rowOf[losers[i]]
      if (!row) continue
      row.points += LOSS
      row.played++
      row.lost++
    }

    // MVP 由胜方从败方的上场队员里选出，每人额外 +1。
    const mvps = asArray(match.mvpIds)
    for (let i = 0; i < mvps.length; i++) {
      const row = rowOf[mvps[i]]
      if (!row) continue
      row.points += MVP_BONUS
      row.mvpCount++
    }
  }

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

/** 队伍维度的战绩，用于比赛列表页的概览。 */
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
  winnerOf: winnerOf,
  computeStandings: computeStandings,
  computeTeamRecords: computeTeamRecords,
}
