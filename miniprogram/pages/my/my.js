'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    loading: true,
    failMessage: '',
    signups: [],
    owned: [],
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load().then(function () { wx.stopPullDownRefresh() })
  },

  load: function () {
    const that = this
    return Promise.all([
      api.signup('mine', {}, { loading: false, toastError: false }),
      api.event('list', { scope: 'mine' }, { loading: false, toastError: false }),
    ]).then(function (r) {
      that.setData({
        loading: false,
        failMessage: '',
        signups: (r[0].list || []).map(function (s) {
          return {
            _id: s._id,
            eventId: s.eventId,
            eventName: s.event.name,
            timeText: fmt.formatRange(s.event.startTime),
            location: s.event.location,
            statusText: fmt.statusText(s.event.status),
            statusClass: 'tag-' + s.event.status,
            meText: s.name + ' · ' + fmt.genderText(s.gender) + ' · ' + fmt.levelText(s.selfLevel),
          }
        }),
        owned: (r[1].list || []).map(function (e) {
          return {
            _id: e._id,
            name: e.name,
            timeText: fmt.formatRange(e.startTime, e.endTime),
            statusText: fmt.statusText(e.status),
            statusClass: 'tag-' + e.status,
            countText: e.signupCount + '/' + e.capacity + ' 人',
          }
        }),
      })
    }).catch(function (e) {
      that.setData({ loading: false, failMessage: e.message })
    })
  },

  openEvent: function (e) {
    wx.navigateTo({ url: '/pages/event-detail/event-detail?id=' + e.currentTarget.dataset.id })
  },

  goManage: function (e) {
    wx.navigateTo({ url: '/pages/manage/manage?eventId=' + e.currentTarget.dataset.id })
  },

  createEvent: function () {
    wx.navigateTo({ url: '/pages/event-edit/event-edit' })
  },
})
