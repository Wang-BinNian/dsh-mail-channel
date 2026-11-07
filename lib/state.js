/**
 * 插件自己的状态：绑定哪条会话、最近唤醒过哪些信、限流窗口、当日用量、最后一封发信。
 *
 * 只放 ASCII 值（会话 id、uid、ISO 时间），文件名也保持 ASCII —— 这套目录里的
 * 状态文件有被 PowerShell 5.1 按 ANSI 读的历史，别在这里重蹈覆辙。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { appendWithRotation } from './rotate.js'

export const STATE_FILE = 'plugin-state.json'
export const LOG_FILE = 'plugin.log'

/** plugin.log 的轮转参数；apply() 激活时用配置覆盖（setLogOptions）。 */
let logOptions = { maxBytes: 5 * 1024 * 1024, keep: 2 }

export function setLogOptions({ maxBytes, keep } = {}) {
  if (Number.isFinite(maxBytes) && maxBytes > 0) logOptions.maxBytes = maxBytes
  if (Number.isInteger(keep) && keep >= 1) logOptions.keep = keep
}

/** 本地日期 `YYYY-MM-DD`；预算和日志都按本地日切。 */
export function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function normalizeUsage(usage, today) {
  if (usage === null || typeof usage !== 'object' || usage.date !== today) {
    return { date: today, sends: 0, verifies: 0 }
  }
  return {
    date: today,
    sends: Number.isInteger(usage.sends) && usage.sends > 0 ? usage.sends : 0,
    verifies: Number.isInteger(usage.verifies) && usage.verifies > 0 ? usage.verifies : 0,
  }
}

/** 最后一封发信：mail_verify 用 messageId 精确定位（P1）。坏值一律当 null。 */
function normalizeLastSent(value) {
  if (value === null || typeof value !== 'object') return null
  const messageId = typeof value.messageId === 'string' ? value.messageId.trim() : ''
  if (messageId === '') return null
  return {
    messageId,
    subject: typeof value.subject === 'string' ? value.subject : '',
    to: typeof value.to === 'string' ? value.to : '',
    at: typeof value.at === 'string' ? value.at : '',
  }
}

export async function readState(mailDir) {
  const today = localDate()
  try {
    const raw = await readFile(join(mailDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return {
      channelSessionId: typeof parsed.channelSessionId === 'string' ? parsed.channelSessionId : '',
      wakes: Array.isArray(parsed.wakes) ? parsed.wakes.filter((iso) => typeof iso === 'string') : [],
      lastWakeAt: typeof parsed.lastWakeAt === 'string' ? parsed.lastWakeAt : '',
      lastSent: normalizeLastSent(parsed.lastSent),
      usage: normalizeUsage(parsed.usage, today),
    }
  } catch {
    return { channelSessionId: '', wakes: [], lastWakeAt: '', lastSent: null, usage: normalizeUsage(null, today) }
  }
}

export async function writeState(mailDir, state) {
  const body = JSON.stringify(
    {
      channelSessionId: state.channelSessionId ?? '',
      wakes: state.wakes ?? [],
      lastWakeAt: state.lastWakeAt ?? '',
      lastSent: normalizeLastSent(state.lastSent),
      usage: normalizeUsage(state.usage, localDate()),
    },
    null,
    2,
  )
  await writeFile(join(mailDir, STATE_FILE), body, 'utf8')
}

/** 记一次当日用量（sends / verifies）；跨日自动归零。 */
export async function bumpUsage(mailDir, key) {
  const state = await readState(mailDir)
  state.usage[key] = (state.usage[key] ?? 0) + 1
  await writeState(mailDir, state)
  return state.usage
}

/** 把留作证据的标记落盘（.woken）；失败不打断投递。 */
export async function markWoken(mailDir, uid) {
  try {
    await writeFile(join(mailDir, '待办', `mail-${uid}.woken`), new Date().toISOString(), 'utf8')
  } catch {
    /* 标记失败只影响去重证据，不影响唤醒本身 */
  }
}

export async function log(mailDir, message) {
  const line = `${new Date().toISOString()}  ${message}\n`
  try {
    // 超过阈值自动轮转（file → file.1 …），保留 logOptions.keep 份；失败降级为直接追加。
    await appendWithRotation(join(mailDir, LOG_FILE), line, logOptions)
  } catch {
    /* 日志写不进去就算了 */
  }
}

/** 只保留一小时内的唤醒时间戳，用于限流。 */
export function recentWakes(wakes, now = Date.now(), windowMs = 3_600_000) {
  return wakes.filter((iso) => {
    const stamp = Date.parse(iso)
    return Number.isFinite(stamp) && now - stamp < windowMs
  })
}
