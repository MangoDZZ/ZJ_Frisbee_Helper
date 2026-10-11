'use strict'

/**
 * 页面静态一致性检查。小程序的 WXML 绑定错了不会在编译期报错，只在点下去的
 * 那一刻静默失效，所以这些关系必须离线查一遍。
 *
 *   node tests/check-pages.js
 *
 * 检查项：
 *  1. WXML 绑定的事件处理函数在对应 JS 里存在
 *  2. WXML 引用的 {{字段}} 在 JS 的 data 里有声明或被 setData 写过
 *  3. app.json 的 pages 列表与实际目录一一对应，四件套文件齐全
 *  4. 页面跳转 URL 指向的页面都在 app.json 里注册过
 *  5. api.event/signup/team 调用的 action 在对应云函数里实现了
 */

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const mp = path.join(root, 'miniprogram')
const pagesDir = path.join(mp, 'pages')

let problems = 0
function bad (msg) {
  problems++
  console.log('  ✗ ' + msg)
}

// ---------------------------------------------------------------- 1. app.json

const appJson = JSON.parse(fs.readFileSync(path.join(mp, 'app.json'), 'utf8'))
const registered = appJson.pages.slice()

console.log('检查 app.json 与页面文件')
const dirs = fs.readdirSync(pagesDir).filter(function (d) {
  return fs.statSync(path.join(pagesDir, d)).isDirectory()
})

registered.forEach(function (p) {
  const parts = p.split('/')
  const dir = parts[1]
  const file = parts[2]
  ;['js', 'wxml', 'json'].forEach(function (ext) {
    const f = path.join(pagesDir, dir, file + '.' + ext)
    if (!fs.existsSync(f)) bad('app.json 注册了 ' + p + '，但缺少 ' + file + '.' + ext)
  })
})
dirs.forEach(function (d) {
  const found = registered.some(function (p) { return p.split('/')[1] === d })
  if (!found) bad('目录 pages/' + d + ' 没有在 app.json 的 pages 里注册')
})
;(appJson.tabBar && appJson.tabBar.list ? appJson.tabBar.list : []).forEach(function (t) {
  if (registered.indexOf(t.pagePath) < 0) {
    bad('tabBar 里的 ' + t.pagePath + ' 不在 pages 列表里')
  }
})

// ---------------------------------------------------------------- 2. 事件与字段

const WX_LIFECYCLE = [
  'data', 'onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onPullDownRefresh',
  'onReachBottom', 'onShareAppMessage', 'onShareTimeline', 'onAddToFavorites',
  'onPageScroll', 'onResize', 'onTabItemTap',
]

// WXML 内置的标签属性值与关键字，不当作 data 字段
const WXML_KEYWORDS = [
  'true', 'false', 'null', 'undefined', 'item', 'index', 'm',
]

console.log('检查各页面的事件绑定与字段引用')
registered.forEach(function (p) {
  const parts = p.split('/')
  const dir = parts[1]
  const file = parts[2]
  const jsPath = path.join(pagesDir, dir, file + '.js')
  const wxmlPath = path.join(pagesDir, dir, file + '.wxml')
  if (!fs.existsSync(jsPath) || !fs.existsSync(wxmlPath)) return

  const js = fs.readFileSync(jsPath, 'utf8')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')

  // -- 2a. 事件处理函数存在
  const handlers = []
  const bindRe = /\b(?:bind|catch)[:]?[A-Za-z]+\s*=\s*"([^"{}]+)"/g
  let m
  while ((m = bindRe.exec(wxml)) !== null) {
    if (handlers.indexOf(m[1]) < 0) handlers.push(m[1])
  }
  handlers.forEach(function (h) {
    // 用 indexOf 而不是拼正则，避免转义把自己绕进去
    const needle = h + ':'
    let at = js.indexOf(needle)
    let found = false
    while (at >= 0) {
      const before = at === 0 ? '\n' : js.charAt(at - 1)
      const after = js.slice(at + needle.length).replace(/^\s+/, '')
      if (!/[A-Za-z0-9_$.]/.test(before) && after.indexOf('function') === 0) {
        found = true
        break
      }
      at = js.indexOf(needle, at + 1)
    }
    if (!found) bad('[' + dir + '] WXML 绑定了 ' + h + '，JS 里没有对应方法')
  })

  // -- 2b. WXML 用到的顶层字段在 JS 里出现过
  const fields = []
  const exprRe = /\{\{([^}]*)\}\}/g
  while ((m = exprRe.exec(wxml)) !== null) {
    // 先把字符串字面量抹掉，否则 {{scope === 'mine'}} 里的 mine 会被当成字段。
    const expr = m[1]
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
    const idRe = /[A-Za-z_$][A-Za-z0-9_$]*/g
    let id
    while ((id = idRe.exec(expr)) !== null) {
      const before = expr.charAt(id.index - 1)
      if (before === '.') continue           // 属性访问，跳过
      const after = expr.charAt(id.index + id[0].length)
      if (after === '(') continue            // 方法调用（WXS）
      if (WXML_KEYWORDS.indexOf(id[0]) >= 0) continue
      if (fields.indexOf(id[0]) < 0) fields.push(id[0])
    }
  }
  // wx:for-item / wx:for-index 自定义的别名也不算字段
  const aliasRe = /wx:for-(?:item|index)\s*=\s*"([^"]+)"/g
  const aliases = []
  while ((m = aliasRe.exec(wxml)) !== null) aliases.push(m[1])

  fields.forEach(function (f) {
    if (aliases.indexOf(f) >= 0) return
    if (js.indexOf(f) < 0) {
      bad('[' + dir + '] WXML 用到字段 {{' + f + '}}，JS 里从未出现')
    }
  })

  // -- 2c. 跳转目标必须是注册过的页面
  const urlRe = /url:\s*'(\/pages\/[^'?]+)/g
  while ((m = urlRe.exec(js)) !== null) {
    const target = m[1].replace(/^\//, '')
    if (registered.indexOf(target) < 0) {
      bad('[' + dir + '] 跳转到未注册的页面 ' + target)
    }
  }
})

// ---------------------------------------------------------------- 3. 云函数 action

console.log('检查云函数 action 是否都已实现')
// 新增云函数时记得在这里登记，否则对它的调用会被静默跳过、查了等于没查。
const FN = {
  event: 'hat-event',
  signup: 'hat-signup',
  team: 'hat-team',
  match: 'hat-match',
}
const FN_KEYS = Object.keys(FN)
const implemented = {}
FN_KEYS.forEach(function (k) {
  const src = fs.readFileSync(path.join(root, 'cloudfunctions', FN[k], 'index.js'), 'utf8')
  const names = []
  const re = /^\s{2}(?:async\s+)?([A-Za-z][A-Za-z0-9_]*)\s*\(/gm
  let m
  while ((m = re.exec(src)) !== null) names.push(m[1])
  implemented[k] = names
})

// 每个云函数都要有被调用到的 action，否则说明登记了却没接上
FN_KEYS.forEach(function (k) {
  if (implemented[k].length === 0) {
    bad('云函数 ' + FN[k] + ' 里没有解析到任何 action，检查写法是否变了')
  }
})

function scanCalls (dir) {
  fs.readdirSync(dir).forEach(function (f) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) return scanCalls(p)
    if (!f.endsWith('.js')) return
    const src = fs.readFileSync(p, 'utf8')
    const re = new RegExp('api\\.(' + FN_KEYS.join('|') + ")\\(\\s*'([^']+)'", 'g')
    let m
    while ((m = re.exec(src)) !== null) {
      if (implemented[m[1]].indexOf(m[2]) < 0) {
        bad(path.relative(root, p) + ' 调用了 ' + FN[m[1]] + ' 的 ' + m[2] +
          '，该云函数里没有这个 action')
      }
    }
    // 调了一个没登记的云函数入口，同样要报出来
    const unknown = /api\.([A-Za-z][A-Za-z0-9_]*)\(\s*'/g
    while ((m = unknown.exec(src)) !== null) {
      if (m[1] !== 'call' && FN_KEYS.indexOf(m[1]) < 0) {
        bad(path.relative(root, p) + ' 调用了未登记的云函数入口 api.' + m[1] +
          '，请在 tests/check-pages.js 的 FN 里登记')
      }
    }
  })
}
scanCalls(mp)

// ---------------------------------------------------------------- 汇总

console.log('')
if (problems === 0) {
  console.log('页面一致性检查通过，未发现问题')
  process.exit(0)
} else {
  console.log('发现 ' + problems + ' 个问题')
  process.exit(1)
}
