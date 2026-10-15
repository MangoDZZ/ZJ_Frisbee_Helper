'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

/**
 * 我的数据（活动级）。报名者看自己的得分与助攻，含逐场明细。
 *
 * 只展示调用者自己的数据——云函数按 openid 反查报名记录，别人调这个接口
 * 拿到的也是他自己那份。
 */
Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    eventName: '',
    found: false,
    me: null,
    matches: [],
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
    return api.match('myStats', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        const me = d.me || null
        that.setData({
          loading: false,
          failMessage: '',
          eventName: d.eventName,
          found: !!d.found,
          me: me,
          matches: me ? (me.matches || []).map(function (m) {
            return Object.assign({}, m, {
              scoreText: m.scoreA + ' : ' + m.scoreB,
              dataText: m.forfeited
                ? '弃赛 -3'
                : '得分 ' + m.goals + ' · 助攻 ' + m.assists,
              dataClass: m.forfeited ? 'tag-full' : '',
              // 没有逐分明细的比赛（升级前录的）单独标出来，免得以为统计漏了
              noDetail: !m.hasPoints,
            })
          }) : [],
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  goStats: function () {
    wx.navigateTo({ url: '/pages/stats/stats?eventId=' + this.data.eventId })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },
})
