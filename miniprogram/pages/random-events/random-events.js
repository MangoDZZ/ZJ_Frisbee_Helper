'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

/**
 * 随机事件（活动级）。组织者/管理员用。
 *
 * 玩法：先把一批随机事件写进池子（说明 + 触发名单 + 效果），比赛时点「抽取」，
 * 服务端从池子里随机抽一个，效果立刻作用到它自己的触发名单上并计入积分榜。
 *
 * 抽中的事件**留在池子里**可以继续抽；每次抽取都留一条记录，可以撤销（积分随之回退）。
 */
const MAX_VALUE = 10

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    eventName: '',
    pool: [],              // 事件池
    draws: [],             // 已触发记录（新的在前）
    roster: [],            // 可以当触发对象的人
    nameById: {},

    // 添加事件的面板
    adding: false,
    formText: '',
    formSign: 'minus',     // 'plus' | 'minus'
    formValue: '1',
    pickedIds: [],
    pickedNames: '',
    submitting: false,
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
    // 事件池要管理权限；触发记录参与者也能看。两个都拿，缺一个不至于整页打不开。
    return api.match('listRandomEvents', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (pool) {
        return api.signup('listAll', { eventId: that.data.eventId },
          { loading: false, toastError: false })
          .then(function (signups) {
            return api.match('listDraws', { eventId: that.data.eventId },
              { loading: false, toastError: false })
              .then(function (draws) { return { pool: pool, signups: signups, draws: draws } })
              .catch(function () { return { pool: pool, signups: signups, draws: { list: [] } } })
          })
      })
      .then(function (r) {
        const nameById = {}
        const roster = (r.signups.list || []).map(function (s) {
          nameById[s._id] = s.name
          return { _id: s._id, name: s.name, genderText: fmt.genderText(s.gender) }
        })
        that.setData({
          loading: false,
          failMessage: '',
          eventName: r.pool.eventName,
          nameById: nameById,
          roster: roster,
          pool: (r.pool.list || []).map(decorate),
          draws: (r.draws.list || []).map(function (x) {
            return Object.assign(decorate(x), { timeText: fmt.formatDateTime(x.createTime) })
          }),
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  // ---------------------------------------------------------------- 抽取

  draw: function () {
    if (this.data.pool.length === 0) {
      wx.showToast({ title: '先添加至少一个随机事件', icon: 'none' })
      return
    }
    const that = this
    api.match('drawRandomEvent', { eventId: this.data.eventId }, { loading: '抽取中' })
      .then(function (d) {
        // 抽中的结果直接弹出来，现场看效果
        wx.showModal({
          title: '抽到了：' + deltaText(d.draw.delta) + ' 分',
          content: d.draw.text + '\n\n' + d.draw.names.join('、'),
          showCancel: false,
          confirmText: '知道了',
        })
        return that.load()
      })
      .catch(function () {})
  },

  undoDraw: function (e) {
    const that = this
    const row = this.data.draws[Number(e.currentTarget.dataset.index)]
    wx.showModal({
      title: '撤销这次抽取',
      content: '「' + row.text + '」对 ' + row.namesText + ' 的 ' + row.deltaText +
        ' 分会一并从积分榜上撤掉。确定吗？',
      confirmText: '撤销',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        api.match('removeDraw', { eventId: that.data.eventId, drawId: row._id },
          { loading: '撤销中' })
          .then(function () { return that.load() })
          .catch(function () {})
      },
    })
  },

  // ---------------------------------------------------------------- 事件池

  startAdd: function () {
    this.setData({
      adding: true,
      formText: '',
      formSign: 'minus',
      formValue: '1',
      pickedIds: [],
      pickedNames: '',
    })
  },

  cancelAdd: function () {
    this.setData({ adding: false, pickedIds: [], pickedNames: '' })
  },

  onText: function (e) {
    this.setData({ formText: e.detail.value })
  },

  pickSign: function (e) {
    this.setData({ formSign: e.currentTarget.dataset.sign })
  },

  onValue: function (e) {
    this.setData({ formValue: e.detail.value })
  },

  togglePick: function (e) {
    const id = e.currentTarget.dataset.id
    const ids = this.data.pickedIds.slice()
    const at = ids.indexOf(id)
    if (at >= 0) ids.splice(at, 1)
    else ids.push(id)
    const nameById = this.data.nameById || {}
    this.setData({
      pickedIds: ids,
      pickedNames: ids.map(function (x) { return nameById[x] }).join('、'),
    })
  },

  confirmAdd: function () {
    const that = this
    const text = String(this.data.formText || '').trim()
    if (!text) {
      wx.showToast({ title: '请填写事件说明', icon: 'none' })
      return
    }
    // 效果用「方向 + 数值」两个控件拼出来，不依赖数字键盘上的负号（部分机型没有）
    const n = Number(this.data.formValue)
    if (!(n >= 1 && n <= MAX_VALUE && Math.floor(n) === n)) {
      wx.showToast({ title: '效果分值是 1 到 ' + MAX_VALUE + ' 的整数', icon: 'none' })
      return
    }
    if (this.data.pickedIds.length === 0) {
      wx.showToast({ title: '至少选 1 个触发的人', icon: 'none' })
      return
    }

    const next = poolPayload(this.data.pool)
    next.push({
      text: text,
      delta: this.data.formSign === 'plus' ? n : -n,
      signupIds: this.data.pickedIds.slice(),
    })

    // 覆盖式保存：整份提交，和约束一样不做增量，避免两边状态不一致
    this.setData({ submitting: true })
    api.match('setRandomEvents', { eventId: this.data.eventId, events: next },
      { loading: '保存中' })
      .then(function () {
        wx.showToast({ title: '已添加', icon: 'success' })
        that.setData({ adding: false, submitting: false, pickedIds: [], pickedNames: '' })
        return that.load()
      })
      .catch(function () {
        that.setData({ submitting: false })
      })
  },

  removePool: function (e) {
    const that = this
    const i = Number(e.currentTarget.dataset.index)
    const row = this.data.pool[i]
    wx.showModal({
      title: '删除事件',
      content: '把「' + row.text + '」从事件池里删掉？已经抽取过的记录不受影响。',
      confirmText: '删除',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        const next = poolPayload(that.data.pool.filter(function (x, idx) { return idx !== i }))
        api.match('setRandomEvents', { eventId: that.data.eventId, events: next },
          { loading: '保存中' })
          .then(function () { return that.load() })
          .catch(function () {})
      },
    })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },
})

/** 页面上的行 → 提交给云函数的形状（去掉渲染用的字段） */
function poolPayload (list) {
  return (list || []).map(function (x) {
    return { text: x.text, delta: x.delta, signupIds: x.signupIds }
  })
}

function decorate (x) {
  return Object.assign({}, x, {
    deltaText: deltaText(x.delta),
    deltaClass: x.delta > 0 ? 'delta-plus' : 'delta-minus',
    namesText: (x.names || []).join('、'),
  })
}

function deltaText (delta) {
  return (delta > 0 ? '+' : '') + delta
}
