'use strict'

/**
 * 飞盘 HAT 赛分队算法。
 *
 * 纯函数，不依赖微信环境，可在 Node 里直接测试。在小程序端同步执行，
 * 云函数只负责持久化结果。
 *
 * 做法：约束优先落位 + 按性别分流的蛇形选秀 + 多次随机重启取最优。
 *
 * 硬约束只有两条：apart（必须拆开）和 pod 不可拆分。人数与性别一律是软约束，
 * 交给代价函数。把人数上限硬化会在可行实例上造成分配失败——带容量的 apart
 * 分配本质是带容量的图着色，NP-hard，任何一次性贪心都存在失败输入。
 */

const { createPrng, mixSeed, shuffleInPlace, randomSeed } = require('./prng.js')

const DEFAULT_RESTARTS = 1000
const DEFAULT_LEVEL = 3
const MIN_LEVEL = 1
const MAX_LEVEL = 5
const STAR_LEVEL = 5

// 权重是优先级语义，不是待调的参数：人数/性别在真实名单里通常可精确达成，
// 水平只能近似，所以 50:100 表示"宁可水平差一点，也不用性别失衡去换水平收益"。
// 换算：1 人的人数偏差 = 50；1 个性别偏差 = 100；1 个明星偏差 = 100；
// 水平项是 (总水平 - 人数×μ)² / μ²，即"偏离量折成几人份"，μ=3 时偏离 1 档 = 5.6。
const W_SIZE = 50
const W_GENDER = 100
const W_STAR = 100
const W_LEVEL = 50

const CLASSES = ['F', 'M', 'U']

const ERR = {
  INVALID_PLAYERS: 'INVALID_PLAYERS',
  INVALID_TEAM_COUNT: 'INVALID_TEAM_COUNT',
  INVALID_PLAYER: 'INVALID_PLAYER',
  DUPLICATE_PLAYER: 'DUPLICATE_PLAYER',
  UNKNOWN_PLAYER: 'UNKNOWN_PLAYER',
  APART_SELF: 'APART_SELF',
  APART_IN_SAME_POD: 'APART_IN_SAME_POD',
  APART_INFEASIBLE: 'APART_INFEASIBLE',
}

const WARN = {
  LEVEL_FIXED: 'LEVEL_FIXED',
  GENDER_UNKNOWN: 'GENDER_UNKNOWN',
  FEWER_FEMALES_THAN_TEAMS: 'FEWER_FEMALES_THAN_TEAMS',
  EMPTY_TEAMS: 'EMPTY_TEAMS',
  POD_OVER_CAPACITY: 'POD_OVER_CAPACITY',
  APART_IGNORED_SINGLE_TEAM: 'APART_IGNORED_SINGLE_TEAM',
}

function fail (code, message, detail) {
  return { ok: false, error: { code, message, detail: detail || null } }
}

/** 'M' 男 / 'F' 女 / 'U' 未知。未知不报错，单独成一类并独立均衡。 */
function normalizeGender (raw) {
  if (typeof raw !== 'string') return 'U'
  const g = raw.trim().toLowerCase()
  if (g === 'm' || g === 'male' || g === '男' || g === '男性') return 'M'
  if (g === 'f' || g === 'female' || g === '女' || g === '女性') return 'F'
  return 'U'
}

/**
 * 有效水平 = adminLevel ?? selfLevel ?? level，clamp 到 [1, 5] 并取整。
 * 绝不能让 undefined / NaN 流入代价函数。
 */
function normalizeLevel (player) {
  const raw = player.adminLevel != null ? player.adminLevel
    : player.selfLevel != null ? player.selfLevel
      : player.level
  const n = Number(raw)
  if (!isFinite(n)) return { level: DEFAULT_LEVEL, fixed: true }
  const clamped = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(n)))
  return { level: clamped, fixed: clamped !== n }
}

/** 迭代版并查集，路径压缩。不用递归，避免 200 节点长链爆栈。 */
function makeDsu (n) {
  const parent = new Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  function find (x) {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  function union (a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  return { find, union }
}

function emptyCounts () {
  return { F: 0, M: 0, U: 0 }
}

function makeTeam (index) {
  return {
    index,
    name: (index + 1) + '队',
    podIds: [],
    podSet: new Set(),
    playerIdx: [],
    size: 0,
    count: emptyCounts(),
    levelSumByClass: emptyCounts(),
    star: 0,
    levelSum: 0,
  }
}

function addPodToTeam (team, pod) {
  team.podIds.push(pod.id)
  team.podSet.add(pod.id)
  for (let i = 0; i < pod.playerIdx.length; i++) team.playerIdx.push(pod.playerIdx[i])
  team.size += pod.size
  team.star += pod.star
  team.levelSum += pod.levelSum
  for (let c = 0; c < CLASSES.length; c++) {
    const cls = CLASSES[c]
    team.count[cls] += pod.count[cls]
    team.levelSumByClass[cls] += pod.levelSumByClass[cls]
  }
}

/**
 * 撤销"刚刚"那一次 addPodToTeam。只在试放-回退的探测里用，靠的是该 pod 的成员
 * 一定在数组末尾——不能用来移除中间的 pod。
 */
function undoLastPod (team, pod) {
  team.podIds.pop()
  team.podSet.delete(pod.id)
  team.playerIdx.length -= pod.playerIdx.length
  team.size -= pod.size
  team.star -= pod.star
  team.levelSum -= pod.levelSum
  for (let c = 0; c < CLASSES.length; c++) {
    const cls = CLASSES[c]
    team.count[cls] -= pod.count[cls]
    team.levelSumByClass[cls] -= pod.levelSumByClass[cls]
  }
}

/**
 * 单队代价。总代价是各队之和，所以可以按队增量计算，落位时判断 O(1)。
 *
 * 水平项用"水平总和偏离"而不是"队均水平与全局均值之差"：
 *  - 队均值在空队时是 0/0 = NaN，而 NaN < best 恒为 false，会让择优静默失效且不报错；
 *  - 除以队人数把量纲缩小了约 size 倍，会让水平项比人数项小一个数量级，实际被忽略；
 *  - 总和式在人数不均时目标自动按该队实际人数缩放，语义也更正确。
 *
 * 人数项必须单独设。"男女各自均衡则总人数必然均衡"是错的：各性别的余数可能
 * 落在同一队上（5 女 10 男分 8 队时，女有 5 个余数队、男有 2 个，重叠的那队就是
 * 3 人），而 genderTerm 对重叠与不重叠给出完全相同的代价，分不出好坏。
 */
function teamCost (team, targets, mu, invMuSq) {
  const dn = team.size - targets.size
  const size = dn * dn
  let gender = 0
  for (let c = 0; c < CLASSES.length; c++) {
    const cls = CLASSES[c]
    const d = team.count[cls] - targets.count[cls]
    gender += d * d
  }
  const ds = team.star - targets.star
  const star = ds * ds
  const dl = team.levelSum - team.size * mu
  const level = dl * dl * invMuSq
  return W_SIZE * size + W_GENDER * gender + W_STAR * star + W_LEVEL * level
}

function totalCost (teams, targets, mu, invMuSq) {
  let size = 0
  let gender = 0
  let star = 0
  let level = 0
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i]
    const dn = t.size - targets.size
    size += dn * dn
    for (let c = 0; c < CLASSES.length; c++) {
      const cls = CLASSES[c]
      const d = t.count[cls] - targets.count[cls]
      gender += d * d
    }
    const ds = t.star - targets.star
    star += ds * ds
    const dl = t.levelSum - t.size * mu
    level += dl * dl * invMuSq
  }
  return {
    size: size,
    gender: gender,
    star: star,
    level: level,
    total: W_SIZE * size + W_GENDER * gender + W_STAR * star + W_LEVEL * level,
  }
}

function canPlace (pod, team, apartAdj) {
  const adj = apartAdj[pod.id]
  if (!adj || adj.size === 0) return true
  const ids = team.podIds
  for (let i = 0; i < ids.length; i++) {
    if (adj.has(ids[i])) return false
  }
  return true
}

/**
 * apart 图的最大团 > K ⇒ 必定无解。这是个便宜的必要条件检查，让"真无解"能立刻
 * 报错，而不是等 300 次重启全失败。分支限界，超预算就放弃检查（不影响正确性）。
 */
function maxCliqueSize (nodes, apartAdj, budget) {
  let best = 0
  let ops = 0
  let overBudget = false

  function bk (depth, candidates) {
    if (++ops > budget) { overBudget = true; return }
    if (depth > best) best = depth
    for (let i = 0; i < candidates.length; i++) {
      if (depth + (candidates.length - i) <= best) return
      const v = candidates[i]
      const adj = apartAdj[v]
      const next = []
      for (let j = i + 1; j < candidates.length; j++) {
        if (adj.has(candidates[j])) next.push(candidates[j])
      }
      bk(depth + 1, next)
      if (overBudget) return
    }
  }

  bk(0, nodes)
  return overBudget ? -1 : best
}

/**
 * 把受约束的 pod 依次落位，代价增量最小的队优先，走进死路就回溯。
 *
 * 回溯深度等于受约束 pod 的数量（通常十几个），递归安全；预算按"落位次数"计，
 * 超预算就放当次失败，交给外层换 seed 重启。
 */
function placeConstrained (order, teams, apartAdj, targets, mu, invMuSq, rng, budget) {
  let ops = 0

  function dfs (i) {
    if (i === order.length) return true
    const pod = order[i]

    const cands = []
    for (let t = 0; t < teams.length; t++) {
      const team = teams[t]
      if (!canPlace(pod, team, apartAdj)) continue
      const before = teamCost(team, targets, mu, invMuSq)
      addPodToTeam(team, pod)
      const delta = teamCost(team, targets, mu, invMuSq) - before
      undoLastPod(team, pod)
      // 量化后再排序：避免浮点噪声把真正的平局拆开，让 jitter 真的能随机平局，
      // 否则队伍选择会固定偏向低编号。
      cands.push({ team: team, key: Math.round(delta * 1e6), jitter: rng() })
    }
    if (cands.length === 0) return false
    cands.sort(function (a, b) { return (a.key - b.key) || (a.jitter - b.jitter) })

    for (let c = 0; c < cands.length; c++) {
      if (++ops > budget) return false
      addPodToTeam(cands[c].team, pod)
      if (dfs(i + 1)) return true
      undoLastPod(cands[c].team, pod)
    }
    return false
  }

  return dfs(0)
}

/**
 * 构造一个完整分配。返回 teams，或 null 表示本次因 apart 无处可放而失败。
 *
 * 两个阶段：
 *  1. 受约束的 pod（多人 pod 或有 apart 边）先落位，apart 度数高者优先。
 *     这是约束满足问题的标准启发式——最受限的先放，且大 pod 的落位对最终
 *     质量影响最大，不该等到最后被动塞。
 *  2. 无约束的单人 pod 按性别分流做蛇形选秀。男队、女队各自独立选秀是混合
 *     飞盘的现实做法，天然保证各性别人数与水平都均衡，结果也可解释。
 */
function buildAssignment (pods, teamCount, apartAdj, targets, mu, invMuSq, rng) {
  const teams = new Array(teamCount)
  for (let i = 0; i < teamCount; i++) teams[i] = makeTeam(i)

  // 分三类。关键点：只有 apart 边决定可行性——没有 apart 边的 pod 放在哪一队
  // 都不会让别人无处可放（人数是软约束），所以它不需要回溯，也不该拖慢回溯。
  const apartPods = []
  const bulkPods = []
  const freeByClass = { F: [], M: [], U: [] }
  for (let i = 0; i < pods.length; i++) {
    const pod = pods[i]
    const deg = apartAdj[pod.id] ? apartAdj[pod.id].size : 0
    if (deg > 0) apartPods.push(pod)
    else if (pod.size > 1) bulkPods.push(pod)
    else freeByClass[pod.dominantClass].push(pod)
  }

  // 先洗牌再稳定排序：同键项的顺序由 PRNG 决定，这就是随机性的来源。
  shuffleInPlace(apartPods, rng)
  apartPods.sort(function (a, b) {
    const da = apartAdj[a.id].size
    const db = apartAdj[b.id].size
    if (db !== da) return db - da          // 最受约束者优先（MRV）
    if (b.size !== a.size) return b.size - a.size
    return b.levelSum - a.levelSum
  })

  // 阶段 1a：带 apart 约束的 pod，最佳适配 + 限定预算的回溯。
  //
  // 纯贪心在这里一定存在失败输入：apart 边把本可同队的 pod 散到不同队后，
  // 后来的 pod 会两边都冲突，而实例本身是可行的。代价排序保证首选仍是最佳适配，
  // 回溯只在走进死路时展开，正常名单上开销接近零。
  if (!placeConstrained(apartPods, teams, apartAdj, targets, mu, invMuSq, rng, 20000)) {
    return null
  }

  // 阶段 1b：多人 pod 但无 apart 约束，直接最佳适配，不需要回溯。
  shuffleInPlace(bulkPods, rng)
  bulkPods.sort(function (a, b) { return b.size - a.size || b.levelSum - a.levelSum })
  for (let i = 0; i < bulkPods.length; i++) {
    const pod = bulkPods[i]
    let bestTeam = null
    let bestKey = Infinity
    let ties = 0
    for (let t = 0; t < teams.length; t++) {
      const team = teams[t]
      const before = teamCost(team, targets, mu, invMuSq)
      addPodToTeam(team, pod)
      const key = Math.round((teamCost(team, targets, mu, invMuSq) - before) * 1e6)
      undoLastPod(team, pod)
      if (key < bestKey) {
        bestKey = key
        bestTeam = team
        ties = 1
      } else if (key === bestKey) {
        ties++
        if (rng() < 1 / ties) bestTeam = team
      }
    }
    addPodToTeam(bestTeam, pod)
  }

  // 阶段 2：按性别分流蛇形选秀，强者先发。
  for (let c = 0; c < CLASSES.length; c++) {
    const cls = CLASSES[c]
    const stream = freeByClass[cls]
    if (stream.length === 0) continue
    shuffleInPlace(stream, rng)
    stream.sort(function (a, b) { return b.levelSum - a.levelSum })

    for (let i = 0; i < stream.length; i++) {
      const pod = stream[i]
      // 键依次是：本类人数最少 → 总人数最少 → 本类水平总和最低。
      //  - 本类人数在最前，保证该性别的人数均衡；人数相同时它等价于蛇形，
      //    被阶段 1 的 pod 拉偏时会自动补偿回来。
      //  - 总人数排第二是必需的：只按本类人数发牌，各性别的余数会随机重叠到
      //    同一队上，造成总人数极差 2。优先给总人数少的队就避开了重叠。
      //  - 本类水平总和最低排第三，这是蛇形选秀"最弱的队先挑最强的人"那一步。
      let bestTeam = null
      let bestCount = Infinity
      let bestSize = Infinity
      let bestLevel = Infinity
      let tieCount = 0
      for (let t = 0; t < teams.length; t++) {
        const team = teams[t]
        const cn = team.count[cls]
        const sz = team.size
        const lv = team.levelSumByClass[cls]
        if (cn < bestCount ||
            (cn === bestCount && sz < bestSize) ||
            (cn === bestCount && sz === bestSize && lv < bestLevel)) {
          bestCount = cn
          bestSize = sz
          bestLevel = lv
          bestTeam = team
          tieCount = 1
        } else if (cn === bestCount && sz === bestSize && lv === bestLevel) {
          tieCount++
          if (rng() < 1 / tieCount) bestTeam = team
        }
      }
      addPodToTeam(bestTeam, pod)
    }
  }

  return teams
}

/**
 * @param {Array} players  [{ id, name?, gender, level|selfLevel|adminLevel }]
 * @param {number} teamCount
 * @param {Array} constraints [{ type: 'together'|'apart', ids: [...] }]
 * @param {number} [seed]
 * @param {object} [options] { restarts }
 */
function divide (players, teamCount, constraints, seed, options) {
  const opts = options || {}
  const restarts = opts.restarts != null ? opts.restarts : DEFAULT_RESTARTS
  const baseSeed = (seed != null && isFinite(Number(seed))) ? (Number(seed) >>> 0) : randomSeed()
  const warnings = []

  if (!Array.isArray(players)) {
    return fail(ERR.INVALID_PLAYERS, 'players 必须是数组')
  }
  if (typeof teamCount !== 'number' || !isFinite(teamCount) ||
      Math.floor(teamCount) !== teamCount || teamCount < 1) {
    return fail(ERR.INVALID_TEAM_COUNT, '队伍数必须是不小于 1 的整数', { teamCount: teamCount })
  }
  const cons = Array.isArray(constraints) ? constraints : []

  // ---- 规范化与校验 ----
  const norm = new Array(players.length)
  const idToIdx = new Map()
  let levelFixedCount = 0
  let genderUnknownCount = 0

  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    if (!p || typeof p !== 'object') {
      return fail(ERR.INVALID_PLAYER, '第 ' + (i + 1) + ' 个球员不是对象', { position: i })
    }
    if (p.id == null || p.id === '') {
      return fail(ERR.INVALID_PLAYER, '第 ' + (i + 1) + ' 个球员缺少 id', { position: i })
    }
    const id = String(p.id)
    if (idToIdx.has(id)) {
      return fail(ERR.DUPLICATE_PLAYER, '球员 id 重复：' + id, { id: id })
    }
    idToIdx.set(id, i)
    const lv = normalizeLevel(p)
    if (lv.fixed) levelFixedCount++
    const gender = normalizeGender(p.gender)
    if (gender === 'U') genderUnknownCount++
    norm[i] = {
      id: id,
      name: p.name != null ? String(p.name) : id,
      gender: gender,
      level: lv.level,
      raw: p,
    }
  }

  if (levelFixedCount > 0) {
    warnings.push({
      code: WARN.LEVEL_FIXED,
      message: levelFixedCount + ' 名球员的水平缺失或超出 1-5，已按默认值处理',
    })
  }
  if (genderUnknownCount > 0) {
    warnings.push({
      code: WARN.GENDER_UNKNOWN,
      message: genderUnknownCount + ' 名球员未填性别，已单独作为一类均衡',
    })
  }

  const n = norm.length

  // ---- 全局目标值 ----
  const totalCount = emptyCounts()
  let totalStar = 0
  let totalLevel = 0
  for (let i = 0; i < n; i++) {
    totalCount[norm[i].gender]++
    if (norm[i].level >= STAR_LEVEL) totalStar++
    totalLevel += norm[i].level
  }

  // 目标值一律用分数，不取整：平方惩罚在分数目标下恰好在均衡分布处取到最小。
  const targets = {
    size: n / teamCount,
    count: {
      F: totalCount.F / teamCount,
      M: totalCount.M / teamCount,
      U: totalCount.U / teamCount,
    },
    star: totalStar / teamCount,
  }
  const mu = n > 0 ? totalLevel / n : 0
  // μ=0 只可能发生在 n=0（水平最低是 1），此时水平项整体无意义，直接取 0 避免除零。
  const invMuSq = mu > 0 ? 1 / (mu * mu) : 0

  if (n === 0) {
    const emptyTeams = []
    for (let i = 0; i < teamCount; i++) emptyTeams.push(makeTeam(i))
    warnings.push({ code: WARN.EMPTY_TEAMS, message: '没有球员，返回 ' + teamCount + ' 个空队' })
    return finish(emptyTeams, [], norm, teamCount, targets, mu, invMuSq, baseSeed, warnings)
  }

  // ---- together 合并成 pod ----
  const dsu = makeDsu(n)
  for (let i = 0; i < cons.length; i++) {
    const c = cons[i]
    if (!c || c.type !== 'together') continue
    const ids = c.ids || c.signupIds || []
    let firstIdx = -1
    for (let j = 0; j < ids.length; j++) {
      const key = String(ids[j])
      if (!idToIdx.has(key)) {
        return fail(ERR.UNKNOWN_PLAYER, '同队约束引用了不存在的球员：' + key, { id: key, type: 'together' })
      }
      const idx = idToIdx.get(key)
      if (firstIdx < 0) firstIdx = idx
      else dsu.union(firstIdx, idx)
    }
  }

  const rootToPod = new Map()
  const pods = []
  const playerPod = new Array(n)
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i)
    let pod = rootToPod.get(root)
    if (!pod) {
      pod = {
        id: pods.length,
        playerIdx: [],
        size: 0,
        count: emptyCounts(),
        levelSumByClass: emptyCounts(),
        star: 0,
        levelSum: 0,
        dominantClass: 'U',
      }
      rootToPod.set(root, pod)
      pods.push(pod)
    }
    pod.playerIdx.push(i)
    pod.size++
    pod.count[norm[i].gender]++
    pod.levelSumByClass[norm[i].gender] += norm[i].level
    pod.levelSum += norm[i].level
    if (norm[i].level >= STAR_LEVEL) pod.star++
    playerPod[i] = pod.id
  }
  for (let i = 0; i < pods.length; i++) {
    const pod = pods[i]
    pod.dominantClass = pod.count.F >= pod.count.M && pod.count.F >= pod.count.U ? 'F'
      : pod.count.M >= pod.count.U ? 'M' : 'U'
  }

  // ---- apart 映射到 pod 级 ----
  // 必须在边映射阶段判同 pod 冲突，而不是在并查集合并阶段：
  // together(a,b) + together(c,d) + apart(b,c) 这类跨 pod 情形只有映射后才看得出来，
  // 而且映射后 b 与 d 也会被正确分开。
  const apartAdj = new Array(pods.length)
  for (let i = 0; i < pods.length; i++) apartAdj[i] = new Set()

  for (let i = 0; i < cons.length; i++) {
    const c = cons[i]
    if (!c || c.type !== 'apart') continue
    const ids = c.ids || c.signupIds || []
    const idxs = []
    for (let j = 0; j < ids.length; j++) {
      const key = String(ids[j])
      if (!idToIdx.has(key)) {
        return fail(ERR.UNKNOWN_PLAYER, '拆开约束引用了不存在的球员：' + key, { id: key, type: 'apart' })
      }
      idxs.push(idToIdx.get(key))
    }
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (idxs[a] === idxs[b]) {
          return fail(ERR.APART_SELF, '拆开约束不能指向同一个人：' + norm[idxs[a]].name,
            { id: norm[idxs[a]].id })
        }
        const pa = playerPod[idxs[a]]
        const pb = playerPod[idxs[b]]
        if (pa === pb) {
          return fail(ERR.APART_IN_SAME_POD,
            norm[idxs[a]].name + ' 与 ' + norm[idxs[b]].name + ' 既被要求同队又被要求拆开',
            { ids: [norm[idxs[a]].id, norm[idxs[b]].id] })
        }
        apartAdj[pa].add(pb)
        apartAdj[pb].add(pa)
      }
    }
  }

  // ---- 退化与不可行的预检 ----
  const cap = Math.ceil(n / teamCount)
  let oversizePod = null
  for (let i = 0; i < pods.length; i++) {
    if (pods[i].size > cap) { oversizePod = pods[i]; break }
  }
  if (oversizePod) {
    // 不报错：软模式放宽该队上限。赛前告诉组织者"无解"的工具是没用的。
    warnings.push({
      code: WARN.POD_OVER_CAPACITY,
      message: '有 ' + oversizePod.size + ' 人要求同队，超过单队均摊人数 ' + cap + '，该队会偏多',
    })
  }

  if (teamCount === 1) {
    let hasApart = false
    for (let i = 0; i < apartAdj.length; i++) {
      if (apartAdj[i].size > 0) { hasApart = true; break }
    }
    if (hasApart) {
      warnings.push({
        code: WARN.APART_IGNORED_SINGLE_TEAM,
        message: '只有 1 个队，拆开约束无法满足，已忽略',
      })
    }
    const single = makeTeam(0)
    for (let i = 0; i < pods.length; i++) addPodToTeam(single, pods[i])
    return finish([single], pods, norm, teamCount, targets, mu, invMuSq, baseSeed, warnings)
  }

  if (pods.length < teamCount) {
    warnings.push({
      code: WARN.EMPTY_TEAMS,
      message: '可分配单元只有 ' + pods.length + ' 个，少于 ' + teamCount + ' 个队，会有空队',
    })
  }
  if (totalCount.F > 0 && totalCount.F < teamCount) {
    warnings.push({
      code: WARN.FEWER_FEMALES_THAN_TEAMS,
      message: '女生共 ' + totalCount.F + ' 人，少于 ' + teamCount + ' 个队，无法每队至少 1 人',
    })
  }

  const apartNodes = []
  for (let i = 0; i < pods.length; i++) {
    if (apartAdj[i].size > 0) apartNodes.push(i)
  }
  if (apartNodes.length > 1) {
    const clique = maxCliqueSize(apartNodes, apartAdj, 200000)
    if (clique > teamCount) {
      return fail(ERR.APART_INFEASIBLE,
        '有 ' + clique + ' 个单元互相要求拆开，但只有 ' + teamCount + ' 个队，无法满足',
        { cliqueSize: clique, teamCount: teamCount })
    }
  }

  // ---- 多次随机重启取最优 ----
  let bestTeams = null
  let bestCost = null
  let attempts = 0
  for (let r = 0; r < restarts; r++) {
    const rng = createPrng(mixSeed(baseSeed, r))
    const teams = buildAssignment(pods, teamCount, apartAdj, targets, mu, invMuSq, rng)
    if (teams === null) continue
    attempts++
    const cost = totalCost(teams, targets, mu, invMuSq)
    if (bestCost === null || cost.total < bestCost.total - 1e-9) {
      bestTeams = teams
      bestCost = cost
    }
  }

  if (bestTeams === null) {
    return fail(ERR.APART_INFEASIBLE,
      '试了 ' + restarts + ' 次都无法满足全部拆开约束，请检查约束是否互相矛盾',
      { restarts: restarts })
  }

  return finish(bestTeams, pods, norm, teamCount, targets, mu, invMuSq, baseSeed, warnings, bestCost)
}

function finish (teams, pods, norm, teamCount, targets, mu, invMuSq, seed, warnings, cost) {
  const breakdown = cost || totalCost(teams, targets, mu, invMuSq)

  const outTeams = new Array(teams.length)
  let sizeMin = Infinity; let sizeMax = -Infinity
  let femaleMin = Infinity; let femaleMax = -Infinity
  let avgMin = Infinity; let avgMax = -Infinity

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i]
    const members = new Array(t.playerIdx.length)
    const memberIds = new Array(t.playerIdx.length)
    for (let j = 0; j < t.playerIdx.length; j++) {
      const p = norm[t.playerIdx[j]]
      members[j] = { id: p.id, name: p.name, gender: p.gender, level: p.level }
      memberIds[j] = p.id
    }
    // 展示顺序按水平降序，组织者看名单时更直观。
    const order = members.map(function (m, k) { return k })
    order.sort(function (a, b) {
      if (members[b].level !== members[a].level) return members[b].level - members[a].level
      return members[a].name < members[b].name ? -1 : members[a].name > members[b].name ? 1 : 0
    })
    const sortedMembers = order.map(function (k) { return members[k] })
    const sortedIds = order.map(function (k) { return memberIds[k] })

    const avgLevel = t.size > 0 ? t.levelSum / t.size : 0
    outTeams[i] = {
      index: t.index,
      name: t.name,
      memberIds: sortedIds,
      members: sortedMembers,
      stats: {
        count: t.size,
        male: t.count.M,
        female: t.count.F,
        unknown: t.count.U,
        star: t.star,
        levelSum: t.levelSum,
        avgLevel: Math.round(avgLevel * 100) / 100,
      },
    }

    if (t.size < sizeMin) sizeMin = t.size
    if (t.size > sizeMax) sizeMax = t.size
    if (t.count.F < femaleMin) femaleMin = t.count.F
    if (t.count.F > femaleMax) femaleMax = t.count.F
    // 空队的均分是 0，计入极差会让这个给组织者看的数字虚高（水平只有 1-5，
    // 真实极差最大是 4），所以只统计非空队。
    if (t.size > 0) {
      if (avgLevel < avgMin) avgMin = avgLevel
      if (avgLevel > avgMax) avgMax = avgLevel
    }
  }

  let playerCount = 0
  let maleTotal = 0
  let femaleTotal = 0
  let unknownTotal = 0
  let levelTotal = 0
  for (let i = 0; i < norm.length; i++) {
    playerCount++
    if (norm[i].gender === 'M') maleTotal++
    else if (norm[i].gender === 'F') femaleTotal++
    else unknownTotal++
    levelTotal += norm[i].level
  }

  return {
    ok: true,
    seed: seed,
    teams: outTeams,
    stats: {
      playerCount: playerCount,
      teamCount: teamCount,
      podCount: pods.length,
      maleTotal: maleTotal,
      femaleTotal: femaleTotal,
      unknownTotal: unknownTotal,
      avgLevel: playerCount > 0 ? Math.round((levelTotal / playerCount) * 100) / 100 : 0,
      sizeSpread: sizeMax - sizeMin,
      femaleSpread: femaleMax - femaleMin,
      avgLevelSpread: avgMax >= avgMin ? Math.round((avgMax - avgMin) * 100) / 100 : 0,
    },
    costBreakdown: {
      size: Math.round(breakdown.size * 1000) / 1000,
      gender: Math.round(breakdown.gender * 1000) / 1000,
      star: Math.round(breakdown.star * 1000) / 1000,
      level: Math.round(breakdown.level * 1000) / 1000,
      total: Math.round(breakdown.total * 1000) / 1000,
    },
    warnings: warnings,
  }
}

module.exports = { divide, ERR, WARN, normalizeGender, normalizeLevel, STAR_LEVEL }
