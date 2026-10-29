'use strict'

const api = require('../../utils/api.js')
const eventConfig = require('../../utils/event-config.js')
const fmt = require('../../utils/format.js')

const LEVEL_SHEET = ['L1', 'L2', 'L3', 'L4', 'L5', '恢复为自评水平']

Page({
  data: {
    eventId: '',
    loading: true,
    failMessage: '',
    event: null,
    statusText: '',
    isOwner: false,
    boardLabel: '积分榜',
    roster: [],
    constraints: [],
    summary: '',
    levelBars: [],
    // 添加约束的选人面板
    picking: false,
    pickType: 'together',
    pickTypeText: '',
    pickedIds: [],
    pickedNames: '',
    // 测试数据（仅管理员）
    isAdmin: false,
    testCount: 0,
    seedOptions: [8, 16, 24],
    importing: false,
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

  load: function () {
    const that = this
    return api.event('detail', { eventId: this.data.eventId }, { loading: false, toastError: false })
      .then(function (d) {
        that.setData({
          event: d.event,
          statusText: fmt.statusText(d.event.status),
          boardLabel: eventConfig.boardLabel(d.event.type),
          isOwner: !!d.isOwner,
        })
        if (!d.canManage) {
          // 组织者和管理员对**所有**活动都有管理权，所以这里挡的其实是"一般用户
          // 直接改 URL 进来"。真正的拦截在云函数里，这里只是别让页面渲染成空的。
          that.setData({ loading: false, failMessage: '你没有这场活动的管理权限' })
          return null
        }
        return Promise.all([
          api.signup('listAll', { eventId: that.data.eventId }, { loading: false }),
          api.team('listConstraints', { eventId: that.data.eventId }, { loading: false }),
          // 只用来决定测试数据卡片显不显示，真正的拦截在云函数里
          api.admin('whoami', {}, { loading: false, toastError: false })
            .catch(function () { return { isAdmin: false } }),
        ]).then(function (r) {
          that.applyData(r[0].list || [], r[1].list || [])
          that.setData({ loading: false, failMessage: '', isAdmin: !!r[2].isAdmin })
        })
      })
      .catch(function (e) {
        that.setData({ loading: false, failMessage: e.message })
      })
  },

  applyData: function (roster, constraints) {
    const nameById = {}
    const decorated = roster.map(function (s, i) {
      nameById[s._id] = s.name
      // 活动采集了哪些字段就显示哪些：班级/学号/年龄只有在组织者开启采集时才有值，
      // 全都拼成一行，避免每个字段占一行把名单拉得很长
      const extras = []
      if (s.age !== '' && s.age !== null && s.age !== undefined) extras.push(s.age + ' 岁')
      if (s.className) extras.push(s.className)
      if (s.studentId) extras.push('学号 ' + s.studentId)
      return Object.assign({}, s, {
        seq: i + 1,
        genderText: fmt.genderText(s.gender),
        levelText: fmt.levelText(s.level),
        overridden: s.adminLevel != null,
        extraText: extras.join(' · '),
      })
    })
    const testCount = decorated.filter(function (s) { return s.isTest }).length

    let male = 0; let female = 0
    const buckets = [0, 0, 0, 0, 0]
    decorated.forEach(function (s) {
      if (s.gender === 'M') male++
      else if (s.gender === 'F') female++
      if (s.level >= 1 && s.level <= 5) buckets[s.level - 1]++
    })
    const max = Math.max.apply(null, buckets.concat([1]))
    const levelBars = buckets.map(function (n, i) {
      return { level: i + 1, count: n, percent: Math.round((n / max) * 100) }
    })

    this.setData({
      roster: decorated,
      nameById: nameById,
      constraints: constraints.map(function (c) {
        return {
          _id: c._id,
          type: c.type,
          typeText: c.type === 'together' ? '必须同队' : '必须拆开',
          signupIds: c.signupIds,
          names: c.signupIds.map(function (id) { return nameById[id] || '(已退出)' }).join('、'),
        }
      }),
      summary: decorated.length + ' 人报名 · ' + male + ' 男 ' + female + ' 女' +
        (testCount > 0 ? '（含 ' + testCount + ' 个测试）' : ''),
      testCount: testCount,
      levelBars: levelBars,
    })
  },

  // ---------------- 水平覆盖 ----------------

  editLevel: function (e) {
    const that = this
    const row = this.data.roster[e.currentTarget.dataset.index]
    wx.showActionSheet({
      itemList: LEVEL_SHEET,
      success: function (r) {
        const adminLevel = r.tapIndex === 5 ? null : r.tapIndex + 1
        api.signup('updateLevel', {
          eventId: that.data.eventId,
          signupId: row._id,
          adminLevel: adminLevel,
        }, { loading: '保存中' })
          .then(function () { that.load() })
          .catch(function () {})
      },
    })
  },

  // ---------------- 删除报名 ----------------

  /**
   * 删掉一条报名。用于"报了名但确实不该在名单里"（重复、填错、临时不来）。
   * 已经被某场赛事赛前检录的人会被云函数拒绝，这里把原因先写在确认框里，
   * 免得点了才知道。
   */
  removeSignup: function (e) {
    const that = this
    const row = this.data.roster[e.currentTarget.dataset.index]
    wx.showModal({
      title: '删除报名',
      content: '把「' + row.name + '」从报名名单里删掉？名额会归还。\n' +
        '如果他已经在某场赛事的赛前检录名单里，需要先把他移出检录（或删掉那场赛事）。',
      confirmText: '删除',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        api.signup('removeSignup', {
          eventId: that.data.eventId,
          signupId: row._id,
        }, { loading: '删除中' })
          .then(function (d) {
            if (d && d.constraintsTouched > 0) {
              wx.showToast({ title: '已删除，相关约束也一并清理', icon: 'none', duration: 2500 })
            }
            return that.load()
          })
          .catch(function () {})
      },
    })
  },

  // ---------------- 约束 ----------------

  startPick: function (e) {
    const type = e.currentTarget.dataset.type
    this.setData({
      picking: true,
      pickType: type,
      pickTypeText: type === 'together' ? '必须同队' : '必须拆开',
      pickedIds: [],
      pickedNames: '',
    })
  },

  cancelPick: function () {
    this.setData({ picking: false, pickedIds: [], pickedNames: '' })
  },

  togglePick: function (e) {
    const id = e.currentTarget.dataset.id
    const ids = this.data.pickedIds.slice()
    const at = ids.indexOf(id)
    if (at >= 0) ids.splice(at, 1)
    else ids.push(id)
    const nameById = this.data.nameById || {}
    this.setData({
      pickedIds: ids,
      pickedNames: ids.map(function (x) { return nameById[x] }).join('、'),
    })
  },

  confirmPick: function () {
    if (this.data.pickedIds.length < 2) {
      wx.showToast({ title: '至少选 2 个人', icon: 'none' })
      return
    }
    const next = this.data.constraints.map(function (c) {
      return { type: c.type, signupIds: c.signupIds }
    })
    next.push({ type: this.data.pickType, signupIds: this.data.pickedIds })
    this.saveConstraints(next, '已添加约束')
  },

  removeConstraint: function (e) {
    const idx = e.currentTarget.dataset.index
    const that = this
    wx.showModal({
      title: '删除约束',
      content: '删除「' + this.data.constraints[idx].names + '」这条约束？',
      success: function (r) {
        if (!r.confirm) return
        const next = that.data.constraints
          .filter(function (c, i) { return i !== idx })
          .map(function (c) { return { type: c.type, signupIds: c.signupIds } })
        that.saveConstraints(next, '已删除')
      },
    })
  },

  /** 约束是覆盖式保存：整份提交，不做增量，避免两边状态不一致。 */
  saveConstraints: function (list, toast) {
    const that = this
    api.team('setConstraints', {
      eventId: this.data.eventId,
      constraints: list,
    }, { loading: '保存中' })
      .then(function () {
        wx.showToast({ title: toast, icon: 'success' })
        that.setData({ picking: false, pickedIds: [], pickedNames: '' })
        that.load()
      })
      .catch(function () {})
  },

  // ---------------- 报名开关与分队 ----------------

  toggleSignup: function () {
    const that = this
    const open = this.data.event.status === 'open'
    api.event(open ? 'closeSignup' : 'reopenSignup', { eventId: this.data.eventId },
      { loading: '处理中' })
      .then(function () { that.load() })
      .catch(function () {})
  },

  editEvent: function () {
    wx.navigateTo({ url: '/pages/event-edit/event-edit?eventId=' + this.data.eventId })
  },

  goRandomEvents: function () {
    wx.navigateTo({ url: '/pages/random-events/random-events?eventId=' + this.data.eventId })
  },

  // ---------------- 测试数据（仅管理员） ----------------

  seedTest: function (e) {
    const count = Number(e.currentTarget.dataset.count)
    const that = this
    wx.showModal({
      title: '生成测试数据',
      content: '往这个活动里加 ' + count + ' 个假报名（名字带「测试」，随机性别和水平），' +
        '会占用名额。测完记得清掉。',
      confirmText: '生成',
      success: function (r) {
        if (!r.confirm) return
        api.signup('seedTestSignups', {
          eventId: that.data.eventId,
          count: count,
        }, { loading: '生成中' })
          .then(function (d) {
            wx.showToast({ title: '已加 ' + d.added + ' 人', icon: 'success' })
            return that.load()
          })
          .catch(function () {})
      },
    })
  },

  clearTest: function () {
    const that = this
    wx.showModal({
      title: '清理测试数据',
      content: '删掉这个活动里全部 ' + this.data.testCount + ' 个测试报名，并归还名额。' +
        '约束里涉及测试选手的部分也会一起清掉。',
      confirmText: '清理',
      confirmColor: '#b4322c',
      success: function (r) {
        if (!r.confirm) return
        // 测试选手已进赛事时云函数会拒绝，报错弹窗比 toast 更容易看清该删哪场
        api.signup('clearTestSignups', { eventId: that.data.eventId },
          { loading: '清理中', toastError: false })
          .then(function (d) {
            wx.showToast({ title: '已清理 ' + d.removed + ' 人', icon: 'success' })
            return that.load()
          })
          .catch(function (err) {
            wx.showModal({ title: '没能清理', content: err.message, showCancel: false })
          })
      },
    })
  },

  // ---------------- 导入名单 ----------------

  importRoster: function () {
    const that = this
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      // extension 里不能带前导点：传 '.xlsx' 会让过滤条件失效（选不出文件）
      extension: ['xlsx', 'xls'],
      success: function (pick) {
        const file = pick.tempFiles && pick.tempFiles[0]
        if (!file || !file.path) {
          wx.showModal({
            title: '没拿到文件',
            content: '微信没有返回文件路径，可能是文件已被撤回或清理。请重新在聊天记录里选择一次。',
            showCancel: false,
          })
          return
        }
        const name = file.name || ''
        if (!/\.(xlsx|xls)$/i.test(name)) {
          wx.showModal({ title: '文件格式不对', content: '请选择 .xlsx 或 .xls 文件', showCancel: false })
          return
        }
        wx.showModal({
          title: '导入名单',
          content: '将把表格中的姓名、性别、能力追加到当前活动，并占用名额。已导入的名单不会关联微信账号，确认继续？',
          confirmText: '导入',
          success: function (r) {
            if (!r.confirm) return
            that.setData({ importing: true })
            const cloudPath = 'imports/' + that.data.eventId + '/' + Date.now() + '-' + name.replace(/[^A-Za-z0-9._-]/g, '_')
            let fileID = ''
            let cleaned = false
            function cleanup () {
              if (!fileID || cleaned || !wx.cloud.deleteFile) return Promise.resolve()
              cleaned = true
              return wx.cloud.deleteFile({ fileList: [fileID] }).catch(function () {})
            }
            wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: file.path })
              .then(function (uploaded) {
                fileID = uploaded.fileID
                return api.signup('importSignups', {
                  eventId: that.data.eventId,
                  fileID: fileID,
                }, { loading: '导入中', toastError: false })
              })
              .then(function (d) {
                return cleanup().then(function () {
                  wx.showToast({ title: '已导入 ' + d.imported + ' 人', icon: 'success' })
                  return that.load()
                })
              })
              .catch(function (e) {
                return cleanup().then(function () {
                  wx.showModal({
                    title: '导入失败',
                    content: importFailureText(e),
                    showCancel: false,
                  })
                })
              })
              .then(function () { that.setData({ importing: false }) })
          },
        })
      },
      fail: function (e) {
        // 用户主动取消不算错误，不要弹窗
        if (e && /cancel/i.test(e.errMsg || '')) return
        wx.showModal({
          title: '没能选择文件',
          content: (e && e.errMsg) || '未知原因，请重试',
          showCancel: false,
        })
      },
    })
  },

  goTournaments: function () {
    wx.navigateTo({ url: '/pages/tournaments/tournaments?eventId=' + this.data.eventId })
  },

  viewLeaderboard: function () {
    wx.navigateTo({ url: '/pages/leaderboard/leaderboard?eventId=' + this.data.eventId })
  },
})

/**
 * 导入失败弹窗的正文。
 *
 * 只说一句「导入失败」没法排查：可能是表格格式不对、名额不够、云函数没部署、
 * 依赖没装、或者恰好超时——处理方式完全不同。所以正文里一定带上具体说法和错误码，
 * 格式问题还要说明一共几处（服务端只列前 10 条，否则弹窗会很长）。
 */
function importFailureText (e) {
  const parts = [(e && e.message) || '未知原因，请重试']
  const detail = e && e.detail
  if (detail && Array.isArray(detail.errors) && detail.errors.length > 10) {
    parts.push('表格里一共有 ' + detail.errors.length + ' 处问题，上面只列出前 10 条。')
  }
  if (e && e.code) parts.push('错误码：' + e.code)
  return parts.join('\n')
}
