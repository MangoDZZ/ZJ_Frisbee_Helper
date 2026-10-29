'use strict'

const api = require('../../utils/api.js')
const eventConfig = require('../../utils/event-config.js')
const fmt = require('../../utils/format.js')
const signupFields = require('../../utils/signup-fields.js')

/** 类型说明：选不同的类型时下面的提示跟着换，免得建错了才发现。 */
const TYPE_HINTS = {
  personal: '个人积分赛：可以开多场赛事、每场各自分队，名次按个人积分排。',
  classic: '经典 HAT：一个活动只分一次队、只有一个赛事，名次按队伍胜负排。',
}

Page({
  data: {
    eventId: '',
    editing: false,
    submitting: false,
    fieldRows: signupFields.configRows(null),
    typeOptions: Object.keys(eventConfig.TYPES).map(function (k) {
      return { key: k, label: eventConfig.TYPES[k] }
    }),
    typeHint: TYPE_HINTS[eventConfig.TYPE_PERSONAL],
    form: {
      // 活动类型只在新建时可选，之后不可改（见云函数 hat-event 的 update）
      type: eventConfig.TYPE_PERSONAL,
      name: '',
      location: '',
      startDate: '',
      startTime: '',
      endDate: '',
      endTime: '',
      deadlineDate: '',
      deadlineTime: '',
      teamCount: '4',
      capacity: '24',
      notes: '',
      // 「仅限群聊转发可见」：勾上后活动不进公开列表，只能凭分享链接进入
      groupOnly: false,
    },
  },

  onLoad: function (q) {
    const that = this
    if (!q.eventId) {
      // 新建时给个合理默认：下周六 19:00-21:00。
      // 结束日期故意留空：留空就按开始当天算，这样改了开始日期也不会把结束时间带偏；
      // 只有跨天的活动才需要显式选结束日期。
      const d = new Date()
      d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7))
      const s = fmt.splitTimestamp(d.getTime())
      this.setData({
        'form.startDate': s.date,
        'form.startTime': '19:00',
        'form.endTime': '21:00',
      })
      return
    }

    this.setData({ eventId: q.eventId, editing: true })
    wx.setNavigationBarTitle({ title: '编辑活动' })
    api.event('detail', { eventId: q.eventId }, { loading: '加载中' })
      .then(function (d) {
        const e = d.event
        const s = fmt.splitTimestamp(e.startTime)
        const en = fmt.splitTimestamp(e.endTime)
        const dl = fmt.splitTimestamp(e.signupDeadline)
        that.setData({
          fieldRows: signupFields.configRows(e.signupFields),
          form: {
            name: e.name,
            location: e.location || '',
            startDate: s.date,
            startTime: s.time,
            endDate: en.date,
            endTime: en.time,
            deadlineDate: dl.date,
            deadlineTime: dl.time,
            teamCount: String(e.teamCount),
            capacity: String(e.capacity),
            notes: e.notes || '',
            groupOnly: !!e.groupOnly,
          },
        })
      })
      .catch(function () {})
  },

  onInput: function (e) {
    const patch = {}
    patch['form.' + e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  clearDeadline: function () {
    this.setData({ 'form.deadlineDate': '', 'form.deadlineTime': '' })
  },

  clearEnd: function () {
    this.setData({ 'form.endDate': '', 'form.endTime': '' })
  },

  /** 勾选「仅限群聊转发可见」。 */
  toggleGroupOnly: function (e) {
    this.setData({ 'form.groupOnly': !!e.detail.value })
  },

  /** 选活动类型（只在新建时可见）。 */
  pickType: function (e) {
    const type = e.currentTarget.dataset.type
    if (!eventConfig.TYPES[type]) return
    this.setData({
      'form.type': type,
      typeHint: TYPE_HINTS[type] || '',
    })
  },

  /**
   * 报名表字段的两个开关：采集 / 必填。
   *
   * 「必填」只在采集时才有意义，所以关掉采集时顺手把必填一起关掉——否则会留下
   * 一个"不采集但必填"的矛盾配置，用户下次打开会看到两个都亮着的开关。
   */
  toggleField: function (e) {
    const key = e.currentTarget.dataset.key
    const prop = e.currentTarget.dataset.prop
    const on = !!e.detail.value
    const rows = this.data.fieldRows.map(function (r) {
      if (r.key !== key) return r
      const next = Object.assign({}, r)
      next[prop] = on
      if (prop === 'enabled' && !on) next.required = false
      return next
    })
    this.setData({ fieldRows: rows })
  },

  submit: function () {
    const f = this.data.form

    if (!f.name.trim()) return warn('请填写活动名称')
    if (!f.startDate || !f.startTime) return warn('请选择开始时间')

    const teamCount = Number(f.teamCount)
    const capacity = Number(f.capacity)
    if (!(teamCount >= 2 && teamCount <= 20 && Math.floor(teamCount) === teamCount)) {
      return warn('队伍数需要是 2 到 20 之间的整数')
    }
    if (!(capacity >= teamCount && capacity <= 500 && Math.floor(capacity) === capacity)) {
      return warn('人数上限不能少于队伍数，且不超过 500')
    }

    const startTime = fmt.toTimestamp(f.startDate, f.startTime)
    // 结束时间可选，且**可以跨天**：选了结束日期就按它算，没选就按开始当天算
    // （同一天的短活动不用特意再选一次日期）。只填了日期没填时分，按当天 23:59 算。
    const endTime = (f.endDate || f.endTime)
      ? fmt.toTimestamp(f.endDate || f.startDate, f.endTime || '23:59')
      : null
    if (endTime && endTime < startTime) return warn('结束时间不能早于开始时间')

    const signupDeadline = f.deadlineDate
      ? fmt.toTimestamp(f.deadlineDate, f.deadlineTime || '23:59')
      : null
    if (signupDeadline && signupDeadline > startTime) {
      return warn('报名截止时间不能晚于活动开始时间')
    }

    const payload = {
      eventId: this.data.eventId,
      name: f.name,
      location: f.location,
      notes: f.notes,
      teamCount: teamCount,
      capacity: capacity,
      startTime: startTime,
      endTime: endTime,
      signupDeadline: signupDeadline,
      // 报名表采集哪些字段 + 活动可见性
      signupFields: this.collectSignupFields(),
      visibility: f.groupOnly ? 'group' : 'public',
    }
    // 类型只在新建时提交：编辑页不显示这个选择器，云函数也不会改它
    if (!this.data.editing) payload.type = f.type

    const that = this
    this.setData({ submitting: true })
    api.event(this.data.editing ? 'update' : 'create', payload, { loading: '保存中' })
      .then(function (d) {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(function () {
          if (that.data.editing) {
            wx.navigateBack()
          } else {
            // 新建后直接进详情页，方便马上转发到群里。
            wx.redirectTo({ url: '/pages/event-detail/event-detail?id=' + d._id })
          }
        }, 700)
      })
      .catch(function () {
        that.setData({ submitting: false })
      })
  },

  /** fieldRows → 服务端要的 { [key]: { enabled, required } }。 */
  collectSignupFields: function () {
    const out = {}
    this.data.fieldRows.forEach(function (r) {
      out[r.key] = { enabled: !!r.enabled, required: !!(r.enabled && r.required) }
    })
    return out
  },

  removeEvent: function () {
    const that = this
    wx.showModal({
      title: '删除活动',
      content: '会同时删掉这场活动的所有报名、约束和分队记录，无法恢复。确定吗？',
      confirmText: '删除',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        api.event('remove', { eventId: that.data.eventId }, { loading: '删除中' })
          .then(function () {
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(function () {
              // 详情页已经失效，退回列表。
              wx.reLaunch({ url: '/pages/index/index' })
            }, 700)
          })
          .catch(function () {})
      },
    })
  },
})

function warn (msg) {
  wx.showToast({ title: msg, icon: 'none' })
}
