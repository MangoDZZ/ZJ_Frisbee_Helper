'use strict'

/**
 * 把云函数调用的失败翻译成一句用户能看懂的话。
 *
 * 为什么单独一个模块：这段逻辑全是字符串规则，不碰 wx、不碰网络，所以能离线测。
 * 放在 api.js 里的话，想验证"超时会被认出来"就得起一个假的 wx 环境，不值当。
 *
 * 为什么需要翻译：`errMsg` 里的几种失败长得都很像，但处理方式完全不同——
 * 没部署要去开发者工具上传，超时要缩小数据量或调大超时时间，权限没开要去控制台改配置。
 * 以前一律说「网络异常，请重试」，看到这句话的人只能反复点，什么也查不出来。
 */

/** 云函数名 → 业务名，报错时让用户知道是哪一块出的问题。 */
const MODULE_LABEL = {
  'hat-event': '活动',
  'hat-signup': '报名',
  'hat-team': '赛事',
  'hat-match': '比赛',
  'hat-admin': '管理员',
}

/**
 * @param {string} name    云函数名
 * @param {string} errMsg  失败原文（通常是 wx.cloud.callFunction 的 errMsg）
 * @returns {{message: string, code: string}|null} 认不出来时返回 null，交给调用方兜底
 */
function describeCallFailure (name, errMsg) {
  const msg = String(errMsg || '')

  if (/FunctionName.*not\s*found|FunctionNotExist|RESOURCE_NOT_FOUND|-501000/i.test(msg)) {
    return {
      code: 'FUNCTION_MISSING',
      message: '云函数 ' + name + ' 还没部署：请在开发者工具里右键 cloudfunctions/' + name + ' 上传部署',
    }
  }
  if (/timed?\s*out|timeout|Invoking task timed/i.test(msg)) {
    return {
      code: 'TIMEOUT',
      message: '云函数 ' + name + ' 执行超时（默认 3 秒）。' +
        '数据量大时请分批操作，或在云开发控制台把该函数的超时时间调大',
    }
  }
  if (/env.*not\s*exist|invalid env|-501005/i.test(msg)) {
    return {
      code: 'BAD_ENV',
      message: '云环境不可用：请检查 miniprogram/config.js 里的环境 ID 是否和云开发控制台一致',
    }
  }
  if (/-504002|execute\s*fail/i.test(msg)) {
    return {
      code: 'EXEC_FAILED',
      message: '云函数 ' + name + ' 执行失败，常见原因是依赖没装完或内存不足。' +
        '详细信息看云开发控制台「云函数 → ' + name + ' → 日志」',
    }
  }
  if (/permission|unauthorized|-504003|-501001/i.test(msg)) {
    return {
      code: 'CLOUD_PERMISSION',
      message: '没有调用云函数 ' + name + ' 的权限：请检查云开发控制台里的权限配置',
    }
  }
  if (/downloadFile|uploadFile/i.test(msg)) {
    return { code: 'STORAGE_FAILED', message: '云存储读写失败，请重试' }
  }
  return null
}

/**
 * 认不出来的失败也别只说「操作失败」：带上业务名、动作名和原文，
 * 至少能直接截图给我们，或者拿去搜。
 */
function fallbackMessage (name, action, errMsg) {
  const raw = String(errMsg || '').replace(/^cloud\.callFunction:fail\s*/i, '').trim()
  const label = MODULE_LABEL[name] || name
  return '调用' + label + '云函数失败（' + action + '）：' + (raw || '没有返回原因')
}

module.exports = {
  MODULE_LABEL: MODULE_LABEL,
  describeCallFailure: describeCallFailure,
  fallbackMessage: fallbackMessage,
}
