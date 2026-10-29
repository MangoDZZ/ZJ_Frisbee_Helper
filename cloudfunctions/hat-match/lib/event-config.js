'use strict'

/**
 * 活动类型与报名表字段规格。**唯一源头是本文件**，各云函数 lib/ 下的副本由
 * `node scripts/sync-shared.js` 生成，不要直接改副本。
 *
 * 为什么规格要在服务端：报名表哪些字段要采集、哪些必填，是**活动自己的配置**，
 * 校验必须按配置在云函数里做。只在前端隐藏字段没有意义——改一行前端就能提交
 * 任意字段，而"这个活动居然收到了学号"是事后无法解释的数据。
 */

/**
 * 活动类型。v1.1.3 之前创建的活动没有 type 字段，读取时一律按个人积分赛对待
 * （见 typeOf），所以加类型不会改动任何老活动的行为。
 *
 * 两种类型的差别只在"怎么算名次"，分队算法、报名、记分方式完全相同：
 *  - personal 个人积分赛：可以开多场赛事各自分队，名次按个人积分排
 *  - classic  经典 HAT：一个活动只分一次队、一个赛事，名次按队伍胜负排
 *
 * 类型**创建后不可改**（见 hat-event 的 update）：它决定了"只能有一个赛事"这条
 * 结构性约束，中途改会让已录入的赛事和比赛记录处在一个说不清语义的状态里。
 */
const TYPE_PERSONAL = 'personal'
const TYPE_CLASSIC = 'classic'
const TYPES = {
  personal: '个人积分赛',
  classic: '经典 HAT',
}

function typeOf (evt) {
  const t = evt && evt.type
  return TYPES[t] ? t : TYPE_PERSONAL
}

function typeLabel (evt) {
  return TYPES[typeOf(evt)]
}

/** 经典 HAT：分一次队，名次看队伍胜负。 */
function isClassic (evt) {
  return typeOf(evt) === TYPE_CLASSIC
}

/**
 * 名次页的入口文案。经典 HAT 那个页面显示的是队伍胜负，叫「积分榜」会误导，
 * 所以文案跟着类型走——但这个判断只此一处，各页面都从这里取，免得又写散。
 *
 * @param {string} type 活动类型（'personal' / 'classic'）
 */
function boardLabel (type) {
  return type === TYPE_CLASSIC ? '战绩' : '积分榜'
}

/**
 * 报名表字段。
 *
 * locked 的三个（姓名 / 性别 / 水平）**不允许关掉**：
 *  - 姓名是整份名单的主键，分队、检录、比赛记录、积分榜全靠它认人
 *  - 性别和水平是分队算法的两个均衡维度，关掉就等于放弃均衡
 * 所以它们只出现在「必填」列表里给用户看，不进配置项。
 */
const LOCKED_FIELDS = [
  { key: 'name', label: '姓名 / 昵称', kind: 'text', max: 20 },
  { key: 'gender', label: '性别', kind: 'gender' },
  { key: 'selfLevel', label: '水平等级', kind: 'level' },
]

/** 可配置字段：组织者可以决定采不采集、要不要必填。 */
const CONFIGURABLE_FIELDS = [
  { key: 'age', label: '年龄', kind: 'int', min: 5, max: 99 },
  { key: 'phone', label: '手机号', kind: 'phone' },
  { key: 'className', label: '班级', kind: 'text', max: 30 },
  { key: 'studentId', label: '学号', kind: 'text', max: 30 },
]

/**
 * 默认配置。手机号维持原样（采集但选填），另外三项默认不采集——
 * 飞盘 HAT 局不需要年龄/班级/学号，默认打开只会让报名表变长。
 */
const DEFAULT_SIGNUP_FIELDS = {
  age: { enabled: false, required: false },
  phone: { enabled: true, required: false },
  className: { enabled: false, required: false },
  studentId: { enabled: false, required: false },
}

/** 活动可见性。group 表示"仅限群聊转发可见"。 */
const VISIBILITY_PUBLIC = 'public'
const VISIBILITY_GROUP = 'group'

function visibilityOf (evt) {
  return evt && evt.visibility === VISIBILITY_GROUP ? VISIBILITY_GROUP : VISIBILITY_PUBLIC
}

/**
 * 规整字段配置：只认已知的 key，值一律布尔；必填只在采集时才有意义。
 * 传入 undefined / 老活动 → 全部按默认值，所以老活动的行为不变。
 */
function normalizeSignupFields (raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (let i = 0; i < CONFIGURABLE_FIELDS.length; i++) {
    const key = CONFIGURABLE_FIELDS[i].key
    const def = DEFAULT_SIGNUP_FIELDS[key]
    const cur = src[key] && typeof src[key] === 'object' ? src[key] : {}
    const enabled = cur.enabled === undefined ? def.enabled : !!cur.enabled
    out[key] = {
      enabled: enabled,
      // 不采集的字段不存在"必填"，强制归 false，免得客户端显示出一个矛盾的开关
      required: enabled && (cur.required === undefined ? def.required : !!cur.required),
    }
  }
  return out
}

function specOf (key) {
  for (let i = 0; i < CONFIGURABLE_FIELDS.length; i++) {
    if (CONFIGURABLE_FIELDS[i].key === key) return CONFIGURABLE_FIELDS[i]
  }
  return null
}

function text (v) {
  return v === null || v === undefined ? '' : String(v).trim()
}

/** 与 common.asInt 同义：Number(null) / Number('') 都是 0，不能直接用。 */
function parseInt10 (v) {
  if (typeof v === 'number') {
    return isFinite(v) && Math.floor(v) === v ? v : null
  }
  const s = text(v)
  if (s === '') return null
  const n = Number(s)
  return isFinite(n) && Math.floor(n) === n ? n : null
}

/**
 * 按活动配置校验并清洗报名表里那些可配置字段。
 *
 * 返回的 value 里，**不采集的字段一律存空串**——既让下游代码不用到处判空，
 * 也保证"这个活动没要求年龄"时数据库里真的没有年龄，而不是残留一份上次填的。
 *
 * @param {object} d      提交的数据
 * @param {object} fields 活动的 signupFields 配置（可传 undefined，走默认值）
 * @returns {{value: object}|{error: object}}
 */
function validateSignupValues (d, fields) {
  const cfg = normalizeSignupFields(fields)
  const value = {}
  for (let i = 0; i < CONFIGURABLE_FIELDS.length; i++) {
    const spec = CONFIGURABLE_FIELDS[i]
    const c = cfg[spec.key]
    value[spec.key] = ''
    if (!c.enabled) continue

    const raw = d ? d[spec.key] : ''
    if (spec.kind === 'int') {
      const n = parseInt10(raw)
      const empty = raw === null || raw === undefined || text(raw) === ''
      if (empty) {
        if (c.required) {
          return { error: { code: 'INVALID_INPUT', message: '请填写' + spec.label } }
        }
        continue
      }
      if (n === null || n < spec.min || n > spec.max) {
        return {
          error: {
            code: 'INVALID_INPUT',
            message: spec.label + '需要是 ' + spec.min + ' 到 ' + spec.max + ' 之间的整数',
          },
        }
      }
      value[spec.key] = n
      continue
    }

    const s = text(raw)
    if (!s) {
      if (c.required) {
        return { error: { code: 'INVALID_INPUT', message: '请填写' + spec.label } }
      }
      continue
    }
    if (spec.kind === 'phone' && !/^[0-9+\-\s]{6,20}$/.test(s)) {
      return { error: { code: 'INVALID_INPUT', message: '手机号格式不对' } }
    }
    if (spec.max && s.length > spec.max) {
      return {
        error: {
          code: 'INVALID_INPUT',
          message: spec.label + '不要超过 ' + spec.max + ' 个字',
        },
      }
    }
    value[spec.key] = s
  }
  return { value: value }
}

module.exports = {
  TYPE_PERSONAL: TYPE_PERSONAL,
  TYPE_CLASSIC: TYPE_CLASSIC,
  TYPES: TYPES,
  typeOf: typeOf,
  typeLabel: typeLabel,
  isClassic: isClassic,
  boardLabel: boardLabel,
  LOCKED_FIELDS: LOCKED_FIELDS,
  CONFIGURABLE_FIELDS: CONFIGURABLE_FIELDS,
  DEFAULT_SIGNUP_FIELDS: DEFAULT_SIGNUP_FIELDS,
  VISIBILITY_PUBLIC: VISIBILITY_PUBLIC,
  VISIBILITY_GROUP: VISIBILITY_GROUP,
  visibilityOf: visibilityOf,
  normalizeSignupFields: normalizeSignupFields,
  specOf: specOf,
  validateSignupValues: validateSignupValues,
}
