/**
 * 队列与状态读取 —— 只读磁盘，不碰网络。
 *
 * 判据沿用邮件系统手册：`待办\` 里有 `mail-<uid>.json`、没有同名 `.done`，就是
 * "信已到手、还没人处理"。插件不维护第二套队列，避免和守望/兜底互相踩脚。
 */
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAIL_JSON = /^mail-(\d+)\.json$/

/** 把正文压成一行预览，避免把整封信当摘要塞进上下文。 */
export function excerpt(text, limit = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * 扫一遍待办目录。
 * @returns {Promise<Array<{uid:number,path:string,done:boolean,woken:boolean,mtime:number,record:object|null}>>}
 */
export async function scanQueue(mailDir) {
  const dir = join(mailDir, '待办')
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const mails = []
  for (const name of names) {
    const matched = MAIL_JSON.exec(name)
    if (matched === null) continue
    const uid = Number(matched[1])
    const jsonPath = join(dir, name)
    let record = null
    try {
      record = JSON.parse(await readFile(jsonPath, 'utf8'))
    } catch {
      // 守望正在写（非原子写）时会读到半个 JSON；下一轮自然补上。
      continue
    }
    let mtime = 0
    try {
      mtime = (await stat(jsonPath)).mtimeMs
    } catch {
      /* 读不到时间就当很旧，不会影响是否处理 */
    }
    mails.push({
      uid,
      path: jsonPath,
      done: existsSync(join(dir, `mail-${uid}.done`)),
      woken: existsSync(join(dir, `mail-${uid}.woken`)),
      mtime,
      record,
    })
  }
  return mails.sort((a, b) => a.uid - b.uid)
}

/** 队列条目 → 给模型看的摘要（不含正文全文）。 */
export function summarize(mail) {
  const record = mail.record ?? {}
  const attachments = Array.isArray(record.attachments) ? record.attachments : []
  return {
    uid: mail.uid,
    subject: record.subject || '(无主题)',
    from: record.from || '',
    date: record.date || '',
    receivedAt: record.received_at || '',
    isOwner: record.is_owner === true,
    attachments: attachments.map((item) => item.name),
    preview: excerpt(record.body || record.text || ''),
    done: mail.done,
    woken: mail.woken,
  }
}

/** 守望心跳 —— 只判新鲜度，不去猜进程名（手册里的教训）。 */
export async function readChannel(mailDir, staleMinutes) {
  const file = join(mailDir, '守望-state.json')
  let state
  try {
    const raw = await readFile(file, 'utf8')
    state = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return { alive: false, reason: '没有读到守望心跳文件（守望可能从未启动）', file }
  }
  const lastCheck = String(state.last_check ?? '')
  const stamp = Date.parse(lastCheck.replace(' ', 'T'))
  if (Number.isNaN(stamp)) {
    return { alive: false, reason: '心跳文件里的 last_check 无法解析', file, lastCheck }
  }
  const ageMinutes = Math.max(0, Math.round((Date.now() - stamp) / 6000) / 10)
  return {
    alive: ageMinutes <= staleMinutes,
    ageMinutes,
    staleMinutes,
    lastCheck,
    checksDone: state.checks_done ?? null,
    pid: state.pid ?? null,
    baselineUid: state.baseline_uid ?? null,
    mailboxTopUid: state.mailbox_top_uid ?? null,
    reconnects: state.reconnects ?? null,
    file,
  }
}
