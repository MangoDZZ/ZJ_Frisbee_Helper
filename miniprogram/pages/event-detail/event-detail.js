'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    event: null,
    isOwner: false,
    mySignup: null,
    division: null,
    timeText: '',
    deadlineText: '',
    statusText: '',
    statusClass: '',
    myLevelText: '',
    myGenderText: '',
    canSignup: false,
    blockReason: '',
  },

  onLoad: function (q) {
    this.setData({ eventId: q.id || '' })
  },

  onShow: function () {
    if (this.data.eventId) this.load()
  },

  onShareAppMessage: function () {
    const e = this.data.event
    return {
      title: e ? e.name + '｜' + this.data.timeText : '飞盘 HAT 活动',
      path: '/pages/event-detail/event-detail?id=' + this.data.eventId,
    }
  },

  load: function () {
    const that = this
    return api.event('detail', { eventId: this.data.eventId }, { loading: false, toastError: false })
      .then(function (d) {
        const e = d.event
        const expired = fmt.isSignupExpired(e)
        const full = e.remaining <= 0
        that.setData({
          loading: false,
          failMessage: '',
          event: e,
          isOwner: d.isOwner,
          mySignup: d.mySignup,
          timeText: fmt.formatRange(e.startTime, e.endTime),
          deadlineText: e.signupDeadline ? fmt.formatFullDateTime(e.signupDeadline) : '',
          statusText: fmt.statusText(e.status),
          statusClass: 'tag-' + e.status,
          myLevelText: d.mySignup ? fmt.levelText(d.mySignup.selfLevel) : '',
          myGenderText: d.mySignup ? fmt.genderText(d.mySignup.gender) : '',
          canSignup: e.status === 'open' && !expired && (!full || !!d.mySignup),
          blockReason: e.status !== 'open' ? fmt.statusText(e.status)
            : expired ? '报名已截止'
              : full ? '名额已满' : '',
        })
        return that.loadDivision()
      })
      .catch(function (err) {
        that.setData({ loading: false, failMessage: err.message })
      })
  },

  /** 分队结果单独取：参与者只看得到已发布的版本，没有就静默留空。 */
  loadDivision: function () {
    const that = this
    return api.team('getDivision', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({ division: d.division })
      })
      .catch(function () {
        that.setData({ division: null })
      })
  },

  goSignup: function () {
    wx.navigateTo({ url: '/pages/signup-form/signup-form?eventId=' + this.data.eventId })
  },

  goManage: function () {
    wx.navigateTo({ url: '/pages/manage/manage?eventId=' + this.data.eventId })
  },

  goDivision: function () {
    wx.navigateTo({ url: '/pages/division/division?eventId=' + this.data.eventId })
  },

  goMatches: function () {
    wx.navigateTo({ url: '/pages/matches/matches?eventId=' + this.data.eventId })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },

  cancelSignup: function () {
    const that = this
    wx.showModal({
      title: '取消报名',
      content: '确定要取消报名吗？名额会释放给其他人。',
      confirmText: '取消报名',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        api.signup('cancel', { eventId: that.data.eventId }, { loading: '处理中' })
          .then(function () {
            wx.showToast({ title: '已取消报名', icon: 'success' })
            that.load()
          })
          .catch(function () {})
      },
    })
  },
})
