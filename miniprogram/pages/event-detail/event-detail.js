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
    canManage: false,
    mySignup: null,
    tournaments: [],
    timeText: '',
    deadlineText: '',
    statusText: '',
    statusClass: '',
    myLevelText: '',
    myGenderText: '',
    canSignup: false,
    blockReason: '',
    // 按钮上用的短文案（v1.0.2：部分机型上长文案会换行，尽量控制在 4 个汉字内）
    blockText: '',
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
          isOwner: !!d.isOwner,
          canManage: !!d.canManage,
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
          // 按钮文案要短：'报名已截止' 在窄屏上会折行
          blockText: e.status !== 'open' ? fmt.statusText(e.status)
            : expired ? '已截止'
              : full ? '名额已满' : '',
        })
        return that.loadTournaments()
      })
      .catch(function (err) {
        that.setData({ loading: false, failMessage: err.message })
      })
  },

  /** 赛事列表单独取，失败就静默留空（比如还没开赛）。 */
  loadTournaments: function () {
    const that = this
    return api.team('listTournaments', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({ tournaments: d.list || [] })
      })
      .catch(function () {
        that.setData({ tournaments: [] })
      })
  },

  goSignup: function () {
    wx.navigateTo({ url: '/pages/signup-form/signup-form?eventId=' + this.data.eventId })
  },

  goManage: function () {
    wx.navigateTo({ url: '/pages/manage/manage?eventId=' + this.data.eventId })
  },

  goTournaments: function () {
    wx.navigateTo({ url: '/pages/tournaments/tournaments?eventId=' + this.data.eventId })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },

  goStats: function () {
    wx.navigateTo({ url: '/pages/stats/stats?eventId=' + this.data.eventId })
  },

  goMyStats: function () {
    wx.navigateTo({ url: '/pages/my-stats/my-stats?eventId=' + this.data.eventId })
  },

  goRandomEvents: function () {
    wx.navigateTo({ url: '/pages/random-events/random-events?eventId=' + this.data.eventId })
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
