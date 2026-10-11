'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    isOwner: false,
    list: [],
    teamRecords: [],
  },

  onLoad: function (q) {
    this.setData({ eventId: q.eventId || '' })
  },

  onShow: function () {
    if (this.data.eventId) this.load()
  },

  onPullDownRefresh: function () {
    this.load().then(function () { wx.stopPullDownRefresh() })
  },

  load: function () {
    const that = this
    return api.match('listMatches', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({
          loading: false,
          failMessage: '',
          isOwner: d.isOwner,
          list: (d.list || []).map(decorate),
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

  addMatch: function () {
    wx.navigateTo({ url: '/pages/match-edit/match-edit?eventId=' + this.data.eventId })
  },

  editMatch: function (e) {
    if (!this.data.isOwner) return
    wx.navigateTo({
      url: '/pages/match-edit/match-edit?eventId=' + this.data.eventId +
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
          eventId: that.data.eventId,
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
})

function decorate (m, i) {
  const aWin = m.winner === 'A'
  return Object.assign({}, m, {
    seq: i + 1,
    titleText: m.teamAName + ' vs ' + m.teamBName,
    scoreText: m.scoreA + ' : ' + m.scoreB,
    winnerName: aWin ? m.teamAName : m.teamBName,
    aClass: aWin ? 'side-win' : 'side-lose',
    bClass: aWin ? 'side-lose' : 'side-win',
    countText: m.participantsA.length + ' v ' + m.participantsB.length + ' 上场',
    mvpText: m.mvps.length > 0
      ? m.mvps.map(function (p) { return p.name }).join('、')
      : '',
    timeText: fmt.formatDateTime(m.createTime),
  })
}
