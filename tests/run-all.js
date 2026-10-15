'use strict'

/**
 * 跑全部离线测试。
 *
 *   node tests/run-all.js
 *
 * 用 process.execPath 起子进程，所以无论是真 node 还是"拿 VS Code 的 Electron
 * 当 node 用"（ELECTRON_RUN_AS_NODE=1）都能跑。
 */

const path = require('path')
const { spawnSync } = require('child_process')

const SUITES = [
  ['分队算法', 'divide.test.js'],
  ['积分推导', 'score.test.js'],
  ['名单导入解析', 'import-list.test.js'],
  ['时间与展示', 'format.test.js'],
  ['云函数逻辑', 'cloud.test.js'],
  ['页面一致性', 'check-pages.js'],
]

let failed = 0
for (let i = 0; i < SUITES.length; i++) {
  const label = SUITES[i][0]
  const file = path.join(__dirname, SUITES[i][1])
  console.log('')
  console.log('════ ' + label + ' ════')
  const r = spawnSync(process.execPath, [file], {
    stdio: 'inherit',
    env: process.env,
  })
  if (r.status !== 0) failed++
}

console.log('')
if (failed === 0) {
  console.log('✓ 全部测试套件通过')
  process.exit(0)
} else {
  console.log('✗ 有 ' + failed + ' 个测试套件失败')
  process.exit(1)
}
