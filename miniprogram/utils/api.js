'use strict'

/**
 * 云函数调用封装。所有请求都走这里，统一处理返回格式、loading 和报错提示。
 */

const apiError = require('./api-error.js')
const config = require('../config.js')

/**
 * showToast 只显示两行左右，长提示会被截断，等于白写。
 * 超过这个长度改用弹窗——细化报错的意义就在于那句话要能被完整读到。
 */
const TOAST_MAX = 20

/**
 * @param {string} name   云函数名
 * @param {string} action 动作名
 * @param {object} data   参数
 * @param {object} opts   { loading: string|false, toastError: boolean }
 */
function call (name, action, data, opts) {
  const o = opts || {}
  const loading = o.loading === undefined ? '加载中' : o.loading
  const toastError = o.toastError !== false

  if (!config.isConfigured()) {
    const msg = '请先在 miniprogram/config.js 里填入云开发环境 ID'
    if (toastError) wx.showModal({ title: '还没配置云环境', content: msg, showCancel: false })
    return Promise.reject(new Error(msg))
  }

  if (loading) wx.showLoading({ title: loading, mask: true })

  return wx.cloud.callFunction({
    name: name,
    data: { action: action, data: data || {} },
  }).then(function (res) {
    if (loading) wx.hideLoading()
    const parsed = apiError.readEnvelope(res && res.result)
    if (parsed.ok) return parsed.data

    // 平台的失败原文优先交给翻译器，能认出"没部署/超时"这类可操作的原因
    if (parsed.errMsg) {
      const described = apiError.describeCallFailure(name, parsed.errMsg)
      const e = new Error(described ? described.message
        : apiError.fallbackMessage(name, action, parsed.errMsg))
      e.code = described ? described.code : null
      throw e
    }

    const e = new Error(parsed.message)
    e.code = parsed.code
    e.detail = parsed.detail || null
    throw e
  }).catch(function (e) {
    if (loading) wx.hideLoading()
    // 网络层失败拿不到我们自己的信封，从 errMsg 里判断到底哪一环坏了
    if (!e.code && e.errMsg) {
      const described = apiError.describeCallFailure(name, e.errMsg)
      if (described) {
        e.code = described.code
        e.message = described.message
      } else {
        e.message = apiError.fallbackMessage(name, action, e.errMsg)
      }
    }
    if (toastError) {
      const text = e.message || '操作失败'
      if (text.length > TOAST_MAX) {
        wx.showModal({ title: '操作失败', content: text, showCancel: false })
      } else {
        wx.showToast({ title: text, icon: 'none', duration: 3000 })
      }
    }
    throw e
  })
}

module.exports = {
  call: call,
  event: function (action, data, opts) { return call('hat-event', action, data, opts) },
  signup: function (action, data, opts) { return call('hat-signup', action, data, opts) },
  team: function (action, data, opts) { return call('hat-team', action, data, opts) },
  match: function (action, data, opts) { return call('hat-match', action, data, opts) },
  admin: function (action, data, opts) { return call('hat-admin', action, data, opts) },
}
