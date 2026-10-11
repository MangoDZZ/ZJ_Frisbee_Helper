'use strict'

const config = require('./config.js')

App({
  globalData: {
    cloudReady: false,
  },

  onLaunch: function () {
    if (!wx.cloud) {
      console.error('基础库版本过低，云能力不可用，请使用 2.2.3 或以上')
      return
    }
    if (!config.isConfigured()) {
      console.error('请先在 miniprogram/config.js 里填入云开发环境 ID')
      return
    }
    // 全局只初始化一次。traceUser 打开后可在云开发控制台「运营分析-用户访问」
    // 看到访问记录，对俱乐部场景有用且不额外收费。
    wx.cloud.init({
      env: config.ENV_ID,
      traceUser: true,
    })
    this.globalData.cloudReady = true
  },
})
