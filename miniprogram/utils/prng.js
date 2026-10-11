'use strict'

/**
 * 可 seed 的伪随机数生成器。
 *
 * 分队结果要求"同一 seed 可复现"，而 Math.random() 不可 seed，所以必须自带。
 * 算法里每一处随机都要走这里，漏一处就会出现"多数时候能复现"的恶性 bug。
 */

/** mulberry32：32 位状态，周期 2^32，分布质量足够分队用。 */
function createPrng (seed) {
  let a = (seed >>> 0) || 0x9e3779b9
  return function next () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 由基础 seed 派生第 n 次重启的 seed，保证整个重启序列由基础 seed 唯一确定。 */
function mixSeed (seed, n) {
  let h = (seed >>> 0) ^ Math.imul(n + 1, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Fisher-Yates 原地洗牌。
 *
 * 不要用 sort((a, b) => ... || rng() - 0.5) 代替：随机比较器违反传递性，
 * 属于未定义行为，结果分布有偏。
 */
function shuffleInPlace (arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/** 生成一个可打印、可回填的随机 seed（用户不指定 seed 时用）。 */
function randomSeed () {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0)
}

module.exports = { createPrng, mixSeed, shuffleInPlace, randomSeed }
