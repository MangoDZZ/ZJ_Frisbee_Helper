'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    eventName: '',
    rows: [],
    totals: null,
    tournamentCount: 0,
    liveMatchCount: 0,
    ruleGroups: [],
    recentDraws: [],
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

  onShareAppMessage: function () {
    return {
      title: (this.data.eventName || '飞盘 HAT') + ' 积分榜',
      path: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId,
    }
  },

  load: function () {
    const that = this
    return api.match('leaderboard', { eventId: this.data.eventId },
      { loading: false, toastError: false })
      .then(function (d) {
        that.setData({
          loading: false,
          failMessage: '',
          eventName: d.eventName,
          totals: d.totals || { matchCount: 0, playedCount: 0, playerCount: 0 },
          tournamentCount: d.tournamentCount || 0,
          liveMatchCount: d.liveMatchCount || 0,
          ruleGroups: ruleGroupsOf(d.rules),
          recentDraws: (d.recentDraws || []).map(function (x) {
            return Object.assign({}, x, {
              timeText: fmt.formatDateTime(x.createTime),
              namesText: (x.names || []).join('、'),
            })
          }),
          rows: (d.rows || []).map(function (r) {
            return Object.assign({}, r, {
              genderText: fmt.genderText(r.gender),
              // 事件调整单独标出来，免得看到"比赛没打却有分"觉得算错了
              eventText: r.eventDelta
                ? '含随机事件 ' + (r.eventDelta > 0 ? '+' : '') + r.eventDelta
                : '',
              resetText: r.reset ? '累计弃赛 ' + ruleValue(d.rules, 'forfeitReset') + ' 次，积分归零' : '',
              recordText: r.played > 0 || r.forfeitCount > 0
                ? r.tournamentCount + ' 场赛事 · ' + r.played + ' 战 ' +
                  r.won + ' 胜 ' + r.lost + ' 负' +
                  (r.forfeitCount > 0 ? ' · 弃赛 ' + r.forfeitCount + ' 次' : '')
                : '未上场',
              // 前三名给个高亮，其余保持朴素
              rankClass: r.points > 0 && r.rank <= 3 ? 'rank-top rank-' + r.rank : '',
              dimClass: r.played === 0 && !r.eventDelta ? 'row-dim' : '',
            })
          }),
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  goTournaments: function () {
    wx.navigateTo({ url: '/pages/tournaments/tournaments?eventId=' + this.data.eventId })
  },

  goStats: function () {
    wx.navigateTo({ url: '/pages/stats/stats?eventId=' + this.data.eventId })
  },
})

/**
 * 计分规则的兜底默认值，与云函数 lib/score.js 保持一致。
 *
 * 必须有一份兜底：改前端要审核、改云函数立即生效，线上必然存在"新前端 + 旧云函数"的
 * 组合。旧云函数不回 forfeit / forfeitReset 时，直接拼字符串会显示成
 * 「弃赛 undefined」，所以这里逐个字段校验，缺了就用默认值。
 */
const RULE_FALLBACK = { win: 3, loss: 1, mvp: 1, forfeit: -3, forfeitReset: 2 }

function ruleValue (raw, key) {
  const n = Number(raw && raw[key])
  return isFinite(n) ? n : RULE_FALLBACK[key]
}

/** 把规则拆成分级条目（胜负 / MVP / 弃赛），一条一行。 */
function ruleGroupsOf (raw) {
  const r = {
    win: ruleValue(raw, 'win'),
    loss: ruleValue(raw, 'loss'),
    mvp: ruleValue(raw, 'mvp'),
    forfeit: ruleValue(raw, 'forfeit'),
    forfeitReset: ruleValue(raw, 'forfeitReset'),
  }
  return [
    { label: '胜负', text: '胜 +' + r.win + '　负 +' + r.loss },
    { label: 'MVP', text: '每获选一次 +' + r.mvp },
    { label: '弃赛', text: r.forfeit + ' 分，累计 ' + r.forfeitReset + ' 次积分归零' },
  ]
}
