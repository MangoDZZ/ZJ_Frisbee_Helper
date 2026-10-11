'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

const LEVEL_SHEET = ['1 新手', '2 入门', '3 一般', '4 熟练', '5 高手', '恢复为自评水平']

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    event: null,
    statusText: '',
    roster: [],
    constraints: [],
    summary: '',
    levelBars: [],
    // 添加约束的选人面板
    picking: false,
    pickType: 'together',
    pickTypeText: '',
    pickedIds: [],
    pickedNames: '',
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
    return api.event('detail', { eventId: this.data.eventId }, { loading: false, toastError: false })
      .then(function (d) {
        that.setData({ event: d.event, statusText: fmt.statusText(d.event.status) })
        if (!d.isOwner) {
          // 正常不会走到这（入口只对创建者显示），但直接改 URL 也进不来。
          that.setData({ loading: false, failMessage: '只有活动创建者可以打开管理台' })
          return null
        }
        return Promise.all([
          api.signup('listAll', { eventId: that.data.eventId }, { loading: false }),
          api.team('listConstraints', { eventId: that.data.eventId }, { loading: false }),
        ]).then(function (r) {
          that.applyData(r[0].list || [], r[1].list || [])
          that.setData({ loading: false, failMessage: '' })
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  applyData: function (roster, constraints) {
    const nameById = {}
    const decorated = roster.map(function (s, i) {
      nameById[s._id] = s.name
      return Object.assign({}, s, {
        seq: i + 1,
        genderText: fmt.genderText(s.gender),
        levelText: fmt.levelText(s.level),
        overridden: s.adminLevel != null,
      })
    })

    let male = 0; let female = 0
    const buckets = [0, 0, 0, 0, 0]
    decorated.forEach(function (s) {
      if (s.gender === 'M') male++
      else if (s.gender === 'F') female++
      if (s.level >= 1 && s.level <= 5) buckets[s.level - 1]++
    })
    const max = Math.max.apply(null, buckets.concat([1]))
    const levelBars = buckets.map(function (n, i) {
      return { level: i + 1, count: n, percent: Math.round((n / max) * 100) }
    })

    this.setData({
      roster: decorated,
      nameById: nameById,
      constraints: constraints.map(function (c) {
        return {
          _id: c._id,
          type: c.type,
          typeText: c.type === 'together' ? '必须同队' : '必须拆开',
          signupIds: c.signupIds,
          names: c.signupIds.map(function (id) { return nameById[id] || '(已退出)' }).join('、'),
        }
      }),
      summary: decorated.length + ' 人报名 · ' + male + ' 男 ' + female + ' 女',
      levelBars: levelBars,
    })
  },

  // ---------------- 水平覆盖 ----------------

  editLevel: function (e) {
    const that = this
    const row = this.data.roster[e.currentTarget.dataset.index]
    wx.showActionSheet({
      itemList: LEVEL_SHEET,
      success: function (r) {
        const adminLevel = r.tapIndex === 5 ? null : r.tapIndex + 1
        api.signup('updateLevel', {
          eventId: that.data.eventId,
          signupId: row._id,
          adminLevel: adminLevel,
        }, { loading: '保存中' })
          .then(function () { that.load() })
          .catch(function () {})
      },
    })
  },

  // ---------------- 约束 ----------------

  startPick: function (e) {
    const type = e.currentTarget.dataset.type
    this.setData({
      picking: true,
      pickType: type,
      pickTypeText: type === 'together' ? '必须同队' : '必须拆开',
      pickedIds: [],
      pickedNames: '',
    })
  },

  cancelPick: function () {
    this.setData({ picking: false, pickedIds: [], pickedNames: '' })
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

  confirmPick: function () {
    if (this.data.pickedIds.length < 2) {
      wx.showToast({ title: '至少选 2 个人', icon: 'none' })
      return
    }
    const next = this.data.constraints.map(function (c) {
      return { type: c.type, signupIds: c.signupIds }
    })
    next.push({ type: this.data.pickType, signupIds: this.data.pickedIds })
    this.saveConstraints(next, '已添加约束')
  },

  removeConstraint: function (e) {
    const idx = e.currentTarget.dataset.index
    const that = this
    wx.showModal({
      title: '删除约束',
      content: '删除「' + this.data.constraints[idx].names + '」这条约束？',
      success: function (r) {
        if (!r.confirm) return
        const next = that.data.constraints
          .filter(function (c, i) { return i !== idx })
          .map(function (c) { return { type: c.type, signupIds: c.signupIds } })
        that.saveConstraints(next, '已删除')
      },
    })
  },

  /** 约束是覆盖式保存：整份提交，不做增量，避免两边状态不一致。 */
  saveConstraints: function (list, toast) {
    const that = this
    api.team('setConstraints', {
      eventId: this.data.eventId,
      constraints: list,
    }, { loading: '保存中' })
      .then(function () {
        wx.showToast({ title: toast, icon: 'success' })
        that.setData({ picking: false, pickedIds: [], pickedNames: '' })
        that.load()
      })
      .catch(function () {})
  },

  // ---------------- 报名开关与分队 ----------------

  toggleSignup: function () {
    const that = this
    const open = this.data.event.status === 'open'
    api.event(open ? 'closeSignup' : 'reopenSignup', { eventId: this.data.eventId },
      { loading: '处理中' })
      .then(function () { that.load() })
      .catch(function () {})
  },

  editEvent: function () {
    wx.navigateTo({ url: '/pages/event-edit/event-edit?eventId=' + this.data.eventId })
  },

  runDivision: function () {
    const e = this.data.event
    const n = this.data.roster.length
    if (n < e.teamCount) {
      wx.showModal({
        title: '人不够',
        content: '当前 ' + n + ' 人报名，少于 ' + e.teamCount + ' 个队，无法分队。',
        showCancel: false,
      })
      return
    }
    // 分队算法在分队结果页跑，那里同时承载"重新分队"和"手动换人"，
    // 不在两个页面各写一份调用。
    wx.navigateTo({
      url: '/pages/division/division?eventId=' + this.data.eventId + '&run=1',
    })
  },

  viewDivision: function () {
    wx.navigateTo({ url: '/pages/division/division?eventId=' + this.data.eventId })
  },
})
