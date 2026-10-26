'use strict'

const api = require('../../utils/api.js')
const mr = require('../../utils/match-rules.js')

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

    // 自动暂存的状态提示（v1.1.1）：空串表示还没存过，等第一次记分后才出现
    autoSaveText: '',
    autoSaveFailed: false,

    // ---- 时间轴（v1.1.4） ----
    // rules 来自赛事级配置；startedAt 是服务端给的开表时刻，0 表示还没开表
    rules: mr.DEFAULT_RULES,
    startedAt: 0,
    // 比赛结束时刻：填上之后时间轴就定格在"打完那一刻"，不会随着打开页面又往前走
    endedAt: 0,
    clockText: '0:00',
    clockTargetText: '',
    clockHint: '',
    clockPhase: '',
    notes: '',
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
        // 规则挂在赛事上，顺手把比赛列表也取回来：编辑已有比赛时正好用它回填，
        // 新开一场时只用其中的 rules。
        return that.loadMatches().then(function () {
          if (q.matchId) return that.prefill(q.matchId)
          return null
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  onShow: function () {
    // 从后台回来时把计时器接上（onHide 里会清掉）
    this.startTicking()
  },

  /**
   * 切后台时补一次保存。
   *
   * 系统回收小程序不会给 onUnload，onHide 是最后一个能跑的时机——虽然请求可能在页面
   * 销毁后才回来，但发出去就有机会成功；真正的兜底是"记一分存一次"。
   */
  onHide: function () {
    this.stopTicking()
    if (this.data.manualScore) return
    if (!this.data.points.length) return
    this.autoSave()
  },

  onUnload: function () {
    this.stopTicking()
    // 正常情况下每一分都已经自动存过了。只有保存失败过才会走到这里。
    if (this._saved || this.data.submitting) return
    if (!this.data.points.length) return
    if (!this.data.autoSaveFailed) return
    wx.showToast({ title: '这次记录还没保存', icon: 'none' })
  },

  /** 取赛事规则 + 比赛列表。规则只有这里能拿到（listMatches 一起返回）。 */
  loadMatches: function () {
    const that = this
    return api.match('listMatches', { tournamentId: this.data.tournamentId },
      { loading: false, toastError: false })
      .then(function (d) {
        that._matches = d.list || []
        that.setData({
          eventId: d.eventId || that.data.eventId,
          rules: mr.normalizeRules(d.rules),
        })
        that.tickClock()
      })
      .catch(function () {
        that._matches = []
      })
  },

  /** 修改已有比赛时回填。用 loadMatches 已经取回的列表，不再重复请求。 */
  prefill: function (matchId) {
    const that = this
    const m = (this._matches || []).filter(function (x) { return x._id === matchId })[0]
    if (!m) {
      this.setData({ failMessage: '找不到这场比赛，可能已被删除' })
      return Promise.resolve()
    }
    const idsA = m.participantsA.map(function (p) { return p._id })
    const idsB = m.participantsB.map(function (p) { return p._id })
    const hasPoints = (m.points || []).length > 0
    this.setData({
      teamAIndex: m.teamAIndex,
      teamBIndex: m.teamBIndex,
      teamAName: m.teamAName,
      teamBName: m.teamBName,
      rosterA: this.buildRoster(m.teamAIndex, idsA),
      rosterB: this.buildRoster(m.teamBIndex, idsB),
      points: this.decoratePoints(m.points || []),
      manualScore: hasPoints ? null : { a: m.scoreA, b: m.scoreB },
      mvpIds: m.mvps.map(function (p) { return p._id }),
      forfeitIds: (m.forfeits || []).map(function (p) { return p._id }),
      startedAt: m.startedAt || 0,
      endedAt: m.endedAt || 0,
      notes: m.notes || '',
      // 已结束的比赛直接落在第三阶段：打开就是看结果，不必再回到记分界面。
      stage: m.status === 'live' ? STAGE_LIVE : STAGE_DONE,
    }, function () {
      that.refreshScore()
      that.refreshMvp()
      that.refreshForfeits()
      that.refreshPending()
      that.tickClock()
      that.startTicking()
    })
    return Promise.resolve()
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
        // 相对开表的秒数，时间轴按它画；老比赛为 null
        t: typeof p.t === 'number' ? p.t : null,
        timeText: typeof p.t === 'number' ? mr.formatClock(p.t) : '',
      }
    })
  },

  // ---------------------------------------------------------------- 时间轴

  /**
   * 每秒重算一次时间轴。
   *
   * 只改显示用的几个字段，不动 points，所以不会触发列表重排。
   * 没开表或不在记分阶段就不需要计时器。
   */
  tickClock: function () {
    const d = this.data
    // 已结束的比赛按结束时刻算，否则打开旧比赛会看到"已用时 3000:00"
    const now = d.endedAt > 0 ? d.endedAt : Date.now()
    const st = mr.clockState(d.rules, d.startedAt, d.points, now)
    const raised = st.targetRaised ? '（软时限后调整）' : ''
    let phase = ''
    if (st.halfReached) {
      phase = st.inBreak
        ? '中场休息'
        : (st.halfReason === 'score' ? '上半场已过半' : '已过中场时刻')
    }
    this.setData({
      clockText: mr.formatClock(st.elapsedSec),
      clockTargetText: '目标 ' + st.target + ' 分' + raised,
      clockHint: mr.clockHint(st),
      clockPhase: phase,
    })
  },

  startTicking: function () {
    if (this._timer) return
    if (!this.data.startedAt) return
    if (this.data.stage === STAGE_LINEUP) return
    const that = this
    this._timer = setInterval(function () { that.tickClock() }, 1000)
  },

  stopTicking: function () {
    if (!this._timer) return
    clearInterval(this._timer)
    this._timer = null
  },

  /**
   * 开表。单独一次保存（0:0 的 live 记录），而不是等第一分。
   *
   * 为什么不让"进第二阶段"自动开表：那会凭空在比赛列表里创建一个 0:0 的进行中记录，
   * 只是点错标签页也会留下垃圾数据。让记分员明确点一下「开始计时」更诚实。
   */
  startClock: function () {
    const d = this.data
    if (d.startedAt > 0 || d.manualScore || d.submitting) return
    if (!this.checkLineup()) return

    const that = this
    this.setData({ autoSaveText: '开表中…' })
    api.match('saveMatch', this.buildPayload('live'), { loading: '开表中', toastError: true })
      .then(function (res) {
        that.setData({
          matchId: (res && res._id) || d.matchId,
          startedAt: (res && res.startedAt) || Date.now(),
          autoSaveText: '已开始计时',
          autoSaveFailed: false,
        })
        that._saved = true
        that.startTicking()
        that.tickClock()
      })
      .catch(function () {
        that.setData({ autoSaveText: '开表失败，点此重试', autoSaveFailed: true })
      })
  },

  onNotesInput: function (e) {
    // 备注不单独存：它包含在每次自动暂存和手动保存里
    this.setData({ notes: e.detail.value })
  },

  // ---------------------------------------------------------------- 阶段切换

  gotoLive: function () {
    if (!this.checkLineup()) return
    this.setData({ stage: STAGE_LIVE }, function () {
      this.refreshPending()
      this.startTicking()
      this.tickClock()
    }.bind(this))
  },

  gotoDone: function () {
    if (!this.checkLineup()) return
    this.setData({ stage: STAGE_DONE }, function () {
      this.refreshMvp()
      // 进了结束阶段就不再需要秒级刷新，把计时器停掉省电
      this.stopTicking()
      this.tickClock()
    }.bind(this))
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
    // 记下这一刻：相对开表的秒数。没开表就是 null（事后补记的比赛没有时间轴）
    const t = d.startedAt > 0
      ? Math.max(0, Math.floor((Date.now() - d.startedAt) / 1000))
      : null
    const points = d.points.concat([{
      key: 'p' + (this._ptSeq++),
      team: d.pendingTeam,
      scorer: d.pendingScorer,
      scorerName: scorer ? scorer.name : '',
      assist: assist ? assist._id : '',
      assistName: assist ? assist.name : '',
      t: t,
      timeText: t === null ? '' : mr.formatClock(t),
    }])
    this.setData({
      points: points,
      pendingScorer: '',
      pendingAssist: '',
    }, function () {
      this.refreshScore()
      this.refreshMvp()
      this.refreshPending()
      this.tickClock()
      this.autoSave()
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
      this.tickClock()
      this.autoSave()
    }.bind(this))
  },

  undoPoint: function () {
    if (!this.data.points.length) return
    const points = this.data.points.slice()
    points.pop()
    this.setData({ points: points }, function () {
      this.refreshScore()
      this.refreshMvp()
      this.tickClock()
      this.autoSave()
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
   * **比赛中的暂存允许平局**：记分过程中随时可能持平，不允许的话每次持平都存不下去，
   * 闪退就丢数据（这正是 v1.1.1 要修的问题）。只有"结束"才要求分出胜负。
   *
   * scoreA / scoreB 随明细一起提交：v1.1.0 的云函数会按明细重算、不采信这两个值，
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
    if (final && a === b) return warn('不允许平局，请把分出胜负的每一分都记上')

    this.setData({ submitting: true })
    api.match('saveMatch', this.buildPayload(final ? 'finished' : 'live'),
      { loading: '保存中' })
      .then(function (res) {
        const id = (res && res._id) || d.matchId
        // 暂存后 id 就固定下来了，再存是更新同一条，不会多出一场
        that.setData({ submitting: false, matchId: id })
        if (!final) {
          that.setData({ autoSaveText: '已保存', autoSaveFailed: false })
          wx.showToast({ title: '已暂存，可以继续记分', icon: 'success' })
          return
        }
        that._saved = true
        // 定格时间轴：之后再看这场比赛，用时就是打完那一刻
        that.setData({ endedAt: Date.now() })
        that.tickClock()
        wx.showToast({ title: '比赛已结束', icon: 'success' })
        setTimeout(function () { wx.navigateBack() }, 700)
      })
      .catch(function () {
        that.setData({ submitting: false })
      })
  },

  saveLive: function () { this.submit(false) },
  finishAndSave: function () { this.submit(true) },

  /** 提交给 saveMatch 的数据。手动保存和自动暂存共用，避免两边字段漂移。 */
  buildPayload: function (status) {
    const d = this.data
    return {
      tournamentId: d.tournamentId,
      matchId: d.matchId,
      teamAIndex: d.teamAIndex,
      teamBIndex: d.teamBIndex,
      scoreA: d.scoreA,
      scoreB: d.scoreB,
      points: d.points.map(function (p) {
        return {
          team: p.team,
          scorer: p.scorer,
          assist: p.assist || null,
          // 相对开表的秒数；没开表就带 null，服务端按"没有时间轴"存
          t: p.t === null || p.t === undefined ? null : p.t,
        }
      }),
      participantsA: idsOf(d.rosterA),
      participantsB: idsOf(d.rosterB),
      mvpIds: d.mvpIds,
      forfeitIds: d.forfeitIds,
      status: status,
      notes: d.notes,
    }
  },

  // ---------------------------------------------------------------- 自动暂存

  /**
   * 记一分就自动暂存一次（v1.1.1）。
   *
   * 为什么要逐分保存：小程序被系统回收、切后台久了被杀、真闪退，都不会给页面任何回调，
   * 只存在内存里的比分就没了。所以只能把"记一分"和"存一次"绑在一起。
   *
   * 三个刻意的设计：
   *  - **静默**：不弹 loading、不弹 toast，否则每记一分就打断一次现场操作
   *  - **单飞 + 脏标记**：同一时刻只有一个请求在飞；飞的过程中又记了分，等它回来再存最新状态，
   *    所以连点几下不会排队发一串请求，也不会用旧状态覆盖新状态
   *  - **比分持平时也照存**：记分过程中随时可能打平，这正是原来手动暂存失败的原因
   */
  autoSave: function () {
    const d = this.data
    // 老比赛只有比分没有明细，没有可自动暂存的东西
    if (d.manualScore) return Promise.resolve()
    // 一分都没记过就不创建空比赛
    if (!d.matchId && d.points.length === 0) return Promise.resolve()
    if (d.teamAIndex === null || d.teamBIndex === null) return Promise.resolve()

    this._dirty = true
    if (this._saving) return this._saving

    const that = this
    this.setData({ autoSaveText: '保存中…', autoSaveFailed: false })

    function saveOnce () {
      that._dirty = false
      return api.match('saveMatch', that.buildPayload('live'),
        { loading: false, toastError: false })
        .then(function (res) {
          const id = (res && res._id) || that.data.matchId
          that.setData({
            matchId: id,
            // 服务端在第一次 live 保存时定开表时刻，客户端拿回来才能画出真实时间轴
            startedAt: that.data.startedAt || (res && res.startedAt) || 0,
            autoSaveText: '已自动保存',
            autoSaveFailed: false,
          })
          that._saved = true
          that.startTicking()
        })
        .catch(function () {
          // 不弹 toast：现场正在记分，弹窗会挡住操作。改成可点的状态提示。
          // _dirty 保持为 true：这些分确实还没进库；但下面不能立刻重试，
          // 否则网络断了会变成一个死循环，一直往服务端打请求。
          that._dirty = true
          that.setData({ autoSaveText: '未保存，点此重试', autoSaveFailed: true })
        })
        .then(function () {
          that._saving = null
          // 保存期间又记了分 → 接着存最新状态；上次失败就先不动，等下一次记分或手动重试
          if (that._dirty && !that.data.autoSaveFailed) return that.autoSave()
        })
    }

    this._saving = saveOnce()
    return this._saving
  },

  retryAutoSave: function () {
    if (!this.data.autoSaveFailed) return
    this.autoSave()
  },

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
