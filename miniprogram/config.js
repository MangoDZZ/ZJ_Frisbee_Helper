'use strict'

/**
 * 唯一需要你手填的地方。
 *
 * ENV_ID：云开发环境 ID。务必用微信开发者工具内「云开发」控制台顶部显示的那个 ID，
 * 不是网页版控制台的。必须显式写死——wx.cloud.init 不传 env 会连到"默认环境"
 * （第一个创建的那个），多环境时这是反复踩的坑。
 */
const ENV_ID = 'cloud1-d2gsqw6y62291250e'

/**
 * 当前小程序版本号。后台管理页会显示它，用来回答"线上跑的是哪一版"——
 * 提交前记得跟着 plan.md 的版本一起改。
 */
const VERSION = 'v1.1.4'

module.exports = {
  ENV_ID: ENV_ID,
  VERSION: VERSION,
  isConfigured: function () {
    return typeof ENV_ID === 'string' && ENV_ID.indexOf('TODO_') !== 0
  },
}
