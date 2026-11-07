/**
 * 用量预算 —— 把"今天登了几次、发了几封、回查了几次"摆到台面上。
 *
 * 邮件服务商的限制几乎都落在登录次数与发信量上，而不是收信轮询；
 * 所以这里只数这三样，超阈值就提醒，不靠感觉。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { localDate } from './state.js'

const WATCH_LOG_CAP = 2 * 1024 * 1024

/** 数今天守望建立了几次连接（每次"长连接就绪"= 一次登录）。 */
async function countLoginsToday(mailDir, today) {
  let raw
  try {
    raw = await readFile(join(mailDir, '守望.log'), 'utf8')
  } catch {
    return null
  }
  const text = raw.length > WATCH_LOG_CAP ? raw.slice(-WATCH_LOG_CAP) : raw
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(today) && line.includes('长连接就绪')) count += 1
  }
  return count
}

/**
 * @param {object} state - 插件状态（含 usage）
 * @param {object} config - 预算配置
 * @param {object} [overrides] - `loginsToday`：native 收信时由调用方给出真实登录数
 *   （收信长连接 + 每次回查各算一次），不再去数已退役的守望日志。
 */
export async function readBudget(mailDir, state, config, overrides = {}) {
  const today = localDate()
  const usage = state.usage?.date === today ? state.usage : { date: today, sends: 0, verifies: 0 }
  const loginsToday = Number.isInteger(overrides.loginsToday)
    ? overrides.loginsToday
    : await countLoginsToday(mailDir, today)
  const loginBudget = Math.max(1, Number(config.dailyLoginBudget) || 100)
  const sendBudget = Math.max(1, Number(config.dailySendBudget) || 50)

  const level = (() => {
    if (loginsToday !== null && loginsToday >= loginBudget) return 'over'
    if (usage.sends >= sendBudget) return 'over'
    if (loginsToday !== null && loginsToday >= loginBudget * 0.5) return 'warn'
    if (usage.sends >= sendBudget * 0.5) return 'warn'
    if (usage.verifies >= loginBudget) return 'warn'
    return 'ok'
  })()

  return {
    date: today,
    loginsToday,
    loginBudget,
    sendsToday: usage.sends,
    sendBudget,
    verifiesToday: usage.verifies,
    level,
    hint:
      level === 'ok'
        ? ''
        : '登录/发信接近或超过预算：先别重复回查，合并收发，必要时告诉主人。',
  }
}
