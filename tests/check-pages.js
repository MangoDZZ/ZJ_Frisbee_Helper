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
  admin: 'hat-admin',
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

// ---------------------------------------------------------------- 4. shared/ 副本一致

console.log('检查 shared/ 下的共用模块与各云函数的副本是否一致')
// 云函数各自独立部署，部署包里只有自己那个目录，没法引用外面的代码，所以副本是必需的。
// 但**源头只允许有一个**：shared/ 下的文件才是能改的，各云函数 lib/ 下的是生成物。
// 一旦漂移，就会出现"同一个人在某些功能里是管理员、另一些里不是"这种极难排查的权限 bug。
const sharedDir = path.join(root, 'shared')
const sharedFiles = fs.existsSync(sharedDir)
  ? fs.readdirSync(sharedDir).filter(function (f) { return f.endsWith('.js') })
  : []
if (sharedFiles.length === 0) {
  bad('shared/ 目录不存在或没有 .js 文件')
}

FN_KEYS.forEach(function (k) {
  const libDir = path.join(root, 'cloudfunctions', FN[k], 'lib')
  const copies = fs.existsSync(libDir)
    ? fs.readdirSync(libDir).filter(function (f) { return f.endsWith('.js') })
    : []
  sharedFiles.forEach(function (file) {
    const copyPath = path.join(libDir, file)
    if (!fs.existsSync(copyPath)) return          // 这个云函数不需要它
    const src = fs.readFileSync(path.join(sharedDir, file), 'utf8')
    if (fs.readFileSync(copyPath, 'utf8') !== src) {
      bad(FN[k] + '/lib/' + file + ' 与 shared/' + file + ' 不一致，' +
        '跑一下 node scripts/sync-shared.js')
    }
  })
  // 副本里有、shared/ 里没有的共用模块 = 改名后没同步干净（各云函数自有的
  // score.js / import-list.js 不在此列，它们在 shared/ 里本来就没有对应源文件）
  if (copies.indexOf('roles.js') < 0) {
    bad('云函数 ' + FN[k] + ' 缺少 lib/roles.js')
  }
})

// 小程序端也用的纯 JS 模块（同一份源码两个运行时共用，见 scripts/sync-shared.js）
const MINIPROGRAM_SHARED = ['match-rules.js']
MINIPROGRAM_SHARED.forEach(function (file) {
  const copyPath = path.join(mp, 'utils', file)
  const srcPath = path.join(sharedDir, file)
  if (!fs.existsSync(copyPath)) {
    bad('缺少 miniprogram/utils/' + file + '，跑一下 node scripts/sync-shared.js')
    return
  }
  if (fs.readFileSync(copyPath, 'utf8') !== fs.readFileSync(srcPath, 'utf8')) {
    bad('miniprogram/utils/' + file + ' 与 shared/' + file + ' 不一致，' +
      '跑一下 node scripts/sync-shared.js')
  }
  // 两个运行时共用的前提是它不碰任何一端专属的 API
  const body = fs.readFileSync(srcPath, 'utf8')
  if (/\bwx\./.test(body)) bad('shared/' + file + ' 用了 wx API，小程序之外跑不了')
  if (/require\('(?!\.)/.test(body)) bad('shared/' + file + ' require 了外部包，小程序端没有')
})

// 管理员名单不能是空的，否则没人能管理组织者、也没人能接手管理权
const rolesSrcPath = path.join(sharedDir, 'roles.js')
if (fs.existsSync(rolesSrcPath)) {
  const src = fs.readFileSync(rolesSrcPath, 'utf8')
  const m = src.match(/const ADMIN_OPENIDS = \[([\s\S]*?)\]/)
  if (!m || m[1].trim() === '') {
    bad('ADMIN_OPENIDS 是空的，将没有任何人可以管理组织者')
  }
}

// ---------------------------------------------------------------- 5. 常量一致

console.log('检查跨端常量与版本号')
// STAR_LEVEL 决定"高分球员"的界线：客户端拿它分队，云函数拿它重算队伍统计。
// 两边不一致时不会报错，只会出现"分队时按 5 分算、展示时说 4 分算高分"的怪数字。
const clientDivide = fs.readFileSync(path.join(mp, 'utils', 'divide.js'), 'utf8')
const clientStar = clientDivide.match(/const STAR_LEVEL = (\d+)/)
if (!clientStar) bad('miniprogram/utils/divide.js 里找不到 STAR_LEVEL')
FN_KEYS.forEach(function (k) {
  const src = fs.readFileSync(path.join(root, 'cloudfunctions', FN[k], 'index.js'), 'utf8')
  const m = src.match(/const STAR_LEVEL = (\d+)/)
  if (!m) return                        // 这个云函数用不到，跳过
  if (clientStar && m[1] !== clientStar[1]) {
    bad('cloudfunctions/' + FN[k] + ' 的 STAR_LEVEL=' + m[1] +
      ' 与 miniprogram/utils/divide.js 的 ' + clientStar[1] + ' 不一致')
  }
})

// 版本号：后台管理页显示它，plan.md 的最后一节是当前版本，两边必须同步
const configSrc = fs.readFileSync(path.join(mp, 'config.js'), 'utf8')
const versionM = configSrc.match(/const VERSION = '([^']+)'/)
if (!versionM) {
  bad('miniprogram/config.js 里没有 VERSION')
} else {
  const plan = fs.readFileSync(path.join(root, 'plan.md'), 'utf8')
  const headings = []
  const hRe = /^## (v\d+\.\d+\.\d+)\s*$/gm
  let hm
  while ((hm = hRe.exec(plan)) !== null) headings.push(hm[1])
  const latest = headings.length > 0 ? headings[headings.length - 1] : null
  if (!latest) {
    bad('plan.md 里找不到形如 "## v1.2.3" 的版本小节')
  } else if (latest !== versionM[1]) {
    bad('config.js 的 VERSION=' + versionM[1] + ' 与 plan.md 最新版本 ' + latest +
      ' 不一致，发版前记得同步')
  }
}

// 报名表字段的 key 必须两端一致：服务端 shared/event-config.js 决定校验什么，
// 小程序 utils/signup-fields.js 决定渲染什么。漂移的表现是"组织者勾了年龄，
// 报名页却没有这一栏"，不会报错，只会静默少收数据。
const clientFieldsPath = path.join(mp, 'utils', 'signup-fields.js')
if (!fs.existsSync(clientFieldsPath)) {
  bad('缺少 miniprogram/utils/signup-fields.js（报名表字段的前端镜像）')
} else {
  const sharedSrc = fs.readFileSync(path.join(sharedDir, 'event-config.js'), 'utf8')
  const clientSrc = fs.readFileSync(clientFieldsPath, 'utf8')
  function keysOf (src, marker) {
    const at = src.indexOf(marker)
    if (at < 0) return null
    const end = src.indexOf(']', at)
    const block = src.slice(at, end < 0 ? src.length : end)
    const out = []
    const re = /key:\s*'([A-Za-z]+)'/g
    let m
    while ((m = re.exec(block)) !== null) out.push(m[1])
    return out
  }
  const sharedKeys = keysOf(sharedSrc, 'CONFIGURABLE_FIELDS = [')
  const clientKeys = keysOf(clientSrc, 'CONFIGURABLE_FIELDS = [')
  if (!sharedKeys || !clientKeys) {
    bad('解析不出 CONFIGURABLE_FIELDS 的字段列表')
  } else if (sharedKeys.join(',') !== clientKeys.join(',')) {
    bad('报名表可配置字段不一致：shared/event-config.js 是 [' + sharedKeys.join(',') +
      ']，miniprogram/utils/signup-fields.js 是 [' + clientKeys.join(',') + ']')
  }
}

// ---------------------------------------------------------------- 6. 分享封面

console.log('检查分享封面的统一性')
// 不指定 imageUrl 时微信会**截当前页面**当封面：组织者的视图里带评级（分队页每个人
// 的水平数字），一分享就等于把评级发到群里。所以每个 onShareAppMessage 都必须
// 走 utils/share.js，且那张图必须真的存在、比例是微信推荐的 5:4。
const shareUtil = path.join(mp, 'utils', 'share.js')
let shareImage = null
if (!fs.existsSync(shareUtil)) {
  bad('缺少 miniprogram/utils/share.js（分享封面的统一出口）')
} else {
  const src = fs.readFileSync(shareUtil, 'utf8')
  const m = src.match(/SHARE_IMAGE\s*=\s*'([^']+)'/)
  if (!m) {
    bad('utils/share.js 里找不到 SHARE_IMAGE')
  } else {
    shareImage = m[1]
    const file = path.join(mp, shareImage.replace(/^\//, ''))
    if (!fs.existsSync(file)) {
      bad('分享封面 ' + shareImage + ' 不存在')
    } else {
      // PNG 的 IHDR 宽高在固定偏移处，不用引图片库就能读
      const buf = fs.readFileSync(file)
      const isPng = buf.length > 24 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      if (!isPng) {
        bad('分享封面 ' + shareImage + ' 不是 PNG')
      } else {
        const w = buf.readUInt32BE(16)
        const h = buf.readUInt32BE(20)
        const ratio = w / h
        if (Math.abs(ratio - 1.25) > 0.02) {
          bad('分享封面 ' + shareImage + ' 是 ' + w + 'x' + h +
            '，比例不是微信推荐的 5:4（1.25），分享出去会被裁')
        }
        if (buf.length > 200 * 1024) {
          bad('分享封面 ' + shareImage + ' 超过 200KB，建议压缩')
        }
      }
    }
  }
}

// 逐页检查：只要定义了 onShareAppMessage，就必须用 share.withImage 包一层
registered.forEach(function (p) {
  const parts = p.split('/')
  const jsPath = path.join(pagesDir, parts[1], parts[2] + '.js')
  if (!fs.existsSync(jsPath)) return
  const src = fs.readFileSync(jsPath, 'utf8')
  if (src.indexOf('onShareAppMessage') < 0) return
  if (src.indexOf('share.withImage') < 0) {
    bad('[' + parts[1] + '] 定义了 onShareAppMessage 但没用 share.withImage 固定封面图，' +
      '微信会截当前页面——组织者视图里的评级会跟着分享出去')
  }
  if (src.indexOf("require('../../utils/share.js')") < 0) {
    bad('[' + parts[1] + '] 用了 share.withImage 却没有 require utils/share.js')
  }
})

// ---------------------------------------------------------------- 汇总

console.log('')
if (problems === 0) {
  console.log('页面一致性检查通过，未发现问题')
  process.exit(0)
} else {
  console.log('发现 ' + problems + ' 个问题')
  process.exit(1)
}
