'use strict'

/**
 * 云函数调用封装。所有请求都走这里，统一处理返回格式、loading 和报错提示。
 */

const config = require('../config.js')

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
    const r = res && res.result
    if (!r) throw new Error('云函数没有返回内容')
    if (r.ok) return r.data
    const e = new Error((r.error && r.error.message) || '操作失败')
    e.code = r.error && r.error.code
    e.detail = r.error && r.error.detail
    throw e
  }).catch(function (e) {
    if (loading) wx.hideLoading()
    // 网络层失败拿不到我们自己的错误格式，给一个能看懂的提示。
    if (!e.code && e.errMsg) {
      e.message = e.errMsg.indexOf('FunctionName') >= 0
        ? '云函数 ' + name + ' 还没部署，请在开发者工具里右键 cloudfunctions/' + name + ' 上传部署'
        : '网络异常，请重试'
    }
    if (toastError) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none', duration: 2500 })
    }
    throw e
  })
}

module.exports = {
  call: call,
  event: function (action, data, opts) { return call('hat-event', action, data, opts) },
  signup: function (action, data, opts) { return call('hat-signup', action, data, opts) },
  team: function (action, data, opts) { return call('hat-team', action, data, opts) },
}
