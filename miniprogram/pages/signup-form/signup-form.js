'use strict'

const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

const LEVEL_OPTIONS = [
  { value: 1, label: '新手', desc: '刚接触，规则还在熟悉' },
  { value: 2, label: '入门', desc: '打过几次，能参与对抗' },
  { value: 3, label: '一般', desc: '常打，基本传接稳定' },
  { value: 4, label: '熟练', desc: '能带节奏，战术意识好' },
  { value: 5, label: '高手', desc: '队里的核心' },
]

Page({
  data: {
    eventId: '',
    eventName: '',
    editing: false,
    levelOptions: LEVEL_OPTIONS,
    form: { name: '', gender: '', selfLevel: 0, phone: '', remark: '' },
    submitting: false,
  },

  onLoad: function (q) {
    const that = this
    this.setData({ eventId: q.eventId || '' })
    // 已报过名就预填，让这个页面同时承担"修改信息"。
    api.event('detail', { eventId: q.eventId }, { loading: '加载中' })
      .then(function (d) {
        const s = d.mySignup
        that.setData({
          eventName: d.event.name,
          editing: !!s,
          form: s ? {
            name: s.name,
            gender: s.gender,
            selfLevel: s.selfLevel,
            phone: s.phone || '',
            remark: s.remark || '',
          } : that.data.form,
        })
        wx.setNavigationBarTitle({ title: s ? '修改报名信息' : '报名' })
      })
      .catch(function () {})
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch['form.' + field] = e.detail.value
    this.setData(patch)
  },

  pickGender: function (e) {
    this.setData({ 'form.gender': e.currentTarget.dataset.value })
  },

  pickLevel: function (e) {
    this.setData({ 'form.selfLevel': Number(e.currentTarget.dataset.value) })
  },

  submit: function () {
    const f = this.data.form
    // 前端先挡一遍，少一次往返；云函数里同样会校验，不依赖前端。
    if (!f.name.trim()) return warn('请填写姓名或昵称')
    if (!f.gender) return warn('请选择性别')
    if (!f.selfLevel) return warn('请选择你的水平')
    if (f.phone && !/^[0-9+\-\s]{6,20}$/.test(f.phone.trim())) return warn('手机号格式不对')

    const that = this
    this.setData({ submitting: true })
    api.signup('submit', {
      eventId: this.data.eventId,
      name: f.name,
      gender: f.gender,
      selfLevel: f.selfLevel,
      phone: f.phone,
      remark: f.remark,
    }, { loading: '提交中' })
      .then(function (d) {
        wx.showToast({ title: d.updated ? '信息已更新' : '报名成功', icon: 'success' })
        setTimeout(function () { wx.navigateBack() }, 700)
      })
      .catch(function () {
        that.setData({ submitting: false })
      })
  },
})

function warn (msg) {
  wx.showToast({ title: msg, icon: 'none' })
}
