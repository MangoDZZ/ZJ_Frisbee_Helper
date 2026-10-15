'use strict'

/**
 * 报名管理云函数。
 *
 * 名额上限的并发控制是这个文件的重点，见 submit。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const common = require('./lib/common.js')
const roles = require('./lib/roles.js')
const store = require('./lib/store.js')
const importList = require('./lib/import-list.js')

const db = cloud.database()
const _ = db.command
const events = db.collection('events')
const signups = db.collection('signups')
const tournaments = db.collection('tournaments')

const ok = common.ok
const err = common.err
const trimStr = common.trimStr
const asInt = common.asInt
const fetchAll = common.fetchAll
const fetchByIds = common.fetchByIds
const removeWhere = common.removeWhere

const MIN_LEVEL = 1
const MAX_LEVEL = 5
const MAX_IMPORT_ROWS = 500

// ---------------------------------------------------------------- 测试数据

const MAX_TEST_SEED = 60

const TEST_SURNAMES = '王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗'
const TEST_GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '勇', '艳', '杰',
  '涛', '明', '超', '霞', '平', '刚', '桂', '丹', '萍', '鑫']

// 水平分布：以 3 为中心，两头少——接近真实俱乐部，均衡效果才测得出来。
const TEST_LEVEL_WEIGHTS = [0.1, 0.2, 0.35, 0.25, 0.1]
const TEST_FEMALE_RATIO = 0.4

function pickWeighted (weights) {
  let r = Math.random()
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r < 0) return i
  }
  return weights.length - 1
}

/**
 * 生成一个假报名。openid 带 test- 前缀且全局唯一，不会撞上 signups 的
 * (eventId, openid) 唯一索引，也不会和任何真实微信用户重合。
 */
function makeTestSignup (eventId, batch, i) {
  const gender = Math.random() < TEST_FEMALE_RATIO ? 'F' : 'M'
  const level = pickWeighted(TEST_LEVEL_WEIGHTS) + 1
  const name = '测试' +
    TEST_SURNAMES[Math.floor(Math.random() * TEST_SURNAMES.length)] +
    TEST_GIVEN[Math.floor(Math.random() * TEST_GIVEN.length)] + (i + 1)
  const now = Date.now()
  return {
    eventId: eventId,
    openid: 'test-' + batch + '-' + i,
    name: name,
    gender: gender,
    selfLevel: level,
    adminLevel: null,
    phone: '',
    remark: '测试数据',
    status: 'signed',
    isTest: true,
    createTime: now + i,      // 错开 1ms，名单顺序稳定
    updateTime: now,
  }
}

/**
 * 管理权校验。管理员和组织者可以管任意活动，创建者管自己建的活动。
 * 球员水平只在这条路径上返回，其他任何出口都不带 level——参与者只能看到自己的自评。
 */
function requireManage (evt, r) {
  if (!roles.canManageEvent(r, evt)) {
    return err('FORBIDDEN', '只有活动创建者、组织者或管理员可以进行此操作')
  }
  return null
}

/**
 * 哪些赛事的**赛前检录名单**里出现了这些人。
 *
 * 删报名前必须为空：赛事记录的是 signupId，人删了就会留下指向不存在的人的引用，
 * 而分队名单和比赛记录都以这份检录名单为基准。
 */
async function tournamentsUsing (eventId, signupIds) {
  const list = await fetchAll(function () {
    return tournaments.where({ eventId: eventId }).field({ name: true, attendeeIds: true })
  }, { label: '活动赛事' })
  return list.filter(function (t) {
    const ids = t.attendeeIds || []
    return ids.some(function (id) { return signupIds.indexOf(id) >= 0 })
  })
}

/**
 * 把这些人从活动的分队约束里摘掉；摘完不足 2 人的整条删除。
 * 返回受影响的约束条数（调用方可以据此提示用户"约束也动了"）。
 */
async function stripFromConstraints (eventId, signupIds) {
  const consCol = db.collection('constraints')
  const cons = await fetchAll(function () {
    return consCol.where({ eventId: eventId }).field({ signupIds: true })
  }, { label: '活动约束' })

  let touched = 0
  for (let i = 0; i < cons.length; i++) {
    const ids = cons[i].signupIds || []
    const kept = ids.filter(function (id) { return signupIds.indexOf(id) < 0 })
    if (kept.length === ids.length) continue
    if (kept.length < 2) await consCol.doc(cons[i]._id).remove()
    else await consCol.doc(cons[i]._id).update({ data: { signupIds: kept } })
    touched++
  }
  return touched
}

function validateSignup (d) {
  const name = trimStr(d.name)
  if (!name) return { error: err('INVALID_INPUT', '请填写姓名或昵称') }
  if (name.length > 20) return { error: err('INVALID_INPUT', '姓名不要超过 20 个字') }

  const gender = d.gender === 'M' || d.gender === 'F' ? d.gender : null
  if (!gender) return { error: err('INVALID_INPUT', '请选择性别') }

  const selfLevel = asInt(d.selfLevel)
  if (selfLevel === null || selfLevel < MIN_LEVEL || selfLevel > MAX_LEVEL) {
    return { error: err('INVALID_INPUT', '请选择水平（1-5）') }
  }

  const phone = trimStr(d.phone)
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) {
    return { error: err('INVALID_INPUT', '手机号格式不对') }
  }

  return {
    value: {
      name: name,
      gender: gender,
      selfLevel: selfLevel,
      phone: phone,
      remark: trimStr(d.remark).slice(0, 200),
    },
  }
}

const actions = {
  /**
   * 提交报名。
   *
   * 防超卖用"原子占位 + 失败补偿"，不用 runTransaction：
   * 事务对象只有 doc.get/update/set/remove，没有 where 也没有聚合，
   * "还剩几个名额"这类条件查询在事务内做不了；而且默认只重试 3 次，
   * 开抢瞬间大家争同一个 event 文档的锁很容易耗尽。
   * 更新指令对单条记录本身就是原子的，这里用它足够。
   */
  async submit (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value

    if (evt.status !== 'open') {
      return err('SIGNUP_CLOSED',
        evt.status === 'divided' ? '活动已分队，无法报名' : '报名已关闭')
    }
    if (evt.signupDeadline && Date.now() > evt.signupDeadline) {
      return err('SIGNUP_CLOSED', '报名已截止')
    }

    const v = validateSignup(d)
    if (v.error) return v.error

    // 快速路径：已报名就直接改资料，不再占名额。
    const existing = await signups.where({
      eventId: evt._id, openid: r.openid, status: 'signed',
    }).limit(1).get()
    if (existing.data && existing.data.length > 0) {
      await signups.doc(existing.data[0]._id).update({
        data: Object.assign({}, v.value, { updateTime: Date.now() }),
      })
      return ok({ _id: existing.data[0]._id, updated: true })
    }

    // 第一步：一条 update 同时完成"检查"和"占位"。这一步是原子的，无锁竞争。
    // remaining 和 signupCount 放在同一次 update 里，保证两者不会脱节。
    const claim = await events.where({
      _id: evt._id,
      remaining: _.gt(0),
    }).update({
      data: { remaining: _.inc(-1), signupCount: _.inc(1) },
    })
    // stats.updated === 0 说明条件没命中，即名额已满。
    if (!claim.stats || claim.stats.updated !== 1) {
      return err('EVENT_FULL', '名额已满')
    }

    // 第二步：占到位了再写明细。写失败必须把名额补偿回去，否则名额会凭空消失。
    try {
      const res = await signups.add({
        data: Object.assign({}, v.value, {
          eventId: evt._id,
          openid: r.openid,
          adminLevel: null,
          status: 'signed',
          createTime: Date.now(),
          updateTime: Date.now(),
        }),
      })
      return ok({ _id: res._id, updated: false })
    } catch (addError) {
      await events.doc(evt._id).update({
        data: { remaining: _.inc(1), signupCount: _.inc(-1) },
      }).catch(function (e2) {
        // 补偿也失败只能靠日志兜底，名额会少一个，需要人工核对。
        console.error('[hat-signup] 名额补偿失败 eventId=' + evt._id, e2)
      })
      throw addError
    }
  },

  /**
   * 取消报名。先删明细成功再把名额加回，顺序反了会在并发下把名额加多。
   */
  async cancel (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value

    if (evt.status === 'divided') {
      return err('INVALID_STATE', '活动已分队，取消报名请联系组织者')
    }

    const mine = await signups.where({
      eventId: evt._id, openid: r.openid, status: 'signed',
    }).limit(1).get()
    if (!mine.data || mine.data.length === 0) {
      return err('NOT_FOUND', '你还没有报名这场活动')
    }

    const removed = await signups.doc(mine.data[0]._id).remove()
    if (!removed.stats || removed.stats.removed !== 1) {
      return err('CONFLICT', '取消失败，请重试')
    }
    await events.doc(evt._id).update({
      data: { remaining: _.inc(1), signupCount: _.inc(-1) },
    })
    return ok({ cancelled: true })
  },

  /** 我报名的活动（含活动摘要，供「我的」页展示）。 */
  async mine (d, r) {
    const list = await fetchAll(function () {
      return signups.where({ openid: r.openid, status: 'signed' })
        .orderBy('createTime', 'desc')
    }, { label: '我的报名' })
    if (list.length === 0) return ok({ list: [] })

    const evts = await fetchByIds(db, 'events',
      list.map(function (s) { return s.eventId }))
    const byId = {}
    ;(evts || []).forEach(function (e) { byId[e._id] = e })

    const out = list.map(function (s) {
      const e = byId[s.eventId]
      return {
        _id: s._id,
        eventId: s.eventId,
        name: s.name,
        gender: s.gender,
        selfLevel: s.selfLevel,
        createTime: s.createTime,
        event: e ? {
          _id: e._id,
          name: e.name,
          location: e.location,
          startTime: e.startTime,
          status: e.status,
        } : null,
      }
    }).filter(function (s) { return s.event !== null })

    return ok({ list: out })
  },

  /** 全部报名名单。仅管理身份可调——参与者拿不到别人的手机号。 */
  async listAll (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden

    const all = await fetchAll(function () {
      return signups.where({ eventId: e.value._id, status: 'signed' })
        .orderBy('createTime', 'asc')
    }, { label: '活动报名名单' })

    const out = all.map(function (s) {
      return {
        _id: s._id,
        name: s.name,
        gender: s.gender,
        selfLevel: s.selfLevel,
        adminLevel: s.adminLevel == null ? null : s.adminLevel,
        // 有效水平统一在这里算，前后端不要各算一遍。
        level: s.adminLevel == null ? s.selfLevel : s.adminLevel,
        phone: s.phone || '',
        remark: s.remark || '',
        isTest: s.isTest === true,
        isImported: s.isImported === true,
        createTime: s.createTime,
      }
    })
    return ok({ list: out, count: out.length })
  },

  /**
   * 从 xlsx 导入活动层名单。导入人员没有微信 openid，只用于组织者维护名单、
   * 赛事到场和分队；每条记录都带 isImported 标记，避免和真实用户混淆。
   */
  async importSignups (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireManage(evt, r)
    if (forbidden) return forbidden
    if (evt.status === 'divided') return err('INVALID_STATE', '活动已分队，不能再导入名单')

    const fileID = trimStr(d.fileID)
    if (!fileID || fileID.length > 512) return err('INVALID_INPUT', '缺少导入文件')

    let rows
    try {
      // xlsx 只在真正导入时加载，普通报名请求不增加冷启动依赖开销。
      const XLSX = require('xlsx')
      const downloaded = await cloud.downloadFile({ fileID: fileID })
      const workbook = XLSX.read(downloaded.fileContent, { type: 'buffer', cellDates: false })
      const names = workbook.SheetNames || []
      if (names.length === 0) return err('INVALID_IMPORT', '文件里没有工作表')
      rows = XLSX.utils.sheet_to_json(workbook.Sheets[names[0]], { header: 1, defval: '' })
    } catch (e2) {
      console.error('[hat-signup] import read failed', e2)
      return err('INVALID_IMPORT', '无法读取 Excel 文件，请上传 .xlsx 文件')
    }

    const parsed = importList.parseRows(rows)
    if (parsed.error) return parsed.error
    const list = parsed.value
    if (list.length > MAX_IMPORT_ROWS) {
      return err('INVALID_IMPORT', '一次最多导入 ' + MAX_IMPORT_ROWS + ' 人')
    }
    if (evt.remaining < list.length) {
      return err('EVENT_FULL', '剩余名额只有 ' + evt.remaining + ' 个，导入需要 ' + list.length + ' 个', {
        remaining: evt.remaining, requested: list.length,
      })
    }

    // 和真实报名、测试数据共用原子占位，保证导入不会绕过人数上限。
    const claim = await events.where({ _id: evt._id, remaining: _.gte(list.length) }).update({
      data: { remaining: _.inc(-list.length), signupCount: _.inc(list.length) },
    })
    if (!claim.stats || claim.stats.updated !== 1) return err('EVENT_FULL', '名额不足，请刷新后重试')

    const batch = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    let added = 0
    try {
      for (let i = 0; i < list.length; i++) {
        const s = list[i]
        const now = Date.now()
        await signups.add({ data: {
          eventId: evt._id,
          openid: 'import-' + batch + '-' + i,
          name: s.name,
          gender: s.gender,
          selfLevel: s.selfLevel,
          adminLevel: null,
          phone: s.phone || '',
          remark: s.remark || '',
          status: 'signed',
          isImported: true,
          importBatch: batch,
          sourceRow: s.sourceRow,
          createTime: now + i,
          updateTime: now,
        } })
        added++
      }
    } catch (addError) {
      if (added > 0) {
        await removeWhere(db, 'signups', { eventId: evt._id, importBatch: batch })
          .catch(function () {})
      }
      await events.doc(evt._id).update({
        data: { remaining: _.inc(list.length), signupCount: _.inc(-list.length) },
      }).catch(function (e2) {
        console.error('[hat-signup] 导入名单名额补偿失败 eventId=' + evt._id, e2)
      })
      throw addError
    }
    return ok({ imported: added, batch: batch })
  },

  /** 管理身份覆盖某人的水平。传 null 表示清除覆盖、回到自评值。 */
  async updateLevel (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const forbidden = requireManage(e.value, r)
    if (forbidden) return forbidden

    const signupId = trimStr(d.signupId)
    if (!signupId) return err('INVALID_INPUT', '缺少报名记录 id')

    let adminLevel = null
    if (d.adminLevel !== null && d.adminLevel !== '' && d.adminLevel !== undefined) {
      adminLevel = asInt(d.adminLevel)
      if (adminLevel === null || adminLevel < MIN_LEVEL || adminLevel > MAX_LEVEL) {
        return err('INVALID_INPUT', '水平需要是 1 到 5 之间的整数')
      }
    }

    const target = await signups.doc(signupId).get().catch(function () { return null })
    if (!target || !target.data) return err('NOT_FOUND', '报名记录不存在')
    if (target.data.eventId !== e.value._id) {
      return err('FORBIDDEN', '该报名记录不属于这场活动')
    }

    await signups.doc(signupId).update({
      data: { adminLevel: adminLevel, updateTime: Date.now() },
    })
    return ok({
      _id: signupId,
      adminLevel: adminLevel,
      level: adminLevel == null ? target.data.selfLevel : adminLevel,
    })
  },

  /**
   * 删掉一条报名，并归还名额。仅管理身份可用。
   *
   * 用于"报了名但确实不该在名单里"的情况：重复报名、信息填错、临时不来的人等等。
   * 参与者自己取消走 cancel；这里是管理端替别人删。
   *
   * 已经被某场赛事**赛前检录**的人不能删——先让他把那个人移出检录名单（或删掉那场赛事）：
   * 分队名单和比赛记录都以检录名单为基准，人一删就会留下悬空引用。
   * 约束里引用了他的，把他摘掉（剩不足 2 人的整条删除），并在返回里说明动了几条。
   */
  async removeSignup (d, r) {
    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value
    const forbidden = requireManage(evt, r)
    if (forbidden) return forbidden

    const signupId = trimStr(d.signupId)
    if (!signupId) return err('INVALID_INPUT', '缺少报名记录 id')

    const target = await signups.doc(signupId).get().catch(function () { return null })
    if (!target || !target.data) return err('NOT_FOUND', '报名记录不存在')
    if (target.data.eventId !== evt._id) {
      return err('FORBIDDEN', '该报名记录不属于这场活动')
    }
    const name = target.data.name

    const blocking = await tournamentsUsing(evt._id, [signupId])
    if (blocking.length > 0) {
      return err('SIGNUP_IN_USE',
        '「' + name + '」已经在「' +
        blocking.map(function (t) { return t.name }).join('」「') +
        '」的赛前检录名单里。请先把他从检录名单里去掉（或删掉那场赛事），再删除报名。',
        { tournamentIds: blocking.map(function (t) { return t._id }) })
    }

    const constraintsTouched = await stripFromConstraints(evt._id, [signupId])

    // 先删明细再归还名额，顺序反了会在并发下把名额加多。
    const removed = await signups.doc(signupId).remove()
    if (!removed.stats || removed.stats.removed !== 1) {
      return err('CONFLICT', '删除失败，请重试')
    }
    await events.doc(evt._id).update({
      data: { remaining: _.inc(1), signupCount: _.inc(-1) },
    })
    return ok({ removed: true, name: name, constraintsTouched: constraintsTouched })
  },

  /**
   * 往活动里塞一批假报名，用于人不够时测试分队。仅管理员可用。
   *
   * 假报名照常占名额：防超额靠的是 remaining 计数，测试数据若绕过它，
   * signupCount / remaining 就和真实记录对不上了。
   */
  async seedTestSignups (d, r) {
    if (!r.isAdmin) return err('FORBIDDEN', '只有管理员可以生成测试数据')

    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value

    const count = asInt(d.count)
    if (count === null || count < 1 || count > MAX_TEST_SEED) {
      return err('INVALID_INPUT', '一次生成 1 到 ' + MAX_TEST_SEED + ' 人')
    }

    // 和真实报名同样的原子占位：一条 update 同时完成检查和扣减。
    const claim = await events.where({
      _id: evt._id,
      remaining: _.gte(count),
    }).update({
      data: { remaining: _.inc(-count), signupCount: _.inc(count) },
    })
    if (!claim.stats || claim.stats.updated !== 1) {
      return err('EVENT_FULL',
        '名额只剩 ' + evt.remaining + ' 个，不够生成 ' + count + ' 人。' +
        '可以先在「编辑活动」里调大人数上限。',
        { remaining: evt.remaining })
    }

    const batch = Date.now().toString(36)
    let added = 0
    try {
      for (let i = 0; i < count; i++) {
        await signups.add({ data: makeTestSignup(evt._id, batch, i) })
        added++
      }
    } finally {
      // 中途失败时把没写成的名额补回去，否则名额会凭空消失。
      if (added < count) {
        await events.doc(evt._id).update({
          data: { remaining: _.inc(count - added), signupCount: _.inc(added - count) },
        }).catch(function (e2) {
          console.error('[hat-signup] 测试数据名额补偿失败 eventId=' + evt._id, e2)
        })
      }
    }

    return ok({ added: added })
  },

  /**
   * 清掉活动里的全部测试报名，并归还名额。仅管理员可用。
   *
   * 测试选手如果已经进了某场赛事，直接删会让分队和比赛记录里留下指向不存在的人的引用，
   * 所以这种情况拒绝执行，提示先删掉那场赛事（删赛事会级联清掉它的分队和比赛）。
   */
  async clearTestSignups (d, r) {
    if (!r.isAdmin) return err('FORBIDDEN', '只有管理员可以清理测试数据')

    const e = await store.loadEvent(db, d.eventId)
    if (e.error) return e.error
    const evt = e.value

    const testRows = await fetchAll(function () {
      return signups.where({ eventId: evt._id, isTest: true }).field({ _id: true })
    }, { label: '测试报名' })
    const testIds = testRows.map(function (row) { return row._id })
    if (testIds.length === 0) return ok({ removed: 0 })

    const blocking = await tournamentsUsing(evt._id, testIds)
    if (blocking.length > 0) {
      return err('TEST_DATA_IN_USE',
        '测试选手已经在「' + blocking.map(function (t) { return t.name }).join('」「') +
        '」里了。请先删掉这些赛事，再清理测试数据。',
        { tournamentIds: blocking.map(function (t) { return t._id }) })
    }

    await stripFromConstraints(evt._id, testIds)

    // 先删明细再归还名额，顺序反了会在并发下把名额加多。
    const removed = await removeWhere(db, 'signups', { eventId: evt._id, isTest: true })
    if (removed > 0) {
      await events.doc(evt._id).update({
        data: { remaining: _.inc(removed), signupCount: _.inc(-removed) },
      })
    }
    return ok({ removed: removed })
  },
}

exports.main = async function (event) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return err('NO_AUTH', '无法获取用户身份')

  const action = event && event.action
  const handler = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null
  if (!handler) return err('UNKNOWN_ACTION', '未知操作：' + action)

  try {
    // 角色只查一次，之后所有权限判定都是纯函数。
    const r = await roles.loadRoles(db, openid)
    return await handler(event.data || {}, r)
  } catch (e) {
    console.error('[hat-signup] action=' + action, e)
    return err('INTERNAL', (e && e.message) || '服务异常，请重试')
  }
}
