'use strict'

/**
 * 从一段粘贴来的文本里认出人名，再匹配到报名名单。
 *
 * 场景：周日活动结束后，组织者在群里收到"今天到场的人"这样一段文字，
 * 例如：
 *
 *   1.张三
 *   2.李四（迟到）
 *   3、王五
 *   4)赵六
 *
 * 要把它变成赛前检录的勾选状态。**匹配不能要求一一对应**：粘贴的文本里常有
 * 编号、备注、错字、重复、以及根本没报名的人，所以这里只做"尽最大努力"的匹配，
 * 认不出来的原样交回去，让组织者自己判断。
 *
 * 纯函数、无 wx 依赖，方便离线测试。
 */

// 先按行切（粘贴的名单基本都是一行一个），再在行内按逗号/顿号/分号切。
// 顺序很重要：先把行首编号剥掉再切，否则"2、李四"会先被顿号切成 "2" 和 "李四"。
const LINES = /[\n\r]+/
const INNER_SEP = /[,，;；、\t|\u3000]+/

// 行首编号："1." "1、" "1)" "(1)" "1:" "①" "-" "•"
const LEADING_INDEX = /^\s*(?:[（(]?\d{1,3}[)）]?\s*[.、,，:：)）\-–—]|[①-⑳]|[-–—•·*]+)\s*/

// 归一化时抹掉的噪声字符：空白、标点、括号。全角空格也要抹，手机输入法常带。
const NOISE = /[\s\u3000.。,，、;；:：'"“”‘’`!！?？()（）[\]【】<>《》\-–—_~～*·•]/g

/** 归一化：去符号、去空白、转小写。用于"看起来一样就算同一个人"。 */
function normalize (s) {
  return String(s === null || s === undefined ? '' : s).replace(NOISE, '').toLowerCase()
}

/** 去掉行首编号和首尾空白，只留下人名的样子。 */
function cleanToken (s) {
  return String(s === null || s === undefined ? '' : s).replace(LEADING_INDEX, '').trim()
}

/**
 * 把一段文本切成候选人名。
 *
 * @returns {{tokens: string[], skipped: number}} tokens 已去重、已去编号；
 *   skipped 是被跳过的空行/重复条目数，用来告诉用户"粘了 20 行，实际 18 个名字"。
 */
function parseNames (text) {
  const lines = String(text === null || text === undefined ? '' : text).split(LINES)
  const tokens = []
  const seen = {}
  let skipped = 0
  for (let i = 0; i < lines.length; i++) {
    const parts = cleanToken(lines[i]).split(INNER_SEP)
    for (let j = 0; j < parts.length; j++) {
      const name = parts[j].trim()
      const key = normalize(name)
      if (!key) { skipped++; continue }
      if (seen[key]) { skipped++; continue }
      seen[key] = true
      tokens.push(name)
    }
  }
  return { tokens: tokens, skipped: skipped }
}

/** 包含匹配至少要有 2 个字，否则"王"会匹配到所有姓王的人。 */
const MIN_CONTAIN = 2

/**
 * 把候选人名匹配到报名名单。
 *
 * 匹配规则，从严到松：
 *  1. 归一化后完全相同；
 *  2. 一方包含另一方（至少 2 个字），且**只有一个**这样的候选——
 *     "李四（迟到）"能对上"李四"，但"张三"不会在"张三""张三丰"之间乱猜。
 *
 * 每个报名者最多被匹配一次；同一个人被粘贴两遍只算一次（在 parseNames 已去重）。
 *
 * @param {string[]} tokens parseNames 的结果
 * @param {Array<{id: string, name: string}>} candidates 报名名单
 * @returns {{matched: Array, unmatched: string[], ambiguous: string[]}}
 */
function matchNames (tokens, candidates) {
  const pool = []
  for (let i = 0; i < (candidates || []).length; i++) {
    const c = candidates[i] || {}
    const key = normalize(c.name)
    if (!c.id || !key) continue
    pool.push({ id: c.id, name: c.name, key: key })
  }

  const taken = {}
  const matched = []
  const unmatched = []
  const ambiguous = []

  for (let i = 0; i < (tokens || []).length; i++) {
    const token = tokens[i]
    const key = normalize(token)
    if (!key) { unmatched.push(token); continue }

    let hit = null
    for (let j = 0; j < pool.length; j++) {
      if (!taken[pool[j].id] && pool[j].key === key) { hit = pool[j]; break }
    }

    if (!hit && key.length >= MIN_CONTAIN) {
      // 包含匹配：收集所有可能，按 key 长度降序——"张三丰"优先对上"张三丰"而不是"张三"
      const cands = []
      for (let j = 0; j < pool.length; j++) {
        const p = pool[j]
        if (taken[p.id] || p.key.length < MIN_CONTAIN) continue
        if (key.indexOf(p.key) >= 0 || p.key.indexOf(key) >= 0) cands.push(p)
      }
      if (cands.length > 0) {
        cands.sort(function (a, b) { return b.key.length - a.key.length })
        // 前两名一样长 ⇒ 分不出是哪一个，交回给用户，不瞎猜
        if (cands.length > 1 && cands[0].key.length === cands[1].key.length) {
          ambiguous.push(token)
          continue
        }
        hit = cands[0]
      }
    }

    if (hit) {
      taken[hit.id] = true
      matched.push({ token: token, id: hit.id, name: hit.name })
    } else {
      unmatched.push(token)
    }
  }

  return { matched: matched, unmatched: unmatched, ambiguous: ambiguous }
}

module.exports = {
  parseNames: parseNames,
  matchNames: matchNames,
  normalize: normalize,
  cleanToken: cleanToken,
}
