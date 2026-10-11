'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    list: [],
    loading: true,
    failed: false,
    scope: 'all',
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    const that = this
    this.load().then(function () { wx.stopPullDownRefresh() })
  },

  switchScope: function (e) {
    this.setData({ scope: e.currentTarget.dataset.scope }, this.load)
  },

  load: function () {
    const that = this
    return api.event('list', { scope: this.data.scope }, { loading: false, toastError: false })
      .then(function (d) {
        that.setData({
          list: (d.list || []).map(decorate),
          loading: false,
          failed: false,
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failed: true, failMessage: e.message })
      })
  },

  openEvent: function (e) {
    wx.navigateTo({ url: '/pages/event-detail/event-detail?id=' + e.currentTarget.dataset.id })
  },

  createEvent: function () {
    wx.navigateTo({ url: '/pages/event-edit/event-edit' })
  },
})

function decorate (e) {
  const expired = fmt.isSignupExpired(e)
  const full = e.remaining <= 0
  return Object.assign({}, e, {
    timeText: fmt.formatRange(e.startTime, e.endTime),
    statusText: fmt.statusText(e.status),
    statusClass: 'tag-' + e.status,
    // 报名中但已截止或已满，要给出明确原因，否则用户点进去才知道报不了。
    hintText: e.status !== 'open' ? ''
      : full ? '名额已满'
        : expired ? '报名已截止' : '',
    countText: e.signupCount + '/' + e.capacity + ' 人',
    pastClass: fmt.isPast(e) ? 'card-past' : '',
  })
}
