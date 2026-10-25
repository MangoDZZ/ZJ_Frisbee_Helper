'use strict'

/**
 * 把 shared/ 下的共用模块同步到每个云函数的 lib/ 目录。
 *
 *   node scripts/sync-shared.js
 *
 * 为什么是"同步副本"而不是直接 require：云函数各自独立部署，部署包里只有自己那个
 * 目录，没法引用外面的代码。所以副本是必需的，但**源头只允许有一个**——
 * 以前 roles.js 在 5 个云函数里各手改一份，漏改一处就会出现"同一个人在某些功能里
 * 是管理员、另一些里不是"这种极难排查的权限 bug。
 *
 * 改完 shared/ 里的文件必须跑一次本脚本；tests/check-pages.js 会断言副本与源头一致，
 * 忘了跑测试就会红。生成出来的副本要提交，开发者工具部署时读的就是它们。
 */

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const sharedDir = path.join(root, 'shared')

/** 哪个云函数需要哪几个共用模块。 */
const TARGETS = {
  'hat-event': ['common.js', 'event-config.js', 'roles.js', 'store.js'],
  'hat-signup': ['common.js', 'event-config.js', 'roles.js', 'store.js'],
  'hat-team': ['common.js', 'roles.js', 'store.js'],
  'hat-match': ['common.js', 'roles.js', 'store.js'],
  'hat-admin': ['common.js', 'roles.js'],
}

let written = 0
let removed = 0

Object.keys(TARGETS).forEach(function (fn) {
  const libDir = path.join(root, 'cloudfunctions', fn, 'lib')
  if (!fs.existsSync(libDir)) {
    console.error('找不到 cloudfunctions/' + fn + '/lib，云函数目录被改名了？')
    process.exit(1)
  }

  const wanted = TARGETS[fn]
  wanted.forEach(function (file) {
    const src = fs.readFileSync(path.join(sharedDir, file))
    const dest = path.join(libDir, file)
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(src)) return
    fs.writeFileSync(dest, src)
    written++
    console.log('  同步 ' + fn + '/lib/' + file)
  })

  // 云函数里不再需要的副本留着只会误导人，直接删掉
  fs.readdirSync(libDir).forEach(function (file) {
    if (wanted.indexOf(file) >= 0) return
    if (!fs.existsSync(path.join(sharedDir, file))) return
    fs.unlinkSync(path.join(libDir, file))
    removed++
    console.log('  删除多余副本 ' + fn + '/lib/' + file)
  })
})

console.log('')
if (written === 0 && removed === 0) {
  console.log('✓ 所有副本已是最新')
} else {
  console.log('✓ 已同步 ' + written + ' 个文件' + (removed ? '，删除 ' + removed + ' 个多余副本' : ''))
}
