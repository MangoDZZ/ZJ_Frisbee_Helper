'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    isOrganizer: false,
    eventName: '',
    list: [],
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
    return api.team('listTournaments', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({
          loading: false,
          failMessage: '',
          isOrganizer: d.isOrganizer,
          eventName: d.eventName,
          list: (d.list || []).map(function (t, i) {
            return Object.assign({}, t, {
              seq: i + 1,
              metaText: t.attendeeCount + ' 人到场 · 分 ' + t.teamCount + ' 队',
              stateText: !t.published ? '未分队'
                : t.matchCount > 0 ? '已记录 ' + t.matchCount + ' 场比赛' : '已分队',
              stateClass: !t.published ? 'tag-draft'
                : t.matchCount > 0 ? 'tag-divided' : 'tag-open',
              timeText: fmt.formatDateTime(t.createTime),
            })
          }),
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  openTournament: function (e) {
    // 已发布的直奔分队结果；还没分队的先去分队
    const t = this.data.list[e.currentTarget.dataset.index]
    wx.navigateTo({ url: '/pages/division/division?tournamentId=' + t._id })
  },

  editTournament: function (e) {
    wx.navigateTo({
      url: '/pages/tournament-edit/tournament-edit?tournamentId=' +
        e.currentTarget.dataset.id,
    })
  },

  addTournament: function () {
    wx.navigateTo({
      url: '/pages/tournament-edit/tournament-edit?eventId=' + this.data.eventId,
    })
  },

  removeTournament: function (e) {
    const that = this
    const t = this.data.list[e.currentTarget.dataset.index]
    wx.showModal({
      title: '删除「' + t.name + '」',
      content: '会连带删掉这场赛事的分队和' +
        (t.matchCount > 0 ? ' ' + t.matchCount + ' 场比赛记录' : '比赛记录') + '，无法恢复。',
      confirmText: '删除',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        api.team('removeTournament', { tournamentId: t._id }, { loading: '删除中' })
          .then(function () { return that.load() })
          .catch(function () {})
      },
    })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },
})
