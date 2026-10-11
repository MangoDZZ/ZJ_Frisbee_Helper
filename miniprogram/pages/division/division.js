'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const divider = require('../../utils/divide.js')

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    event: null,
    isOwner: false,
    division: null,
    teams: [],
    metaText: '',
    qualityText: '',
    warnings: [],
    // 手动换人：先点一个人选中，再点另一队的人交换
    selectedId: '',
    selectedName: '',
    conflictText: '',
    busy: false,
  },

  onLoad: function (q) {
    this.setData({ eventId: q.eventId || '', autoRun: q.run === '1' })
    this.boot()
  },

  onShareAppMessage: function () {
    const e = this.data.event
    return {
      title: e ? e.name + ' 分队结果' : '飞盘 HAT 分队结果',
      path: '/pages/division/division?eventId=' + this.data.eventId,
    }
  },

  boot: function () {
    const that = this
    return api.event('detail', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({ event: d.event, isOwner: d.isOwner })
        if (!d.isOwner) return that.refresh()
        // 组织者需要名单和约束才能（重新）分队。
        return Promise.all([
          api.signup('listAll', { eventId: that.data.eventId }, { loading: false }),
          api.team('listConstraints', { eventId: that.data.eventId }, { loading: false }),
        ]).then(function (r) {
          const roster = r[0].list || []
          const cons = r[1].list || []
          const nameById = {}
          roster.forEach(function (s) { nameById[s._id] = s.name })
          that.setData({ roster: roster, cons: cons, nameById: nameById })
          if (that.data.autoRun) return that.compute()
          return that.refresh().then(function () {
            // 还没有任何分队记录时直接算一次，省掉一次多余的点击。
            if (!that.data.division) return that.compute()
          })
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  /** 从云端读取当前分队结果——服务端是唯一事实来源，显示的一定是存下来的。 */
  refresh: function () {
    const that = this
    return api.team('getDivision', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({ loading: false })
        if (!d.division) {
          that.setData({ division: null, teams: [] })
          return
        }
        that.render(d.division)
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  render: function (division) {
    const teams = (division.teams || []).map(function (t) {
      return {
        index: t.index,
        name: t.name,
        stats: t.stats,
        statsText: t.stats.count + '人 · ' + t.stats.male + '男' + t.stats.female + '女 · 均分' +
          t.stats.avgLevel + ' · 高分' + t.stats.star + '人',
        members: (t.members || []).map(function (m) {
          return {
            _id: m._id,
            name: m.name,
            level: m.level,
            genderClass: m.gender === 'F' ? 'dot-f' : m.gender === 'M' ? 'dot-m' : 'dot-u',
          }
        }),
      }
    })

    const spread = describeSpread(teams)
    this.setData({
      division: division,
      teams: teams,
      metaText: '第 ' + division.version + ' 版' +
        (division.published ? ' · 已发布' : ' · 未发布') +
        (division.seed ? ' · seed ' + division.seed : ''),
      qualityText: spread,
      selectedId: '',
      selectedName: '',
      conflictText: this.checkConflicts(teams),
    })
  },

  /** 在本机跑分队算法，然后存到云端。毫秒级，所以"重新分队"可以秒响应。 */
  compute: function () {
    const that = this
    const roster = this.data.roster || []
    const event = this.data.event
    if (roster.length < event.teamCount) {
      this.setData({
        loading: false,
        failMessage: '只有 ' + roster.length + ' 人报名，少于 ' + event.teamCount + ' 个队',
      })
      return Promise.resolve()
    }

    const players = roster.map(function (s) {
      return { id: s._id, name: s.name, gender: s.gender, level: s.level }
    })
    const cons = (this.data.cons || []).map(function (c) {
      return { type: c.type, ids: c.signupIds }
    })

    wx.showLoading({ title: '分队中', mask: true })
    const res = divider.divide(players, event.teamCount, cons)
    wx.hideLoading()

    if (!res.ok) {
      this.setData({ loading: false })
      wx.showModal({
        title: '无法完成分队',
        content: res.error.message,
        showCancel: false,
      })
      return Promise.resolve()
    }

    this.setData({ warnings: res.warnings || [], busy: true })
    return api.team('saveDivision', {
      eventId: this.data.eventId,
      seed: res.seed,
      teams: res.teams.map(function (t) {
        return { name: t.name, memberIds: t.memberIds }
      }),
    }, { loading: '保存中' })
      .then(function () {
        that.setData({ busy: false, autoRun: false })
        return that.refresh()
      })
      .catch(function () {
        that.setData({ busy: false, loading: false })
      })
  },

  reroll: function () {
    if (this.data.busy) return
    this.compute()
  },

  // ---------------- 手动换人 ----------------

  tapMember: function (e) {
    if (!this.data.isOwner) return
    const id = e.currentTarget.dataset.id
    const teamIndex = Number(e.currentTarget.dataset.team)

    if (!this.data.selectedId) {
      this.setData({
        selectedId: id,
        selectedName: this.data.nameById[id] || '',
        selectedTeam: teamIndex,
      })
      return
    }
    if (this.data.selectedId === id) {
      this.setData({ selectedId: '', selectedName: '' })
      return
    }
    if (this.data.selectedTeam === teamIndex) {
      // 同队内互换没有意义，改成把选中目标切到新点的人。
      this.setData({ selectedId: id, selectedName: this.data.nameById[id] || '' })
      return
    }
    this.swap(this.data.selectedId, id)
  },

  swap: function (idA, idB) {
    const teams = JSON.parse(JSON.stringify(this.data.teams))
    let posA = null; let posB = null
    for (let i = 0; i < teams.length; i++) {
      for (let j = 0; j < teams[i].members.length; j++) {
        if (teams[i].members[j]._id === idA) posA = { t: i, m: j }
        if (teams[i].members[j]._id === idB) posB = { t: i, m: j }
      }
    }
    if (!posA || !posB) return

    const tmp = teams[posA.t].members[posA.m]
    teams[posA.t].members[posA.m] = teams[posB.t].members[posB.m]
    teams[posB.t].members[posB.m] = tmp

    const conflict = this.checkConflicts(teams)
    const that = this
    const doSave = function () {
      that.setData({ busy: true })
      api.team('saveDivision', {
        eventId: that.data.eventId,
        seed: that.data.division ? that.data.division.seed : null,
        teams: teams.map(function (t) {
          return {
            name: t.name,
            memberIds: t.members.map(function (m) { return m._id }),
          }
        }),
      }, { loading: '保存中' })
        .then(function () {
          that.setData({ busy: false })
          return that.refresh()
        })
        .catch(function () { that.setData({ busy: false }) })
    }

    // 换人可能破坏约束。组织者有最终话语权，所以只提示、不阻止。
    if (conflict) {
      wx.showModal({
        title: '这样换会破坏约束',
        content: conflict + '\n\n仍要这样换吗？',
        confirmText: '仍然交换',
        success: function (r) {
          if (r.confirm) doSave()
          else that.setData({ selectedId: '', selectedName: '' })
        },
      })
      return
    }
    doSave()
  },

  clearSelection: function () {
    this.setData({ selectedId: '', selectedName: '' })
  },

  /** 按当前约束检查一份名单，返回人话描述的冲突，没有冲突返回空串。 */
  checkConflicts: function (teams) {
    const cons = this.data.cons || []
    if (cons.length === 0) return ''
    const nameById = this.data.nameById || {}
    const teamOf = {}
    for (let i = 0; i < teams.length; i++) {
      for (let j = 0; j < teams[i].members.length; j++) {
        teamOf[teams[i].members[j]._id] = i
      }
    }

    const msgs = []
    for (let c = 0; c < cons.length; c++) {
      const ids = cons[c].signupIds || []
      const names = ids.map(function (id) { return nameById[id] || '?' }).join('、')
      if (cons[c].type === 'together') {
        for (let i = 1; i < ids.length; i++) {
          if (teamOf[ids[i]] !== teamOf[ids[0]]) {
            msgs.push(names + ' 应当同队')
            break
          }
        }
      } else {
        let hit = false
        for (let i = 0; i < ids.length && !hit; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            if (teamOf[ids[i]] === teamOf[ids[j]]) {
              msgs.push(names + ' 应当拆开')
              hit = true
              break
            }
          }
        }
      }
    }
    return msgs.join('；')
  },

  // ---------------- 发布 ----------------

  publish: function () {
    const that = this
    api.team('publish', {
      eventId: this.data.eventId,
      divisionId: this.data.division._id,
    }, { loading: '发布中' })
      .then(function () {
        wx.showToast({ title: '已发布', icon: 'success' })
        return that.refresh()
      })
      .catch(function () {})
  },

  unpublish: function () {
    const that = this
    wx.showModal({
      title: '撤销发布',
      content: '参与者将看不到分队结果，活动回到「报名关闭」状态。',
      success: function (r) {
        if (!r.confirm) return
        api.team('unpublish', { eventId: that.data.eventId }, { loading: '处理中' })
          .then(function () { return that.refresh() })
          .catch(function () {})
      },
    })
  },
})

/** 把三个极差翻成组织者看得懂的一句话——他们靠这个判断分队是否公平。 */
function describeSpread (teams) {
  if (teams.length === 0) return ''
  let sizeMin = Infinity; let sizeMax = -Infinity
  let fMin = Infinity; let fMax = -Infinity
  let aMin = Infinity; let aMax = -Infinity
  for (let i = 0; i < teams.length; i++) {
    const s = teams[i].stats
    if (s.count < sizeMin) sizeMin = s.count
    if (s.count > sizeMax) sizeMax = s.count
    if (s.female < fMin) fMin = s.female
    if (s.female > fMax) fMax = s.female
    if (s.count > 0) {
      if (s.avgLevel < aMin) aMin = s.avgLevel
      if (s.avgLevel > aMax) aMax = s.avgLevel
    }
  }
  const avgGap = aMax >= aMin ? Math.round((aMax - aMin) * 100) / 100 : 0
  return '人数相差 ' + (sizeMax - sizeMin) + ' · 女生相差 ' + (fMax - fMin) +
    ' · 队均水平相差 ' + avgGap
}
