'use strict'

/**
 * 云函数调用失败的翻译：`errMsg` → 用户能看懂的一句话。
 *
 * 这段逻辑的价值全在"认得出是哪一类问题"，而这几类问题的原文长得极像
 * （都是 `cloud.callFunction:fail ...`），所以必须逐条盯住。
 */

const assert = require('assert')
const apiError = require('../miniprogram/utils/api-error.js')

function eq (a, b, msg) { assert.strictEqual(a, b, msg) }
function ok (v, msg) { assert.ok(v, msg) }

// ---------------------------------------------------------------- 认得出来的几类

const missing = apiError.describeCallFailure('hat-signup',
  'cloud.callFunction:fail Error: errCode: -501000 | errMsg: FunctionName parameter could not be found')
eq(missing.code, 'FUNCTION_MISSING')
ok(missing.message.indexOf('hat-signup') >= 0, '要指出是哪个云函数没部署')
ok(missing.message.indexOf('上传部署') >= 0, '要给出下一步动作')

const timeout = apiError.describeCallFailure('hat-signup',
  'cloud.callFunction:fail Error: errCode: -504002 | errMsg: Invoking task timed out after 3 seconds')
eq(timeout.code, 'TIMEOUT')
ok(timeout.message.indexOf('超时') >= 0)
ok(timeout.message.indexOf('3 秒') >= 0, '要说明默认超时时间，才解释得清为什么会撞上')

const execFail = apiError.describeCallFailure('hat-match',
  'cloud.callFunction:fail Error: errCode: -504002 | errMsg: execute fail')
eq(execFail.code, 'EXEC_FAILED')
ok(execFail.message.indexOf('日志') >= 0, '要告诉人去哪里查详细原因')

const badEnv = apiError.describeCallFailure('hat-event',
  'cloud.callFunction:fail errCode: -501005 | errMsg: env not exists')
eq(badEnv.code, 'BAD_ENV')
ok(badEnv.message.indexOf('config.js') >= 0, '要指出配置文件位置')

const perm = apiError.describeCallFailure('hat-admin',
  'cloud.callFunction:fail errCode: -504003 | errMsg: unauthorized')
eq(perm.code, 'CLOUD_PERMISSION')

// 云存储的失败要单独说：导入名单就是先上传再下载，这一步坏了不能算成"网络异常"
const storage = apiError.describeCallFailure('hat-signup',
  'cloud.downloadFile:fail invalid fileID')
eq(storage.code, 'STORAGE_FAILED')

// ---------------------------------------------------------------- 认不出来的

eq(apiError.describeCallFailure('hat-signup', ''), null, '空 errMsg 不硬猜')
eq(apiError.describeCallFailure('hat-signup', 'something weird'), null)

// 兜底文案不能只是「操作失败」：要带上业务名、动作名和原文
const fallback = apiError.fallbackMessage('hat-signup', 'importSignups',
  'cloud.callFunction:fail Error: errCode: -1 | errMsg: something weird')
ok(fallback.indexOf('报名') >= 0, '要说是哪一块（报名）出的问题')
ok(fallback.indexOf('importSignups') >= 0, '要说是哪个动作')
ok(fallback.indexOf('something weird') >= 0, '原文要留着，便于搜索或截图')
ok(fallback.indexOf('cloud.callFunction:fail') < 0, '去掉了没意义的前缀')

ok(apiError.fallbackMessage('unknown-fn', 'x', '').indexOf('unknown-fn') >= 0,
  '没登记过的云函数名要原样带出来')

console.log('云函数报错翻译测试通过')
