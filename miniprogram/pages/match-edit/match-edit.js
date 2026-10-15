'use strict'

const api = require('../../utils/api.js')

/**
 * 单场比赛页，按比赛进程分三个阶段：
 *
 *   1 赛前检录   选对阵的两支队，勾出本场实际上场的人
 *   2 比赛中     逐分记录：每分记「得分队伍 + 得分队员 + 助攻队员（可选）」
 *   3 比赛结束   最终比分、MVP、弃赛登记，以及跳积分榜 / 得分助攻榜
 *
 * 比分不再是手填的：它由逐分记录条数算出来，所以比分和明细永远一致。
 * 助攻可以留空（个人单打），不是必填项。
 */
const STAGE_LINEUP = 1
const STAGE_LIVE = 2
const STAGE_DONE = 3

Page({
  data: {
    tournamentId: '',
    eventId: '',
    matchId: '',
    loading: true,
    failMessage: '',
    submitting: false,

    stage: STAGE_LINEUP,
    STAGE_LINEUP: STAGE_LINEUP,
    STAGE_LIVE: STAGE_LIVE,
    STAGE_DONE: STAGE_DONE,
    stages: [
      { id: STAGE_LINEUP, name: '赛前检录' },
      { id: STAGE_LIVE, name: '比赛中' },
      { id: STAGE_DONE, name: '比赛结束' },
    ],

    teams: [],              // [{ index, name, members: [{_id,name,level,gender}] }]
    teamAIndex: null,
    teamBIndex: null,
    teamAName: '',
    teamBName: '',

    rosterA: [],            // [{ _id, name, level, checked }]
    rosterB: [],

    points: [],             // [{ key, team, scorer, scorerName, assist, assistName }]
    scoreA: 0,
    scoreB: 0,
    scoreText: '0 : 0',
    pointsText: '',
    /**
     * 升级前录的比赛：只有手填比分、没有逐分明细。这时比分以存量为准，
     * 明细区不显示，改记录只能改 MVP / 弃赛；想补明细要走「改为逐分记录」，
     * 因为半场明细配上整场比分只会把比分改错。
     */
    manualScore: null,

    pendingTeam: '',        // 'A' | 'B'
    pendingScorer: '',
    pendingAssist: '',
    pendingRoster: [],      // 当前待记分队伍的检录名单
    canAddPoint: false,

    canSeeLevel: false,
    mvpCandidates: [],
    mvpSide: '',
    mvpIds: [],
    forfeitIds: [],
    forfeitCandidates: [],
  },

  onLoad: function (q) {
    const that = this
    this._ptSeq = 0
    this.setData({ tournamentId: q.tournamentId || '', matchId: q.matchId || '' })
    if (q.matchId) wx.setNavigationBarTitle({ title: '比赛记录' })

    // 队伍成员带姓名和水平，从 getDivision 拿；listMatches 只返回 id。
    api.team('getDivision', { tournamentId: q.tournamentId }, { loading: '加载中', toastError: false })
      .then(function (d) {
        if (!d.division) {
          that.setData({ loading: false, failMessage: '还没有分队结果，无法记录比赛' })
          return null
        }
        that.setData({
          eventId: d.eventId,
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

  onUnload: function () {
    // 边打边记的分数只存在本页内存里，直接退出会丢，所以提醒一次。
    if (this._saved || this.data.submitting) return
    if (!this.data.points.length) return
    wx.showToast({ title: '这次记录还没保存', icon: 'none' })
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
        const hasPoints = (m.points || []).length > 0
        that.setData({
          eventId: d.eventId || that.data.eventId,
          teamAIndex: m.teamAIndex,
          teamBIndex: m.teamBIndex,
          teamAName: m.teamAName,
          teamBName: m.teamBName,
          rosterA: that.buildRoster(m.teamAIndex, idsA),
          rosterB: that.buildRoster(m.teamBIndex, idsB),
          points: that.decoratePoints(m.points || []),
          manualScore: hasPoints ? null : { a: m.scoreA, b: m.scoreB },
          mvpIds: m.mvps.map(function (p) { return p._id }),
          forfeitIds: (m.forfeits || []).map(function (p) { return p._id }),
          // 已结束的比赛直接落在第三阶段：打开就是看结果，不必再回到记分界面。
          stage: m.status === 'live' ? STAGE_LIVE : STAGE_DONE,
        }, function () {
          that.refreshScore()
          that.refreshMvp()
          that.refreshForfeits()
          that.refreshPending()
        })
      })
  },

  /** checkedIds 为 null 表示全选——检录时默认全队上场，取消没来的人更快。 */
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

  /**
   * 服务端返回的明细里队员是 { _id, name }，摊平成页面直接能用的字段。
   *
   * key 是给 wx:key 用的稳定标识：得分记录会重复出现（同一个人可能得很多分），
   * 用数组下标当 key 会在删除中间某一分时错位重渲染。
   */
  decoratePoints: function (list) {
    return list.map(function (p, i) {
      return {
        key: 'e' + i,
        team: p.team,
        scorer: p.scorer._id,
        scorerName: p.scorer.name,
        assist: p.assist ? p.assist._id : '',
        assistName: p.assist ? p.assist.name : '',
      }
    })
  },

  // ---------------------------------------------------------------- 阶段切换

  gotoLive: function () {
    if (!this.checkLineup()) return
    this.setData({ stage: STAGE_LIVE }, function () { this.refreshPending() }.bind(this))
  },

  gotoDone: function () {
    if (!this.checkLineup()) return
    this.setData({ stage: STAGE_DONE }, function () { this.refreshMvp() }.bind(this))
  },

  backToLineup: function () {
    this.setData({ stage: STAGE_LINEUP }, function () { this.refreshPending() }.bind(this))
  },

  /** 进下一阶段前先确认对阵和上场人数，否则到记分界面会无从下手。 */
  checkLineup: function () {
    const d = this.data
    if (d.teamAIndex === null || d.teamBIndex === null) {
      warn('请先选择对阵的两支队伍')
      return false
    }
    if (countChecked(d.rosterA) === 0) {
      warn('甲方至少要有 1 名上场队员')
      return false
    }
    if (countChecked(d.rosterB) === 0) {
      warn('乙方至少要有 1 名上场队员')
      return false
    }
    return true
  },

  // ---------------------------------------------------------------- 阶段一：赛前检录

  pickTeam: function (e) {
    const side = e.currentTarget.dataset.side
    const index = Number(e.currentTarget.dataset.index)
    const otherKey = side === 'A' ? 'teamBIndex' : 'teamAIndex'
    if (this.data[otherKey] === index) {
      warn('两队不能是同一队')
      return
    }
    const team = this.data.teams.filter(function (t) { return t.index === index })[0]
    const patch = {}
    patch['team' + side + 'Index'] = index
    patch['team' + side + 'Name'] = team ? team.name : ''
    patch['roster' + side] = this.buildRoster(index, null)
    // 换队等于换了人，之前记的分、MVP、弃赛都可能失效，一并清掉。
    patch.points = []
    patch.mvpIds = []
    patch.forfeitIds = []
    patch.pendingTeam = ''
    patch.pendingScorer = ''
    patch.pendingAssist = ''
    this.setData(patch, function () {
      this.refreshScore()
      this.refreshMvp()
      this.refreshForfeits()
      this.refreshPending()
    }.bind(this))
  },

  toggleMember: function (e) {
    const side = e.currentTarget.dataset.side
    const i = Number(e.currentTarget.dataset.index)
    const key = 'roster' + side
    const list = this.data[key].slice()
    list[i] = Object.assign({}, list[i], { checked: !list[i].checked })
    const id = list[i]._id
    const patch = {}
    patch[key] = list

    if (list[i].checked) {
      // 检录上场和弃赛互斥
      patch.forfeitIds = this.data.forfeitIds.filter(function (x) { return x !== id })
    } else {
      // 把人从场上勾掉，已经记在他名下的分和助攻就没有依据了，一并撤销
      patch.points = this.data.points.filter(function (p) {
        return p.scorer !== id && p.assist !== id
      })
      patch.mvpIds = this.data.mvpIds.filter(function (x) { return x !== id })
    }
    this.setData(patch, function () {
      this.refreshScore()
      this.refreshMvp()
      this.refreshForfeits()
      this.refreshPending()
    }.bind(this))
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
    if (!all) {
      const selected = list.filter(function (m) { return m.checked })
        .map(function (m) { return m._id })
      patch.forfeitIds = this.data.forfeitIds.filter(function (id) { return selected.indexOf(id) < 0 })
    } else {
      // 全员取消等于没人上场，之前记的分全部失去依据
      patch.points = []
      patch.mvpIds = []
    }
    this.setData(patch, function () {
      this.refreshScore()
      this.refreshMvp()
      this.refreshForfeits()
      this.refreshPending()
    }.bind(this))
  },

  // ---------------------------------------------------------------- 阶段二：比赛中，逐分记录

  /** 选这次记哪一队得分，然后把该队检录过的人摆出来。 */
  pickPointTeam: function (e) {
    const team = e.currentTarget.dataset.team
    this.setData({ pendingTeam: team, pendingScorer: '', pendingAssist: '' },
      this.refreshPending)
  },

  /** 点球员：第一次点设为得分队员，再点自己取消。 */
  pickScorer: function (e) {
    const id = e.currentTarget.dataset.id
    const next = this.data.pendingScorer === id ? '' : id
    const patch = { pendingScorer: next }
    // 得分和助攻不能同为一人
    if (next && this.data.pendingAssist === next) patch.pendingAssist = ''
    this.setData(patch, this.refreshPending)
  },

  /**
   * 助攻可选：不选就是个人单打。
   *
   * 得分的人不能给自己助攻——本地就挡掉，否则要等云函数返回
   * 「得分和助攻不能是同一个人」，用户还得自己回头猜是哪一分错了。
   */
  pickAssist: function (e) {
    const id = e.currentTarget.dataset.id
    if (id === this.data.pendingScorer) {
      warn('得分的人不能同时记助攻')
      return
    }
    const next = this.data.pendingAssist === id ? '' : id
    this.setData({ pendingAssist: next }, this.refreshPending)
  },

  refreshPending: function () {
    const that = this
    const team = this.data.pendingTeam
    const roster = team
      ? (this.data['roster' + team] || []).filter(function (m) { return m.checked })
      : []
    const ids = roster.map(function (m) { return m._id })

    // 检录名单变了之后，原来选中的得分/助攻可能已经下场。就地清掉，
    // 否则「记这一分」会为不在上场名单里的人记上一分——提交时会被云函数整批拒绝，
    // 用户还得自己回头找出是哪一分错了。
    const scorer = ids.indexOf(this.data.pendingScorer) >= 0 ? this.data.pendingScorer : ''
    const assist = ids.indexOf(this.data.pendingAssist) >= 0 ? this.data.pendingAssist : ''

    this.setData({
      pendingScorer: scorer,
      pendingAssist: assist,
      pendingRoster: roster.map(function (m) {
        return {
          _id: m._id,
          name: m.name,
          level: m.level,
          isScorer: m._id === scorer,
          isAssist: m._id === assist,
        }
      }),
      canAddPoint: !!(team && scorer && !that.data.manualScore),
    })
  },

  /**
   * 当前正在记分的那一队的**上场**名单（已勾选的人）。
   *
   * 单独取而不是复用 pendingRoster：后者是渲染用的投影（多了 isScorer 等标记），
   * 提交时要的是 { _id, name } 本身，两者混用很容易把标记字段一起提交上去。
   */
  lineupOfPending: function () {
    const team = this.data.pendingTeam
    if (!team) return []
    return (this.data['roster' + team] || []).filter(function (m) { return m.checked })
  },

  addPoint: function () {
    const d = this.data
    if (!d.pendingTeam || !d.pendingScorer) return
    const lineup = this.lineupOfPending()
    const scorer = findIn(lineup, d.pendingScorer)
    // refreshPending 已经保证得分队员还在场上；这里再兜一次，避免状态被绕过后记下无效的一分
    if (!scorer) return
    const assist = d.pendingAssist ? findIn(lineup, d.pendingAssist) : null
    const points = d.points.concat([{
      key: 'p' + (this._ptSeq++),
      team: d.pendingTeam,
      scorer: d.pendingScorer,
      scorerName: scorer ? scorer.name : '',
      assist: assist ? assist._id : '',
      assistName: assist ? assist.name : '',
    }])
    this.setData({
      points: points,
      pendingScorer: '',
      pendingAssist: '',
    }, function () {
      this.refreshScore()
      this.refreshMvp()
      this.refreshPending()
    }.bind(this))
  },

  /** 撤销某一分。记错了马上能改，不用整场重录。 */
  removePoint: function (e) {
    const i = Number(e.currentTarget.dataset.index)
    const points = this.data.points.slice()
    points.splice(i, 1)
    this.setData({ points: points }, function () {
      this.refreshScore()
      this.refreshMvp()
    }.bind(this))
  },

  undoPoint: function () {
    if (!this.data.points.length) return
    const points = this.data.points.slice()
    points.pop()
    this.setData({ points: points }, function () {
      this.refreshScore()
      this.refreshMvp()
    }.bind(this))
  },

  /**
   * 比分。有明细时由明细条数算出来；升级前的老比赛没有明细，就用存档的比分，
   * 否则一打开就把 15:10 显示成 0:0，还存不回去。
   */
  refreshScore: function () {
    const manual = this.data.manualScore
    if (manual) {
      this.setData({
        scoreA: manual.a,
        scoreB: manual.b,
        scoreText: manual.a + ' : ' + manual.b,
        pointsText: '升级前录入，只有比分',
        canAddPoint: false,
      })
      return
    }
    let a = 0
    let b = 0
    this.data.points.forEach(function (p) {
      if (p.team === 'A') a++
      else if (p.team === 'B') b++
    })
    this.setData({
      scoreA: a,
      scoreB: b,
      scoreText: a + ' : ' + b,
      pointsText: '共 ' + this.data.points.length + ' 分',
    })
  },

  /**
   * 把老比赛切成逐分记录模式。
   *
   * 必须显式确认：切过去之后比分改由明细算，原来手填的 15:10 就没了，
   * 而半场明细配上整场比分只会把比分改错，所以不做自动迁移。
   */
  startDetail: function () {
    const that = this
    const manual = this.data.manualScore
    if (!manual) return
    wx.showModal({
      title: '改为逐分记录',
      content: '原来的比分 ' + manual.a + ' : ' + manual.b +
        ' 会被清掉，改由逐分记录算出来。需要把整场比赛的每一分都重新记上。要继续吗？',
      confirmText: '继续',
      success: function (r) {
        if (!r.confirm) return
        that.setData({ manualScore: null, points: [], mvpIds: [] }, function () {
          that.refreshScore()
          that.refreshMvp()
        })
      },
    })
  },

  // ---------------------------------------------------------------- 阶段三：比赛结束

  /**
   * 重算 MVP 候选。规则是胜方从败方的上场队员里选，所以候选名单随比分变化——
   * 直接把范围限定死，比让组织者选完再报错好。
   */
  refreshMvp: function () {
    const a = this.data.scoreA
    const b = this.data.scoreB

    if (a === 0 && b === 0) {
      this.setData({ mvpCandidates: [], mvpSide: '' })
      return
    }
    if (a === b) {
      this.setData({ mvpCandidates: [], mvpSide: '' })
      return
    }

    const loserSide = a > b ? 'B' : 'A'
    const roster = this.data['roster' + loserSide] || []
    const candidates = roster.filter(function (m) { return m.checked })

    // 比分改变可能让原来选的 MVP 变成胜方的人，这里把失效的清掉。
    const validIds = candidates.map(function (m) { return m._id })
    const keep = this.data.mvpIds.filter(function (id) { return validIds.indexOf(id) >= 0 })

    this.setData({
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
        warn('最多选 2 名 MVP')
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

  refreshForfeits: function () {
    const all = (this.data.rosterA || []).concat(this.data.rosterB || [])
    const ids = this.data.forfeitIds || []
    this.setData({
      forfeitCandidates: all.map(function (m) {
        return {
          _id: m._id,
          name: m.name,
          // 已经在场上的人不可能弃赛，直接不给他选
          selectable: !m.checked,
          selected: ids.indexOf(m._id) >= 0,
        }
      }),
    })
  },

  toggleForfeit: function (e) {
    const id = e.currentTarget.dataset.id
    const row = this.data.forfeitCandidates.filter(function (c) { return c._id === id })[0]
    if (row && !row.selectable && this.data.forfeitIds.indexOf(id) < 0) {
      warn('他在这场已经上场了，不能同时记弃赛')
      return
    }
    const ids = this.data.forfeitIds.slice()
    const at = ids.indexOf(id)
    if (at >= 0) ids.splice(at, 1)
    else ids.push(id)
    this.setData({ forfeitIds: ids }, function () {
      this.refreshMvp()
      this.refreshForfeits()
    }.bind(this))
  },

  // ---------------------------------------------------------------- 提交

  /**
   * 保存。stage 决定两件事：
   *  - 比赛状态：比赛中存 live（列表上标「进行中」），比赛结束存 finished
   *  - 存完去哪：暂存留在本页继续记，结束才退回上一页
   *
   * scoreA / scoreB 随明细一起提交：v1.0.1 的云函数会按明细重算、不采信这两个值，
   * 但**部署窗口期内线上还可能是旧云函数**，旧版只认手填比分，带上就两边都能存。
   *
   * MVP 和弃赛照原样带上而不是清空：比赛中它们本来就是空的，而"结束过的比赛又回炉重记"
   * 时清空会静默丢数据。真有冲突（比如比分变了导致 MVP 落在胜方）云函数会明确报错，
   * 记分员能回到第三阶段改，不会悄悄丢掉。
   */
  submit: function (final) {
    const that = this
    const d = this.data
    if (!this.checkLineup()) return

    const a = d.scoreA
    const b = d.scoreB
    if (a === 0 && b === 0) return warn('还没有记录任何得分，先记一分再保存')
    if (a === b) return warn('不允许平局，请把分出胜负的每一分都记上')

    this.setData({ submitting: true })
    api.match('saveMatch', {
      tournamentId: d.tournamentId,
      matchId: d.matchId,
      teamAIndex: d.teamAIndex,
      teamBIndex: d.teamBIndex,
      scoreA: a,
      scoreB: b,
      points: d.points.map(function (p) {
        return { team: p.team, scorer: p.scorer, assist: p.assist || null }
      }),
      participantsA: idsOf(d.rosterA),
      participantsB: idsOf(d.rosterB),
      mvpIds: d.mvpIds,
      forfeitIds: d.forfeitIds,
      status: final ? 'finished' : 'live',
    }, { loading: '保存中' })
      .then(function (res) {
        const id = (res && res._id) || d.matchId
        // 暂存后 id 就固定下来了，再存是更新同一条，不会多出一场
        that.setData({ submitting: false, matchId: id })
        if (!final) {
          wx.showToast({ title: '已暂存，可以继续记分', icon: 'success' })
          return
        }
        that._saved = true
        wx.showToast({ title: '比赛已结束', icon: 'success' })
        setTimeout(function () { wx.navigateBack() }, 700)
      })
      .catch(function () {
        that.setData({ submitting: false })
      })
  },

  saveLive: function () { this.submit(false) },
  finishAndSave: function () { this.submit(true) },

  goLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },

  goStats: function () {
    wx.navigateTo({ url: '/pages/stats/stats?eventId=' + this.data.eventId })
  },
})

function idsOf (roster) {
  return (roster || []).filter(function (m) { return m.checked })
    .map(function (m) { return m._id })
}

function countChecked (roster) {
  return (roster || []).filter(function (m) { return m.checked }).length
}

function findIn (list, id) {
  return (list || []).filter(function (m) { return m._id === id })[0] || null
}

function warn (msg) {
  wx.showToast({ title: msg, icon: 'none' })
}
