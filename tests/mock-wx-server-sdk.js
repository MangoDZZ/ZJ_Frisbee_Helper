'use strict'

/**
 * wx-server-sdk 的内存替身，用来在本机跑云函数逻辑。
 *
 * 只实现云函数里实际用到的那部分 API。所有异步方法都真的让出一次微任务，
 * 这样 Promise.all 并发调用时能在 await 点交错——并发报名的竞态才测得出来。
 */

let openid = 'openid-anonymous'
const store = new Map()

function tick () { return Promise.resolve() }

function collectionOf (name) {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)
}

let idSeq = 0
function newId (name) { return name + '-' + (++idSeq) }

function clone (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)) }

// ---------------------------------------------------------------- 指令

function cmd (op, value) { return { __cmd: true, op: op, value: value } }

const command = {
  gt: function (v) { return cmd('gt', v) },
  gte: function (v) { return cmd('gte', v) },
  lt: function (v) { return cmd('lt', v) },
  lte: function (v) { return cmd('lte', v) },
  eq: function (v) { return cmd('eq', v) },
  neq: function (v) { return cmd('neq', v) },
  in: function (v) { return cmd('in', v) },
  nin: function (v) { return cmd('nin', v) },
  inc: function (v) { return cmd('inc', v) },
  set: function (v) { return cmd('set', v) },
  remove: function () { return cmd('remove', null) },
}

function matchOne (actual, c) {
  switch (c.op) {
    case 'gt': return actual > c.value
    case 'gte': return actual >= c.value
    case 'lt': return actual < c.value
    case 'lte': return actual <= c.value
    case 'eq': return actual === c.value
    case 'neq': return actual !== c.value
    case 'in': return Array.isArray(c.value) && c.value.indexOf(actual) >= 0
    case 'nin': return Array.isArray(c.value) && c.value.indexOf(actual) < 0
    default: throw new Error('mock 未实现的查询指令：' + c.op)
  }
}

function matches (doc, cond) {
  const keys = Object.keys(cond || {})
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const c = cond[k]
    if (c && c.__cmd) {
      if (!matchOne(doc[k], c)) return false
    } else if (doc[k] !== c) {
      return false
    }
  }
  return true
}

function applyPatch (doc, patch) {
  const keys = Object.keys(patch || {})
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const v = patch[k]
    if (v && v.__cmd) {
      if (v.op === 'inc') doc[k] = (doc[k] || 0) + v.value
      else if (v.op === 'set') doc[k] = clone(v.value)
      else if (v.op === 'remove') delete doc[k]
      else throw new Error('mock 未实现的更新指令：' + v.op)
    } else {
      doc[k] = clone(v)
    }
  }
}

// ---------------------------------------------------------------- 查询

function makeQuery (name, state) {
  const st = Object.assign({ cond: {}, orders: [], limitN: null, skipN: 0, fields: null }, state)

  function rows () {
    let out = []
    collectionOf(name).forEach(function (doc) {
      if (matches(doc, st.cond)) out.push(doc)
    })
    for (let i = st.orders.length - 1; i >= 0; i--) {
      const o = st.orders[i]
      out.sort(function (a, b) {
        const av = a[o.field]
        const bv = b[o.field]
        if (av === bv) return 0
        const r = av > bv ? 1 : -1
        return o.dir === 'desc' ? -r : r
      })
    }
    if (st.skipN) out = out.slice(st.skipN)
    if (st.limitN !== null) out = out.slice(0, st.limitN)
    return out
  }

  const q = {
    where: function (cond) {
      return makeQuery(name, Object.assign({}, st, {
        cond: Object.assign({}, st.cond, cond),
      }))
    },
    orderBy: function (field, dir) {
      return makeQuery(name, Object.assign({}, st, {
        orders: st.orders.concat([{ field: field, dir: dir || 'asc' }]),
      }))
    },
    limit: function (n) { return makeQuery(name, Object.assign({}, st, { limitN: n })) },
    skip: function (n) { return makeQuery(name, Object.assign({}, st, { skipN: n })) },
    field: function (sel) { return makeQuery(name, Object.assign({}, st, { fields: sel })) },

    get: async function () {
      await tick()
      const out = rows().map(function (d) {
        if (!st.fields) return clone(d)
        const picked = { _id: d._id }
        Object.keys(st.fields).forEach(function (k) {
          if (st.fields[k]) picked[k] = clone(d[k])
        })
        return picked
      })
      return { data: out }
    },

    count: async function () {
      await tick()
      return { total: rows().length }
    },

    // 整个 update 在一次同步执行里完成，对应真实云数据库"更新指令对单条记录
    // 是原子的"这一点——报名防超卖就靠它。
    update: async function (opts) {
      await tick()
      const target = rows()
      for (let i = 0; i < target.length; i++) applyPatch(target[i], opts.data)
      return { stats: { updated: target.length } }
    },

    remove: async function () {
      await tick()
      const target = rows()
      const col = collectionOf(name)
      for (let i = 0; i < target.length; i++) col.delete(target[i]._id)
      return { stats: { removed: target.length } }
    },

    add: async function (opts) {
      await tick()
      const id = opts.data._id || newId(name)
      const doc = Object.assign({}, clone(opts.data), { _id: id })
      collectionOf(name).set(id, doc)
      return { _id: id }
    },

    doc: function (id) {
      return {
        get: async function () {
          await tick()
          const d = collectionOf(name).get(id)
          // 真实云数据库查不到会抛错，云函数里靠 .catch 兜住，这里要一致。
          if (!d) {
            const e = new Error('document with _id ' + id + ' does not exist')
            e.errCode = -1
            throw e
          }
          return { data: clone(d) }
        },
        update: async function (opts) {
          await tick()
          const d = collectionOf(name).get(id)
          if (!d) return { stats: { updated: 0 } }
          applyPatch(d, opts.data)
          return { stats: { updated: 1 } }
        },
        set: async function (opts) {
          await tick()
          const doc = Object.assign({}, clone(opts.data), { _id: id })
          collectionOf(name).set(id, doc)
          return { stats: { updated: 1 } }
        },
        remove: async function () {
          await tick()
          const existed = collectionOf(name).delete(id)
          return { stats: { removed: existed ? 1 : 0 } }
        },
      }
    },
  }
  return q
}

// ---------------------------------------------------------------- 导出

const database = function () {
  return {
    command: command,
    collection: function (name) { return makeQuery(name, {}) },
  }
}

module.exports = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init: function () {},
  database: database,
  getWXContext: function () {
    return { OPENID: openid, APPID: 'mock-appid', ENV: 'mock-env' }
  },

  // ---- 测试辅助 ----
  __mock: {
    setOpenid: function (v) { openid = v },
    reset: function () {
      store.clear()
      idSeq = 0
      openid = 'openid-anonymous'
    },
    all: function (name) {
      const out = []
      collectionOf(name).forEach(function (d) { out.push(clone(d)) })
      return out
    },
    get: function (name, id) { return clone(collectionOf(name).get(id)) },
    insert: function (name, doc) {
      const id = doc._id || newId(name)
      collectionOf(name).set(id, Object.assign({}, clone(doc), { _id: id }))
      return id
    },
  },
}
