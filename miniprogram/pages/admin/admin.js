'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    loading: true,
    failMessage: '',
    list: [],
    scorerCount: 0,
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    this.load().then(function () { wx.stopPullDownRefresh() })
  },

  load: function () {
    const that = this
    return api.admin('listUsers', {}, { loading: false, toastError: false })
      .then(function (d) {
        const list = (d.list || []).map(function (u) {
          return Object.assign({}, u, {
            genderText: fmt.genderText(u.gender),
            metaText: '报名过 ' + u.signupCount + ' 次 · 最近 ' +
              fmt.formatDateTime(u.lastSignupTime),
            roleText: u.isAdmin ? '管理员' : u.isScorer ? '记分员' : '',
            roleClass: u.isAdmin ? 'tag-mine' : u.isScorer ? 'tag-divided' : '',
          })
        })
        that.setData({
          loading: false,
          failMessage: '',
          list: list,
          scorerCount: list.filter(function (u) { return u.isScorer && !u.isAdmin }).length,
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  toggleScorer: function (e) {
    const u = this.data.list[e.currentTarget.dataset.index]
    if (u.isAdmin) {
      wx.showToast({ title: '管理员本来就能录战绩', icon: 'none' })
      return
    }
    const that = this
    const turnOn = !u.isScorer
    wx.showModal({
      title: turnOn ? '设为记分员' : '取消记分员',
      content: turnOn
        ? '「' + u.name + '」将可以为所有活动录入比赛战绩。'
        : '「' + u.name + '」将不能再录入战绩。',
      success: function (r) {
        if (!r.confirm) return
        api.admin('setScorer', {
          openid: u.openid,
          name: u.name,
          isScorer: turnOn,
        }, { loading: '保存中' })
          .then(function () { return that.load() })
          .catch(function () {})
      },
    })
  },
})
