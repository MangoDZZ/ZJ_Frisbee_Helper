'use strict'

/**
 * 报名表字段的**前端镜像**。服务端权威版本是 `shared/event-config.js`
 * （经 scripts/sync-shared.js 拷进各云函数的 lib/）。
 *
 * 为什么不能只有一份：小程序端没法 require 仓库根目录的东西，云函数也没法引用
 * 小程序目录。所以只能各留一份，靠 `tests/check-pages.js` 断言两边的字段 key
 * 完全一致来防止漂移——漏改一边的表现是"组织者勾了年龄，报名页却不显示"，
 * 而这种错不会报错。
 *
 * 这里只负责渲染和前端预校验；真正的校验一定在云函数里（前端改一行就能绕过）。
 */

/** 固定字段：分队和积分都要用，组织者不能关掉。 */
const LOCKED_FIELDS = [
  { key: 'name', label: '姓名 / 昵称', placeholder: '队友怎么叫你', max: 20 },
  { key: 'gender', label: '性别' },
  { key: 'selfLevel', label: '我的水平' },
]

/** 可配置字段，顺序即报名表上的顺序。 */
const CONFIGURABLE_FIELDS = [
  {
    key: 'age',
    label: '年龄',
    kind: 'int',
    placeholder: '选填，例如 24',
    placeholderRequired: '例如 24',
    max: 3,
  },
  {
    key: 'phone',
    label: '手机号',
    kind: 'phone',
    placeholder: '选填，仅组织者可见',
    placeholderRequired: '仅组织者可见',
    max: 20,
  },
  {
    key: 'className',
    label: '班级',
    kind: 'text',
    placeholder: '选填，例如 高一(3)班',
    placeholderRequired: '例如 高一(3)班',
    max: 30,
  },
  {
    key: 'studentId',
    label: '学号',
    kind: 'text',
    placeholder: '选填',
    placeholderRequired: '请填写学号',
    max: 30,
  },
]

const DEFAULT_SIGNUP_FIELDS = {
  age: { enabled: false, required: false },
  phone: { enabled: true, required: false },
  className: { enabled: false, required: false },
  studentId: { enabled: false, required: false },
}

/** 与服务端 normalizeSignupFields 同义：老活动/缺字段一律走默认值。 */
function normalize (raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (let i = 0; i < CONFIGURABLE_FIELDS.length; i++) {
    const key = CONFIGURABLE_FIELDS[i].key
    const def = DEFAULT_SIGNUP_FIELDS[key]
    const cur = src[key] && typeof src[key] === 'object' ? src[key] : {}
    const enabled = cur.enabled === undefined ? def.enabled : !!cur.enabled
    out[key] = {
      enabled: enabled,
      required: enabled && (cur.required === undefined ? def.required : !!cur.required),
    }
  }
  return out
}

/**
 * 渲染报名表要用的字段列表：只保留采集的，并带上「必填」标记和提示文案。
 * 顺序保持 CONFIGURABLE_FIELDS 的定义顺序，与服务端的校验顺序一致。
 */
function visibleFields (raw) {
  const cfg = normalize(raw)
  const out = []
  for (let i = 0; i < CONFIGURABLE_FIELDS.length; i++) {
    const spec = CONFIGURABLE_FIELDS[i]
    const c = cfg[spec.key]
    if (!c.enabled) continue
    out.push({
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      // 必填时不能写"选填"，否则提示和红色的 * 自相矛盾
      placeholder: c.required ? spec.placeholderRequired : spec.placeholder,
      max: spec.max,
      required: c.required,
    })
  }
  return out
}

/** 组织者配置页要用的完整列表（含未采集的），带上各自的开关状态。 */
function configRows (raw) {
  const cfg = normalize(raw)
  return CONFIGURABLE_FIELDS.map(function (spec) {
    return {
      key: spec.key,
      label: spec.label,
      enabled: cfg[spec.key].enabled,
      required: cfg[spec.key].required,
    }
  })
}

/**
 * 前端预校验，规则与服务端一致（只是少一次往返用的）。
 * 返回 '' 表示通过，否则是给用户看的提示。
 */
function checkValue (field, value) {
  const s = value === null || value === undefined ? '' : String(value).trim()
  if (!s) return field.required ? '请填写' + field.label : ''
  if (field.kind === 'int') {
    const n = Number(s)
    if (!isFinite(n) || Math.floor(n) !== n || n < 5 || n > 99) {
      return field.label + '需要是 5 到 99 之间的整数'
    }
  }
  if (field.kind === 'phone' && !/^[0-9+\-\s]{6,20}$/.test(s)) return '手机号格式不对'
  if (field.max && s.length > field.max) return field.label + '不要超过 ' + field.max + ' 个字'
  return ''
}

module.exports = {
  LOCKED_FIELDS: LOCKED_FIELDS,
  CONFIGURABLE_FIELDS: CONFIGURABLE_FIELDS,
  DEFAULT_SIGNUP_FIELDS: DEFAULT_SIGNUP_FIELDS,
  normalize: normalize,
  visibleFields: visibleFields,
  configRows: configRows,
  checkValue: checkValue,
}
