'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    list: [],
    loading: true,
    failed: false,
    scope: 'all',
    canCreateEvent: false,
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
    return Promise.all([
      api.event('list', { scope: this.data.scope }, { loading: false, toastError: false }),
      // whoami 只用来决定「创建活动」入口显不显示，真正的拦截在云函数里
      api.admin('whoami', {}, { loading: false, toastError: false })
        .catch(function () { return { canCreateEvent: false } }),
    ]).then(function (r) {
      that.setData({
        list: (r[0].list || []).map(decorate),
        canCreateEvent: !!(r[1] && r[1].canCreateEvent),
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

  goManage: function (e) {
    wx.navigateTo({ url: '/pages/manage/manage?eventId=' + e.currentTarget.dataset.id })
  },

  createEvent: function () {
    wx.navigateTo({ url: '/pages/event-edit/event-edit' })
  },
})

function decorate (e) {
  // 状态泡泡只取一个：报名中但已截止/已满足额时，不能再并排挂一个"报名中"
  const state = fmt.eventState(e)
  return Object.assign({}, e, {
    timeText: fmt.formatRange(e.startTime, e.endTime),
    stateText: state.text,
    stateClass: state.className,
    countText: e.signupCount + '/' + e.capacity + ' 人',
    pastClass: fmt.isPast(e) ? 'card-past' : '',
  })
}
