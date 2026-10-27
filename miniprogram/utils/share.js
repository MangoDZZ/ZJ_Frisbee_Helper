'use strict'

/**
 * 分享卡片。**所有 share 都必须走这里**，不要各页面自己拼。
 *
 * 为什么必须显式指定 imageUrl：不指定时微信会**截取当前页面**当封面图。
 * 组织者看到的页面带评级（分队页每个人的水平、队均水平），一分享就把这些
 * 直接画面给了群里所有人——这是 v1.1.5 报的问题。
 *
 * 固定成一张通用封面后，分享出去的内容与分享者看到什么无关。
 * `tests/check-pages.js` 会检查每个 onShareAppMessage 都用到了它，
 * 并且这张图确实存在——漏掉一处就等于漏一处泄露。
 */

/** 500x400（微信推荐的 5:4）。改这张图直接替换文件即可，别改这里的路径。 */
const SHARE_IMAGE = '/images/share.png'

/**
 * 给分享内容补上封面图。
 * @param {object} payload { title, path } 之类，见微信文档
 */
function withImage (payload) {
  const out = Object.assign({}, payload)
  out.imageUrl = SHARE_IMAGE
  return out
}

module.exports = {
  SHARE_IMAGE: SHARE_IMAGE,
  withImage: withImage,
}
