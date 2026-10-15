'use strict'

const api = require('../../utils/api.js')

Page({
  data: {
    eventId: '',
    tournamentId: '',
    editing: false,
    loading: true,
    failMessage: '',
    submitting: false,
    lockedReason: '',

    name: '',
    teamCount: '4',
    roster: [],          // [{ _id, name, genderText, levelText, checked }]
    checkedCount: 0,
  },

  onLoad: function (q) {
    const that = this
    if (q.tournamentId) {
      this.setData({ tournamentId: q.tournamentId, editing: true })
      wx.setNavigationBarTitle({ title: '编辑赛事' })
      api.team('getTournament', { tournamentId: q.tournamentId },
        { loading: '加载中', toastError: false })
        .then(function (d) {
          that.setData({ eventId: d.eventId })
          return that.loadRoster(d.eventId, d.tournament.attendeeIds, {
            name: d.tournament.name,
            teamCount: String(d.tournament.teamCount),
            lockedReason: d.matchCount > 0
              ? '这场赛事已记录 ' + d.matchCount + ' 场比赛，改了赛前检录名单会让积分对不上。要改请先删掉比赛记录。'
              : '',
          })
        })
        .catch(function (e) {
          that.setData({ loading: false, failMessage: e.message })
        })
      return
    }

    this.setData({ eventId: q.eventId || '' })
    // 新建时默认全选报名名单，取消没来的人更快
    this.loadRoster(q.eventId, null, { name: '' })
      .then(function () {
        if (!that.data.name) that.setData({ name: '第 1 场' })
      })
  },

  /** checkedIds 为 null 表示全选 */
  loadRoster: function (eventId, checkedIds, extra) {
    const that = this
    return api.signup('listAll', { eventId: eventId }, { loading: false, toastError: false })
      .then(function (d) {
        const roster = (d.list || []).map(function (s) {
          return {
            _id: s._id,
            name: s.name,
            genderText: s.gender === 'F' ? '女' : '男',
            // 组织者看得到水平，这个页面本来就只有组织者能进
            levelText: String(s.level),
            checked: checkedIds === null ? true : checkedIds.indexOf(s._id) >= 0,
          }
        })
        that.setData(Object.assign({
          loading: false,
          failMessage: '',
          roster: roster,
          checkedCount: roster.filter(function (m) { return m.checked }).length,
        }, extra || {}))
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  onInput: function (e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  toggleMember: function (e) {
    if (this.data.lockedReason) {
      wx.showToast({ title: '已有比赛记录，不能改名单', icon: 'none' })
      return
    }
    const i = Number(e.currentTarget.dataset.index)
    const list = this.data.roster.slice()
    list[i] = Object.assign({}, list[i], { checked: !list[i].checked })
    this.setData({
      roster: list,
      checkedCount: list.filter(function (m) { return m.checked }).length,
    })
  },

  selectAll: function () {
    if (this.data.lockedReason) return
    const all = this.data.roster.every(function (m) { return m.checked })
    const list = this.data.roster.map(function (m) {
      return Object.assign({}, m, { checked: !all })
    })
    this.setData({
      roster: list,
      checkedCount: list.filter(function (m) { return m.checked }).length,
    })
  },

  submit: function () {
    const d = this.data
    const name = String(d.name || '').trim()
    if (!name) return warn('请填写赛事名称')

    const teamCount = Number(d.teamCount)
    if (!(teamCount >= 2 && teamCount <= 20 && Math.floor(teamCount) === teamCount)) {
      return warn('队伍数需要是 2 到 20 之间的整数')
    }

    const attendeeIds = d.roster.filter(function (m) { return m.checked })
      .map(function (m) { return m._id })
    if (attendeeIds.length < teamCount) {
      return warn('赛前检录 ' + attendeeIds.length + ' 人，少于 ' + teamCount + ' 个队')
    }

    const that = this
    this.setData({ submitting: true })
    const payload = {
      eventId: d.eventId,
      tournamentId: d.tournamentId,
      name: name,
      teamCount: teamCount,
      attendeeIds: attendeeIds,
    }
    api.team(d.editing ? 'updateTournament' : 'createTournament', payload,
      { loading: '保存中' })
      .then(function (res) {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(function () {
          if (that.data.editing) {
            wx.navigateBack()
          } else {
            // 新建完直接进分队页，省一次跳转
            wx.redirectTo({ url: '/pages/division/division?tournamentId=' + res._id })
          }
        }, 700)
      })
      .catch(function () {
        that.setData({ submitting: false })
      })
  },
})

function warn (msg) {
  wx.showToast({ title: msg, icon: 'none' })
}
