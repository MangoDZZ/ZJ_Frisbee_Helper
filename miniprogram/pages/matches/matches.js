'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const mr = require('../../utils/match-rules.js')

Page({
  data: {
    tournamentId: '',
    eventId: '',
    tournamentName: '',
    canScore: false,
    loading: true,
    failMessage: '',
    isOwner: false,
    list: [],
    teamRecords: [],

    // 赛事级比赛规则（目标分 / 时限 / 中场）。组织者可以就地改，改完对之后录的比赛生效。
    rules: mr.DEFAULT_RULES,
    rulesText: '',
    rulesEditing: false,
    rulesForm: null,
    savingRules: false,
  },

  onLoad: function (q) {
    this.setData({ tournamentId: q.tournamentId || '' })
  },

  onShow: function () {
    if (this.data.tournamentId) this.load()
  },

  onPullDownRefresh: function () {
    this.load().then(function () { wx.stopPullDownRefresh() })
  },

  load: function () {
    const that = this
    return api.match('listMatches', { tournamentId: this.data.tournamentId },
      { loading: false, toastError: false })
      .then(function (d) {
        const rules = mr.normalizeRules(d.rules)
        that.setData({
          loading: false,
          failMessage: '',
          isOwner: d.canScore,
          canScore: d.canScore,
          eventId: d.eventId,
          tournamentName: d.tournamentName,
          rules: rules,
          rulesText: rulesSummary(rules),
          list: (d.list || []).map(function (m, i) { return decorate(m, i, rules) }),
          teamRecords: (d.teamRecords || []).map(function (r) {
            return Object.assign({}, r, {
              diff: r.scoreFor - r.scoreAgainst,
              diffText: (r.scoreFor - r.scoreAgainst > 0 ? '+' : '') + (r.scoreFor - r.scoreAgainst),
            })
          }).sort(function (a, b) {
            if (b.won !== a.won) return b.won - a.won
            return b.diff - a.diff
          }),
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  // ---------------------------------------------------------------- 赛前配置

  editRules: function () {
    const r = this.data.rules
    this.setData({
      rulesEditing: true,
      rulesForm: {
        targetScore: String(r.targetScore),
        // 两个选填项：空串就是"不设"
        halftimeMinutes: r.halftimeMinutes === null ? '' : String(r.halftimeMinutes),
        softCapMinutes: String(r.softCapMinutes),
        hardCapMinutes: r.hardCapMinutes === null ? '' : String(r.hardCapMinutes),
        halftimeBreakMinutes: String(r.halftimeBreakMinutes),
      },
    })
  },

  cancelRules: function () {
    this.setData({ rulesEditing: false, rulesForm: null })
  },

  onRuleInput: function (e) {
    const patch = {}
    patch['rulesForm.' + e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  saveRules: function () {
    const f = this.data.rulesForm
    // 前端先挡一遍（越界立刻提示），云函数里还会再校验一次
    const v = mr.validateRules(f)
    if (v.error) return warn(v.error.message)

    const that = this
    this.setData({ savingRules: true })
    api.match('setMatchRules', {
      tournamentId: this.data.tournamentId,
      rules: v.value,
    }, { loading: '保存中' })
      .then(function () {
        wx.showToast({ title: '规则已保存', icon: 'success' })
        that.setData({ rulesEditing: false, rulesForm: null, savingRules: false })
        return that.load()
      })
      .catch(function () {
        that.setData({ savingRules: false })
      })
  },

  addMatch: function () {
    wx.navigateTo({ url: '/pages/match-edit/match-edit?tournamentId=' + this.data.tournamentId })
  },

  editMatch: function (e) {
    if (!this.data.isOwner) return
    wx.navigateTo({
      url: '/pages/match-edit/match-edit?tournamentId=' + this.data.tournamentId +
        '&matchId=' + e.currentTarget.dataset.id,
    })
  },

  removeMatch: function (e) {
    const that = this
    const row = this.data.list[e.currentTarget.dataset.index]
    wx.showModal({
      title: '删除这场比赛',
      content: row.titleText + '　' + row.scoreText + '\n删除后相关积分会同步扣掉。',
      confirmText: '删除',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        api.match('removeMatch', {
          tournamentId: that.data.tournamentId,
          matchId: row._id,
        }, { loading: '删除中' })
          .then(function () { return that.load() })
          .catch(function () {})
      },
    })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },

  goStats: function () {
    wx.navigateTo({ url: '/pages/stats/stats?eventId=' + this.data.eventId })
  },
})

function rulesSummary (r) {
  const parts = [
    '目标分 ' + r.targetScore,
    r.halftimeMinutes === null ? '无时间中场' : '时间中场 ' + r.halftimeMinutes + '分',
    '软时限 ' + r.softCapMinutes + '分',
    r.hardCapMinutes === null ? '无硬时限' : '硬时限 ' + r.hardCapMinutes + '分',
    '休息 ' + r.halftimeBreakMinutes + '分',
  ]
  return parts.join(' · ')
}

function decorate (m, i, rules) {
  const aWin = m.winner === 'A'
  // 用时：开过表的才算得出。比赛中的按"最后一分"算——列表里没有秒级刷新，
  // 每秒重排一次纯属浪费；想知道精确时间进记分页。
  let clockText = ''
  if (m.startedAt) {
    const now = m.status === 'live'
      ? (m.points.length > 0 && m.points[m.points.length - 1].t !== null
          ? m.startedAt + m.points[m.points.length - 1].t * 1000
          : Date.now())
      : (m.endedAt || m.startedAt)
    const sec = Math.max(0, Math.floor((now - m.startedAt) / 1000))
    clockText = '用时 ' + mr.formatClock(sec)
    const st = mr.clockState(rules, m.startedAt, m.points, now)
    if (st.targetRaised) clockText += ' · 目标 ' + st.target
  }
  return Object.assign({}, m, {
    seq: i + 1,
    // 比赛中就存下来的记录在列表上标出来，免得记分员忘了回去点「比赛结束」
    live: m.status === 'live',
    titleText: m.teamAName + ' vs ' + m.teamBName,
    scoreText: m.scoreA + ' : ' + m.scoreB,
    winnerName: aWin ? m.teamAName : m.teamBName,
    aClass: aWin ? 'side-win' : 'side-lose',
    bClass: aWin ? 'side-lose' : 'side-win',
    countText: m.participantsA.length + ' v ' + m.participantsB.length + ' 上场',
    clockText: clockText,
    notes: m.notes || '',
    mvpText: m.mvps.length > 0
      ? m.mvps.map(function (p) { return p.name }).join('、')
      : '',
    forfeitText: (m.forfeits || []).length > 0
      ? m.forfeits.map(function (p) { return p.name }).join('、')
      : '',
    timeText: fmt.formatDateTime(m.createTime),
  })
}

function warn (msg) {
  wx.showToast({ title: msg, icon: 'none' })
}
