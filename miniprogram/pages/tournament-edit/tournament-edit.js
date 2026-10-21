'use strict'

const api = require('../../utils/api.js')
const nameMatch = require('../../utils/name-match.js')

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

    // 粘贴名单（v1.0.3）：pasteInfo 为 null 表示还没识别过
    pasteText: '',
    pasteOpen: false,    // 浮层是否展开
    pasteInfo: null,     // { total, matchedCount, unmatched: [], ambiguous: [], skipped: 0 }
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
          // 名单换了，上一次粘贴的识别结果就作废（id 可能已经变了）
          pasteText: '',
          pasteInfo: null,
          pasteOpen: false,
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

  // ---------------------------------------------------------------- 粘贴名单

  /**
   * 粘贴框放在全屏浮层里而不是页面正文。
   *
   * textarea 是微信的原生组件，层级永远高于同层的普通 view——正文里的固定底栏
   * 根本盖不住它，名单长一点滚到底栏上方就会把「创建分队」压住（v1.0.3 的 bug）。
   * 浮层是普通 view，能盖住底栏；框固定高度、只占浮层上半部分，两者不重叠。
   */
  openPaste: function () {
    if (this.data.lockedReason) return warn('已有比赛记录，不能改名单')
    this.setData({ pasteOpen: true })
  },

  closePaste: function () {
    this.setData({ pasteOpen: false })
  },

  /** 浮层里 catchtouchmove 用，阻止背景跟着滚。 */
  noop: function () {},

  onPasteInput: function (e) {
    this.setData({ pasteText: e.detail.value })
  },

  /**
   * 按粘贴的文本勾选到场的人（v1.0.3）。
   *
   * 语义是**替换**而不是追加：粘一段"今天到场的人"，意思就是"这些人到场了"。
   * 如果只是往上追加，默认全选的名单里一个人也取消不掉，这个功能就没有意义了。
   * 认不出来的条目会原样列在下面，让组织者自己补勾。
   */
  applyPaste: function () {
    const d = this.data
    if (d.lockedReason) return warn('已有比赛记录，不能改名单')

    const parsed = nameMatch.parseNames(d.pasteText)
    if (parsed.tokens.length === 0) return warn('先粘贴一段名单')

    const res = nameMatch.matchNames(parsed.tokens, d.roster.map(function (m) {
      return { id: m._id, name: m.name }
    }))
    const info = {
      total: parsed.tokens.length,
      matchedCount: res.matched.length,
      unmatched: res.unmatched,
      ambiguous: res.ambiguous,
      skipped: parsed.skipped,
    }

    // 一个都没认出来时不要动当前勾选，否则等于把名单清空了；浮层留着方便改
    if (res.matched.length === 0) {
      this.setData({ pasteInfo: info })
      return warn('没能识别出任何报名者')
    }

    const picked = {}
    res.matched.forEach(function (m) { picked[m.id] = true })
    const list = d.roster.map(function (m) {
      return Object.assign({}, m, { checked: !!picked[m._id] })
    })
    // 识别完就收起浮层，好让组织者立刻看到勾选结果和未识别名单
    this.setData({
      roster: list,
      checkedCount: res.matched.length,
      pasteInfo: info,
      pasteOpen: false,
    })

    const miss = res.unmatched.length + res.ambiguous.length
    wx.showToast({
      title: '识别 ' + res.matched.length + ' 人' + (miss > 0 ? '，' + miss + ' 条待确认' : ''),
      icon: 'none',
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
