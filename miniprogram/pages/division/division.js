'use strict'

const api = require('../../utils/api.js')
const divider = require('../../utils/divide.js')
const eventConfig = require('../../utils/event-config.js')
const share = require('../../utils/share.js')

Page({
  data: {
    tournamentId: '',
    eventId: '',
    loading: true,
    failMessage: '',
    tournamentName: '',
    isOrganizer: false,
    boardLabel: '积分榜',
    canSeeLevel: false,
    division: null,
    teams: [],
    metaText: '',
    qualityText: '',
    warnings: [],
    droppedConstraintText: '',
    // 手动换人：先点一个人选中，再点另一队的人交换
    selectedId: '',
    selectedName: '',
    conflictText: '',
    busy: false,
  },

  onLoad: function (q) {
    this.setData({ tournamentId: q.tournamentId || '', autoRun: q.run === '1' })
    this.boot()
  },

  /**
   * 分享分队结果。
   *
   * 必须固定封面图：不指定时微信会截当前页面，而组织者的视图里每个人都带
   * 水平数字、队均水平也在标题下——一分享就把评级给群里所有人看了。
   */
  onShareAppMessage: function () {
    return share.withImage({
      title: (this.data.tournamentName || '飞盘 HAT') + ' 分队结果',
      path: '/pages/division/division?tournamentId=' + this.data.tournamentId,
    })
  },

  boot: function () {
    const that = this
    return api.team('getTournament', { tournamentId: this.data.tournamentId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({
          eventId: d.eventId,
          tournamentName: d.tournament.name,
          isOrganizer: d.isOrganizer,
          boardLabel: eventConfig.boardLabel(d.eventType),
          teamCount: d.tournament.teamCount,
          attendees: d.attendees,
        })
        wx.setNavigationBarTitle({ title: d.tournament.name })

        if (!d.isOrganizer) return that.refresh()

        return api.team('listConstraints', { eventId: d.eventId }, { loading: false })
          .then(function (c) {
            const nameById = {}
            d.attendees.forEach(function (p) { nameById[p._id] = p.name })
            that.setData({ cons: c.list || [], nameById: nameById })
            if (that.data.autoRun) return that.compute()
            return that.refresh().then(function () {
              if (!that.data.division) return that.compute()
            })
          })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  /** 从云端读取当前分队结果——服务端是唯一事实来源。 */
  refresh: function () {
    const that = this
    return api.team('getDivision', { tournamentId: this.data.tournamentId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({ loading: false, canSeeLevel: !!d.canSeeLevel })
        if (!d.division) {
          that.setData({ division: null, teams: [] })
          return
        }
        that.render(d.division, !!d.canSeeLevel)
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  render: function (division, canSeeLevel) {
    // 「高分」= 这批人里最高的那一档。线本身是动态的，不写出来就没人知道
    // 「高分 2 人」到底指到哪一档；这也是一条水平信息，所以只给能看水平的人。
    const starLine = canSeeLevel && division.starLevel
      ? '（L' + division.starLevel + '）'
      : ''
    const teams = (division.teams || []).map(function (t) {
      const s = t.stats
      return {
        index: t.index,
        name: t.name,
        stats: s,
        // 水平不公开：非管理身份只显示人数和男女，不显示均分和高分人数
        statsText: canSeeLevel
          ? s.count + '人 · ' + s.male + '男' + s.female + '女 · 均分' +
            s.avgLevel + ' · 高分' + s.star + '人' + starLine
          : s.count + '人 · ' + s.male + '男' + s.female + '女',
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

    this.setData({
      division: division,
      teams: teams,
      metaText: '第 ' + division.version + ' 版' +
        (division.published ? ' · 已发布' : ' · 未发布') +
        (division.seed ? ' · seed ' + division.seed : ''),
      qualityText: canSeeLevel ? describeSpread(teams) : '',
      selectedId: '',
      selectedName: '',
      conflictText: this.checkConflicts(teams),
    })
  },

  /** 在本机跑分队算法，然后存到云端。 */
  compute: function () {
    const that = this
    const attendees = this.data.attendees || []
    const teamCount = this.data.teamCount

    if (attendees.length < teamCount) {
      this.setData({
        loading: false,
        failMessage: '赛前检录 ' + attendees.length + ' 人，少于 ' + teamCount + ' 个队',
      })
      return Promise.resolve()
    }

    const players = attendees.map(function (s) {
      return { id: s._id, name: s.name, gender: s.gender, level: s.level }
    })

    // 约束挂在活动层，可能牵涉到本场没来的人。把缺席的人从约束里摘掉，
    // 剩下不足 2 人的整条丢弃——否则算法会因为引用了不存在的球员直接报错。
    const present = {}
    attendees.forEach(function (p) { present[p._id] = true })
    const cons = []
    let dropped = 0
    ;(this.data.cons || []).forEach(function (c) {
      const kept = (c.signupIds || []).filter(function (id) { return present[id] })
      if (kept.length < 2) {
        if ((c.signupIds || []).length >= 2) dropped++
        return
      }
      if (kept.length < (c.signupIds || []).length) dropped++
      cons.push({ type: c.type, ids: kept })
    })

    wx.showLoading({ title: '分队中', mask: true })
    const res = divider.divide(players, teamCount, cons)
    wx.hideLoading()

    if (!res.ok) {
      this.setData({ loading: false })
      wx.showModal({ title: '无法完成分队', content: res.error.message, showCancel: false })
      return Promise.resolve()
    }

    this.setData({
      warnings: res.warnings || [],
      droppedConstraintText: dropped > 0
        ? '有 ' + dropped + ' 条约束因为相关的人本场没检录，已自动忽略或只保留了检录的部分'
        : '',
      busy: true,
    })

    return api.team('saveDivision', {
      tournamentId: this.data.tournamentId,
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
    if (!this.data.isOrganizer) return
    const id = e.currentTarget.dataset.id
    const teamIndex = Number(e.currentTarget.dataset.team)

    if (!this.data.selectedId) {
      this.setData({
        selectedId: id,
        selectedName: (this.data.nameById || {})[id] || '',
        selectedTeam: teamIndex,
      })
      return
    }
    if (this.data.selectedId === id) {
      this.setData({ selectedId: '', selectedName: '' })
      return
    }
    if (this.data.selectedTeam === teamIndex) {
      this.setData({ selectedId: id, selectedName: (this.data.nameById || {})[id] || '' })
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
        tournamentId: that.data.tournamentId,
        seed: that.data.division ? that.data.division.seed : null,
        teams: teams.map(function (t) {
          return { name: t.name, memberIds: t.members.map(function (m) { return m._id }) }
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
      // 只检查本场到场的那部分
      const ids = (cons[c].signupIds || []).filter(function (id) {
        return teamOf[id] !== undefined
      })
      if (ids.length < 2) continue
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

  // ---------------- 发布与跳转 ----------------

  publish: function () {
    const that = this
    api.team('publish', {
      tournamentId: this.data.tournamentId,
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
      content: '参与者将看不到这场赛事的分队结果。',
      success: function (r) {
        if (!r.confirm) return
        api.team('unpublish', { tournamentId: that.data.tournamentId }, { loading: '处理中' })
          .then(function () { return that.refresh() })
          .catch(function () {})
      },
    })
  },

  goMatches: function () {
    wx.navigateTo({ url: '/pages/matches/matches?tournamentId=' + this.data.tournamentId })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
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
    if (s.count > 0 && s.avgLevel != null) {
      if (s.avgLevel < aMin) aMin = s.avgLevel
      if (s.avgLevel > aMax) aMax = s.avgLevel
    }
  }
  const avgGap = aMax >= aMin ? Math.round((aMax - aMin) * 100) / 100 : 0
  return '人数相差 ' + (sizeMax - sizeMin) + ' · 女生相差 ' + (fMax - fMin) +
    ' · 队均水平相差 ' + avgGap
}
