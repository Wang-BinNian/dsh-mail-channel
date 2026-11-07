/**
 * 本地往来检索 —— 只读磁盘，不连邮箱。
 *
 * 来信来自 `待办\mail-*.json`（守望落盘的归档，已处理的也在），
 * 去信来自 `send.log`（发信.py 每条成功都会写一行）。
 */
import { join } from 'node:path'

import { excerpt, scanQueue } from './queue.js'
import { readRotated } from './rotate.js'

const SEND_LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+OK: 发信 -> (.+?)\s*（主题：(.*?)，端口 (\d+)，附件 (\d+)）/

function localMs(text) {
  const stamp = Date.parse(String(text ?? '').replace(' ', 'T'))
  return Number.isFinite(stamp) ? stamp : 0
}

function parseBound(value, endOfDay) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const stamp = Date.parse(`${text}T${endOfDay ? '23:59:59' : '00:00:00'}`)
    return Number.isFinite(stamp) ? stamp : undefined
  }
  const stamp = Date.parse(text)
  return Number.isFinite(stamp) ? stamp : undefined
}

function inboundEntry(mail) {
  const record = mail.record ?? {}
  const timestamp = localMs(record.received_at) || localMs(record.date)
  return {
    direction: 'in',
    uid: mail.uid,
    timestamp,
    time: record.received_at || record.date || '',
    subject: record.subject || '(无主题)',
    from: record.from || '',
    to: record.to || '',
    attachments: (record.attachments ?? []).map((item) => item.name),
    handled: mail.done,
    snippet: excerpt(record.body || record.text || '', 140),
  }
}

async function outboundEntries(mailDir, keep = 2) {
  let raw
  try {
    // send.log 会被轮转：按旧→新读所有分片，历史发信不会因为轮转就从检索里消失。
    raw = await readRotated(join(mailDir, 'send.log'), { keep })
  } catch {
    return []
  }
  const entries = []
  for (const line of raw.split(/\r?\n/)) {
    const matched = SEND_LINE.exec(line)
    if (matched === null) continue
    const [, when, to, subject, port, attachments] = matched
    entries.push({
      direction: 'out',
      timestamp: localMs(when),
      time: when,
      subject: subject || '(无主题)',
      from: '',
      to,
      attachments: Number(attachments) > 0 ? [`附件 ${attachments} 个`] : [],
      handled: true,
      snippet: `端口 ${port}`,
    })
  }
  return entries
}

/**
 * 查往来邮件。
 * @param {object} filters - from/subject/contains/since/until/limit/方向
 * @returns {Promise<{total:number, matched:number, items:object[]}>}
 */
export async function searchHistory(mailDir, filters = {}) {
  const wantInbound = filters.inbound !== false
  const wantOutbound = filters.outbound !== false
  const items = []

  if (wantInbound) {
    for (const mail of await scanQueue(mailDir)) items.push(inboundEntry(mail))
  }
  if (wantOutbound) {
    items.push(...(await outboundEntries(mailDir, Number.isInteger(filters.logKeep) ? filters.logKeep : 2)))
  }

  const since = parseBound(filters.since, false)
  const until = parseBound(filters.until, true)
  const from = String(filters.from ?? '').trim().toLowerCase()
  const subject = String(filters.subject ?? '').trim().toLowerCase()
  const contains = String(filters.contains ?? '').trim().toLowerCase()

  const matched = items.filter((item) => {
    if (since !== undefined && (item.timestamp === 0 || item.timestamp < since)) return false
    if (until !== undefined && (item.timestamp === 0 || item.timestamp > until)) return false
    if (from.length > 0) {
      const haystack = `${item.from} ${item.to}`.toLowerCase()
      if (!haystack.includes(from)) return false
    }
    if (subject.length > 0 && !item.subject.toLowerCase().includes(subject)) return false
    if (contains.length > 0) {
      const haystack = `${item.subject} ${item.snippet}`.toLowerCase()
      if (!haystack.includes(contains)) return false
    }
    return true
  })

  matched.sort((a, b) => b.timestamp - a.timestamp)
  const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? Math.min(filters.limit, 100) : 20
  return {
    total: items.length,
    matched: matched.length,
    items: matched.slice(0, limit),
  }
}
