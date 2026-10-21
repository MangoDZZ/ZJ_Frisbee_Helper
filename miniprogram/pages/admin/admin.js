'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const config = require('../../config.js')

Page({
  data: {
    loading: true,
    failMessage: '',
    list: [],
    organizerCount: 0,
    canEditRoles: false,
    adminOpenid: '',
    myOpenid: '',
    // 后台唯一能确认"线上是哪一版"的地方，排查问题时先让对方报这个
    version: config.VERSION,
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
            metaText: u.noSignup
              ? '没有报名记录 · 仅持有角色'
              : '报名过 ' + u.signupCount + ' 次 · 最近 ' + fmt.formatDateTime(u.lastSignupTime),
            roleText: u.isAdmin ? '管理员' : u.isOrganizer ? '组织者' : '',
            roleClass: u.isAdmin ? 'tag-mine' : u.isOrganizer ? 'tag-divided' : '',
          })
        })
        const admins = d.adminOpenids || []
        that.setData({
          loading: false,
          failMessage: '',
          list: list,
          organizerCount: list.filter(function (u) { return u.isOrganizer }).length,
          canEditRoles: !!d.canEditRoles,
          // 同一时间只有一个管理员，取第一个展示就够了
          adminOpenid: admins[0] || '',
          myOpenid: d.myOpenid || '',
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  /** 点某人 → 选要做什么。组织者身份可增可减，移交管理员是单独一条路。 */
  tapUser: function (e) {
    if (!this.data.canEditRoles) return
    const u = this.data.list[e.currentTarget.dataset.index]
    if (u.isAdmin) {
      wx.showToast({ title: '这是当前管理员', icon: 'none' })
      return
    }

    const that = this
    // 没有报名记录的人不能接手管理员（移交时会校验目标必须有真实报名记录），
    // 所以这种情况下不给他这一项，免得点了才报错。
    const items = [u.isOrganizer ? '取消组织者身份' : '设为组织者']
    if (!u.noSignup) items.push('移交管理员身份给他')

    wx.showActionSheet({
      itemList: items,
      success: function (r) {
        if (r.tapIndex === 0) that.setOrganizer(u, !u.isOrganizer)
        else if (r.tapIndex === 1) that.transferAdmin(u)
      },
      fail: function () {},
    })
  },

  setOrganizer: function (u, on) {
    const that = this
    wx.showModal({
      title: on ? '设为组织者' : '取消组织者',
      content: on
        ? '「' + u.name + '」将可以发起活动，并管理所有活动的报名、赛前检录、分队、战绩和积分。'
        : '「' + u.name + '」将不能再发起活动，也不能管理别人的活动。',
      success: function (r) {
        if (!r.confirm) return
        api.admin('setOrganizer', {
          openid: u.openid,
          name: u.name,
          isOrganizer: on,
        }, { loading: '保存中' })
          .then(function () { return that.load() })
          .catch(function () {})
      },
    })
  },

  /**
   * 移交管理员身份。这是不可撤销的自我降级，所以文案要把后果说全：
   * 移交完成后自己连"再交回来"的权限都没有了（初始管理员名单此时已失效）。
   */
  transferAdmin: function (u) {
    const that = this
    wx.showModal({
      title: '移交管理员身份',
      content: '管理员身份将转移给「' + u.name + '」，你自己会立刻失去后台管理和改角色的' +
        '权限，而且无法自己拿回来。确定移交吗？',
      confirmText: '确认移交',
      confirmColor: '#d94a4a',
      success: function (r) {
        if (!r.confirm) return
        api.admin('transferAdmin', {
          openid: u.openid,
          name: u.name,
        }, { loading: '移交中' })
          .then(function () {
            wx.showToast({ title: '已移交', icon: 'success' })
            return that.load()
          })
          .catch(function () { that.load() })
      },
    })
  },

  copyAdminOpenid: function () {
    if (!this.data.adminOpenid) return
    wx.setClipboardData({ data: this.data.adminOpenid })
  },
})
