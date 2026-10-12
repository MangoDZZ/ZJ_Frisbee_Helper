'use strict'

const api = require('../../utils/api.js')

Page({
  data: {
    tournamentId: '',
    matchId: '',
    loading: true,
    failMessage: '',
    submitting: false,

    teams: [],              // [{ index, name, members: [{_id,name,level,gender}] }]
    teamAIndex: null,
    teamBIndex: null,
    teamAName: '',
    teamBName: '',

    rosterA: [],            // [{ _id, name, level, checked }]
    rosterB: [],

    scoreA: '',
    scoreB: '',
    scoreHint: '',
    canSeeLevel: false,

    mvpCandidates: [],      // 败方的上场队员
    mvpSide: '',            // 'A' | 'B'，哪一方是败方
    mvpIds: [],
  },

  onLoad: function (q) {
    const that = this
    this.setData({ tournamentId: q.tournamentId || '', matchId: q.matchId || '' })
    if (q.matchId) wx.setNavigationBarTitle({ title: '修改比赛' })

    // 队伍成员带姓名和水平，从 getDivision 拿；listMatches 只返回 id。
    api.team('getDivision', { tournamentId: q.tournamentId }, { loading: '加载中', toastError: false })
      .then(function (d) {
        if (!d.division) {
          that.setData({ loading: false, failMessage: '还没有分队结果，无法记录比赛' })
          return null
        }
        that.setData({
          canSeeLevel: !!d.canSeeLevel,
          teams: d.division.teams.map(function (t) {
            return { index: t.index, name: t.name, members: t.members }
          }),
          loading: false,
        })
        if (q.matchId) return that.prefill(q.matchId)
        return null
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  /** 修改已有比赛时回填。复用 listMatches，不另开一个 getMatch 接口。 */
  prefill: function (matchId) {
    const that = this
    return api.match('listMatches', { tournamentId: this.data.tournamentId },
      { loading: false, toastError: false })
      .then(function (d) {
        const m = (d.list || []).filter(function (x) { return x._id === matchId })[0]
        if (!m) {
          that.setData({ failMessage: '找不到这场比赛，可能已被删除' })
          return
        }
        const idsA = m.participantsA.map(function (p) { return p._id })
        const idsB = m.participantsB.map(function (p) { return p._id })
        that.setData({
          teamAIndex: m.teamAIndex,
          teamBIndex: m.teamBIndex,
          teamAName: m.teamAName,
          teamBName: m.teamBName,
          rosterA: that.buildRoster(m.teamAIndex, idsA),
          rosterB: that.buildRoster(m.teamBIndex, idsB),
          scoreA: String(m.scoreA),
          scoreB: String(m.scoreB),
          mvpIds: m.mvps.map(function (p) { return p._id }),
        })
        that.refreshMvp()
      })
  },

  /** checkedIds 为 null 表示全选——录入时默认全队上场，取消缺席的人更快。 */
  buildRoster: function (teamIndex, checkedIds) {
    const team = this.data.teams.filter(function (t) { return t.index === teamIndex })[0]
    if (!team) return []
    return team.members.map(function (m) {
      return {
        _id: m._id,
        name: m.name,
        level: m.level,
        checked: checkedIds === null ? true : checkedIds.indexOf(m._id) >= 0,
      }
    })
  },

  pickTeam: function (e) {
    const side = e.currentTarget.dataset.side
    const index = Number(e.currentTarget.dataset.index)
    const otherKey = side === 'A' ? 'teamBIndex' : 'teamAIndex'
    if (this.data[otherKey] === index) {
      wx.showToast({ title: '两队不能是同一队', icon: 'none' })
      return
    }
    const team = this.data.teams.filter(function (t) { return t.index === index })[0]
    const patch = {}
    patch['team' + side + 'Index'] = index
    patch['team' + side + 'Name'] = team ? team.name : ''
    patch['roster' + side] = this.buildRoster(index, null)
    patch.mvpIds = []
    this.setData(patch, this.refreshMvp)
  },

  toggleMember: function (e) {
    const side = e.currentTarget.dataset.side
    const i = Number(e.currentTarget.dataset.index)
    const key = 'roster' + side
    const list = this.data[key].slice()
    list[i] = Object.assign({}, list[i], { checked: !list[i].checked })
    const patch = {}
    patch[key] = list
    this.setData(patch, this.refreshMvp)
  },

  selectAll: function (e) {
    const side = e.currentTarget.dataset.side
    const key = 'roster' + side
    const all = this.data[key].every(function (m) { return m.checked })
    const list = this.data[key].map(function (m) {
      return Object.assign({}, m, { checked: !all })
    })
    const patch = {}
    patch[key] = list
    this.setData(patch, this.refreshMvp)
  },

  onScore: function (e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch, this.refreshMvp)
  },

  /**
   * 重算 MVP 候选。规则是胜方从败方的上场队员里选，所以候选名单随比分变化——
   * 直接把范围限定死，比让组织者选完再报错好。
   */
  refreshMvp: function () {
    const a = parseScore(this.data.scoreA)
    const b = parseScore(this.data.scoreB)

    if (a === null || b === null) {
      this.setData({ mvpCandidates: [], mvpSide: '', scoreHint: '' })
      return
    }
    if (a === b) {
      this.setData({
        mvpCandidates: [], mvpSide: '',
        scoreHint: '不允许平局，请填写分出胜负的比分',
      })
      return
    }

    const loserSide = a > b ? 'B' : 'A'
    const roster = this.data['roster' + loserSide]
    const candidates = roster.filter(function (m) { return m.checked })

    // 比分改变可能让原来选的 MVP 变成胜方的人，这里把失效的清掉。
    const validIds = candidates.map(function (m) { return m._id })
    const keep = this.data.mvpIds.filter(function (id) { return validIds.indexOf(id) >= 0 })

    this.setData({
      scoreHint: '',
      mvpSide: loserSide,
      mvpIds: keep,
      mvpCandidates: candidates.map(function (m) {
        return { _id: m._id, name: m.name, selected: keep.indexOf(m._id) >= 0 }
      }),
    })
  },

  toggleMvp: function (e) {
    const id = e.currentTarget.dataset.id
    const ids = this.data.mvpIds.slice()
    const at = ids.indexOf(id)
    if (at >= 0) {
      ids.splice(at, 1)
    } else {
      if (ids.length >= 2) {
        wx.showToast({ title: '最多选 2 名 MVP', icon: 'none' })
        return
      }
      ids.push(id)
    }
    this.setData({
      mvpIds: ids,
      mvpCandidates: this.data.mvpCandidates.map(function (m) {
        return Object.assign({}, m, { selected: ids.indexOf(m._id) >= 0 })
      }),
    })
  },

  submit: function () {
    const d = this.data
    if (d.teamAIndex === null || d.teamBIndex === null) return warn('请选择对阵的两支队伍')
    if (d.teamAIndex === d.teamBIndex) return warn('两队不能是同一队')

    const a = parseScore(d.scoreA)
    const b = parseScore(d.scoreB)
    if (a === null || b === null) return warn('请填写双方比分')
    if (a === b) return warn('不允许平局，请填写分出胜负的比分')

    const pa = d.rosterA.filter(function (m) { return m.checked })
      .map(function (m) { return m._id })
    const pb = d.rosterB.filter(function (m) { return m.checked })
      .map(function (m) { return m._id })
    if (pa.length === 0) return warn('甲方至少要有 1 名上场队员')
    if (pb.length === 0) return warn('乙方至少要有 1 名上场队员')

    const that = this
    this.setData({ submitting: true })
    api.match('saveMatch', {
      tournamentId: d.tournamentId,
      matchId: d.matchId,
      teamAIndex: d.teamAIndex,
      teamBIndex: d.teamBIndex,
      scoreA: a,
      scoreB: b,
      participantsA: pa,
      participantsB: pb,
      mvpIds: d.mvpIds,
    }, { loading: '保存中' })
      .then(function () {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(function () { wx.navigateBack() }, 700)
      })
      .catch(function () {
        that.setData({ submitting: false })
      })
  },
})

/** 比分必须是非负整数，空串和非法输入都返回 null。 */
function parseScore (v) {
  const s = String(v == null ? '' : v).trim()
  if (s === '') return null
  const n = Number(s)
  if (!isFinite(n) || Math.floor(n) !== n || n < 0) return null
  return n
}

function warn (msg) {
  wx.showToast({ title: msg, icon: 'none' })
}
