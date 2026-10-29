'use strict'

const api = require('../../utils/api.js')
const eventConfig = require('../../utils/event-config.js')
const fmt = require('../../utils/format.js')
const share = require('../../utils/share.js')

Page({
  data: {
    eventId: '',
    // 「仅限群聊转发可见」的分享口令，从群链接带进来后要一直带着往下传
    shareToken: '',
    loading: true,
    failMessage: '',
    event: null,
    boardLabel: '积分榜',
    isOwner: false,
    canManage: false,
    mySignup: null,
    tournaments: [],
    // 最近比赛（活动级摘要）：只取两场，直接在详情页显示比分
    recentMatches: [],
    matchEntryTournamentId: '',
    matchEntryTournamentName: '',
    timeText: '',
    deadlineText: '',
    statusText: '',
    statusClass: '',
    myLevelText: '',
    myGenderText: '',
    canSignup: false,
    blockReason: '',
    // 按钮上用的短文案（v1.1.1：部分机型上长文案会换行，尽量控制在 4 个汉字内）
    blockText: '',
  },

  onLoad: function (q) {
    this.setData({ eventId: q.id || '', shareToken: q.t || '' })
  },

  onShow: function () {
    if (this.data.eventId) this.load()
  },

  onShareAppMessage: function () {
    const e = this.data.event
    // 群内可见的活动必须把口令带进链接，否则对方点开是"仅限群内成员查看"
    const token = e && e.groupOnly && this.data.shareToken
      ? '&t=' + this.data.shareToken
      : ''
    // 封面统一：否则微信会截当前页，组织者视图里的东西（如测试数据卡片）会漏出去
    return share.withImage({
      title: e ? e.name + '｜' + this.data.timeText : '飞盘 HAT 活动',
      path: '/pages/event-detail/event-detail?id=' + this.data.eventId + token,
    })
  },

  load: function () {
    const that = this
    return api.event('detail', {
      eventId: this.data.eventId,
      t: this.data.shareToken,
    }, { loading: false, toastError: false })
      .then(function (d) {
        const e = d.event
        const expired = fmt.isSignupExpired(e)
        const full = e.remaining <= 0
        that.setData({
          loading: false,
          failMessage: '',
          event: e,
          boardLabel: eventConfig.boardLabel(e.type),
          // 服务端认了口令会回传它，之后分享给别人才带得出去
          shareToken: d.shareToken || that.data.shareToken,
          isOwner: !!d.isOwner,
          canManage: !!d.canManage,
          mySignup: d.mySignup,
          timeText: fmt.formatRange(e.startTime, e.endTime),
          deadlineText: e.signupDeadline ? fmt.formatFullDateTime(e.signupDeadline) : '',
          statusText: fmt.statusText(e.status),
          statusClass: 'tag-' + e.status,
          myLevelText: d.mySignup ? fmt.levelText(d.mySignup.selfLevel) : '',
          myGenderText: d.mySignup ? fmt.genderText(d.mySignup.gender) : '',
          canSignup: e.status === 'open' && !expired && (!full || !!d.mySignup),
          blockReason: e.status !== 'open' ? fmt.statusText(e.status)
            : expired ? '报名已截止'
              : full ? '名额已满' : '',
          // 按钮文案要短：'报名已截止' 在窄屏上会折行
          blockText: e.status !== 'open' ? fmt.statusText(e.status)
            : expired ? '已截止'
              : full ? '名额已满' : '',
        })
        return Promise.all([that.loadTournaments(), that.loadRecentMatches()])
      })
      .catch(function (err) {
        that.setData({ loading: false, failMessage: err.message })
      })
  },

  /** 赛事列表单独取，失败就静默留空（比如还没开赛）。 */
  loadTournaments: function () {
    const that = this
    return api.team('listTournaments', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({ tournaments: d.list || [] })
      })
      .catch(function () {
        that.setData({ tournaments: [] })
      })
  },

  /**
   * 活动级的最近两场比分。比赛记录原来要点「赛事 → 某场 → 比赛记录」三层才看得到，
   * 这里直接摆出来，点一下就能进。
   */
  loadRecentMatches: function () {
    const that = this
    return api.match('recentMatches', { eventId: this.data.eventId, limit: 2 },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({
          recentMatches: (d.list || []).map(function (m) {
            return Object.assign({}, m, {
              scoreText: m.scoreA + ' : ' + m.scoreB,
              live: m.status === 'live',
            })
          }),
          matchEntryTournamentId: d.entryTournamentId || '',
          matchEntryTournamentName: d.entryTournamentName || '',
        })
      })
      .catch(function () {
        // 摘要失败不影响详情页主体，静默留空即可
        that.setData({ recentMatches: [] })
      })
  },

  goSignup: function () {
    wx.navigateTo({ url: '/pages/signup-form/signup-form?eventId=' + this.data.eventId })
  },

  goManage: function () {
    wx.navigateTo({ url: '/pages/manage/manage?eventId=' + this.data.eventId })
  },

  goTournaments: function () {
    wx.navigateTo({ url: '/pages/tournaments/tournaments?eventId=' + this.data.eventId })
  },

  /**
   * 进比赛记录界面。
   *
   * 比赛记录挂在赛事上，所以要有具体赛事才能进：有比赛时进"最近一场所在的赛事"，
   * 一场都没有时退到最新一场赛事——组织者点进来本来就是为了去录战绩。
   * 一个赛事都还没建时改去赛事列表（那才是该先做的事）。
   */
  goMatches: function () {
    if (!this.data.matchEntryTournamentId) return this.goTournaments()
    wx.navigateTo({
      url: '/pages/matches/matches?tournamentId=' + this.data.matchEntryTournamentId,
    })
  },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },

  goStats: function () {
    wx.navigateTo({ url: '/pages/stats/stats?eventId=' + this.data.eventId })
  },

  goMyStats: function () {
    wx.navigateTo({ url: '/pages/my-stats/my-stats?eventId=' + this.data.eventId })
  },

  goRandomEvents: function () {
    wx.navigateTo({ url: '/pages/random-events/random-events?eventId=' + this.data.eventId })
  },

  cancelSignup: function () {
    const that = this
    wx.showModal({
      title: '取消报名',
      content: '确定要取消报名吗？名额会释放给其他人。',
      confirmText: '取消报名',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        api.signup('cancel', { eventId: that.data.eventId }, { loading: '处理中' })
          .then(function () {
            wx.showToast({ title: '已取消报名', icon: 'success' })
            that.load()
          })
          .catch(function () {})
      },
    })
  },
})
