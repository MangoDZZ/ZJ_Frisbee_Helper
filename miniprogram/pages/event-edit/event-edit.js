'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    eventId: '',
    editing: false,
    submitting: false,
    form: {
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
    }

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
