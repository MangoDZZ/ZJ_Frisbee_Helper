'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const share = require('../../utils/share.js')

/**
 * 得分助攻榜（活动级）。
 *
 * 三张榜：得分榜、助攻榜、得分+助攻榜，各自取前 15 名。
 *
 * 数据只来自**有逐分明细**的比赛——老比赛只有比分，分不出谁得了哪一分。
 * 所以场次数可能小于积分榜的场次数，页面必须把这个差异写出来，
 * 否则看起来就像"统计漏了几场"。
 */
const TOP_N = 15

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    eventName: '',
    boards: [],
    totals: null,
    matchCount: 0,
    missingText: '',
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
    return share.withImage({
      title: (this.data.eventName || '飞盘 HAT') + ' 得分助攻榜',
      path: '/pages/stats/stats?eventId=' + this.data.eventId,
    })
  },

  load: function () {
    const that = this
    return api.match('pointStats', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        const rows = d.rows || []
        const withPoints = (d.totals && d.totals.matchCount) || 0
        const total = d.matchCount || 0
        that.setData({
          loading: false,
          failMessage: '',
          eventName: d.eventName,
          totals: d.totals || { matchCount: 0, pointCount: 0, playerCount: 0 },
          matchCount: total,
          boards: buildBoards(rows),
          missingText: total > withPoints
            ? '本活动共 ' + total + ' 场比赛，其中 ' + (total - withPoints) +
              ' 场没有逐分明细（升级前的记录），不计入本榜'
            : '',
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },
})

/** 三张榜各自排序取前 15 名。0 的不上榜——全是 0 的名单没有信息量。 */
function buildBoards (rows) {
  function top (metric) {
    const list = rows.filter(function (r) { return r[metric] > 0 })
    list.sort(function (a, b) {
      if (b[metric] !== a[metric]) return b[metric] - a[metric]
      // 同分按得分多的靠前，再按助攻，最后按名字，保证顺序稳定
      if (b.goals !== a.goals) return b.goals - a.goals
      if (b.assists !== a.assists) return b.assists - a.assists
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
    // 并列同名次：指标相同就算并列，和积分榜的口径一致
    let lastKey = null
    let lastRank = 0
    return list.slice(0, TOP_N).map(function (r, i) {
      const key = String(r[metric])
      if (key !== lastKey) {
        lastRank = i + 1
        lastKey = key
      }
      return Object.assign({}, r, {
        rank: lastRank,
        rankClass: lastRank <= 3 ? 'rank-top rank-' + lastRank : '',
        value: r[metric],
        genderText: fmt.genderText(r.gender),
      })
    })
  }

  return [
    { key: 'goals', title: '得分榜', unit: '分', rows: top('goals') },
    { key: 'assists', title: '助攻榜', unit: '次', rows: top('assists') },
    { key: 'total', title: '得分 + 助攻榜', unit: '分', rows: top('total') },
  ]
}
