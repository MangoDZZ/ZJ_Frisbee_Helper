'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    eventName: '',
    rows: [],
    totals: null,
    ruleText: '',
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

  onShareAppMessage: function () {
    return {
      title: (this.data.eventName || '飞盘 HAT') + ' 积分榜',
      path: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId,
    }
  },

  load: function () {
    const that = this
    return api.match('leaderboard', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({
          loading: false,
          failMessage: '',
          eventName: d.eventName,
          totals: d.totals,
          ruleText: '胜 +' + d.rules.win + '　负 +' + d.rules.loss +
            '　当选 MVP 再 +' + d.rules.mvp + '　未上场不计分',
          rows: (d.rows || []).map(function (r) {
            return Object.assign({}, r, {
              genderText: fmt.genderText(r.gender),
              recordText: r.played > 0
                ? r.played + ' 场 ' + r.won + ' 胜 ' + r.lost + ' 负'
                : '未上场',
              // 前三名给个高亮，其余保持朴素
              rankClass: r.points > 0 && r.rank <= 3 ? 'rank-top rank-' + r.rank : '',
              dimClass: r.played === 0 ? 'row-dim' : '',
            })
          }),
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  goMatches: function () {
    wx.navigateTo({ url: '/pages/matches/matches?eventId=' + this.data.eventId })
  },
})
