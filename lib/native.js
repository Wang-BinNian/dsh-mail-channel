/**
 * native 传输层 —— SMTP 发信、IMAP 收信与回查，全部在进程内完成。
 *
 * 为什么保留长连接 + NOOP：登录次数才是服务商的限流点。每次轮询重新
 * LOGIN 会到 96 次/天；一条长连接挂住只有个位数。
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ImapClient } from './imap.js'
import { buildMail, parseMail } from './mime.js'
import { senderAddress } from './security.js'
import { sendMail } from './smtp.js'
import { localDate } from './state.js'

const STATE_FILE = 'inbox-state.json'
const SPOOL = '收件箱'
const QUEUE = '待办'

/**
 * 凭据解析顺序（越靠前越优先）：
 *   1. 配置里的 user + password（自测/临时用）
 *   2. DSH 凭据服务（社区版的正路）：按名字取值，界面只看得到"已设置"
 *   3. 环境变量 MAIL_CHANNEL_USER / MAIL_CHANNEL_PASSWORD
 *   4. credentialFile（旧式凭据文件，用正则读 smtpUser / smtpPass）
 *
 * @param {object} config
 * @param {{secret?: (name: string) => Promise<string|undefined>}} [resolvers]
 */
export async function loadCredentials(config, resolvers = {}) {
  if (config.user && config.password) {
    return { user: config.user, pass: config.password, source: 'config' }
  }

  const passwordName = config.passwordCredential ?? 'MAIL_CHANNEL_PASSWORD'
  const userName = config.userCredential ?? 'MAIL_CHANNEL_USER'

  const storedPass = await fromSecret(passwordName, resolvers.secret)
  if (storedPass !== undefined) {
    const storedUser = config.user || (await fromSecret(userName, resolvers.secret))
    if (!storedUser) throw new Error(`密码找到了（${passwordName}），但账号没有：设置 ${userName} 或配置 user`)
    return { user: storedUser, pass: storedPass, source: 'credentials' }
  }

  const envPass = fromEnv(passwordName)
  if (envPass !== undefined) {
    const envUser = config.user || fromEnv(userName)
    if (!envUser) throw new Error(`环境变量里有 ${passwordName}，但缺 ${userName}`)
    return { user: envUser, pass: envPass, source: 'env' }
  }

  if (config.credentialFile) {
    const source = await readFile(config.credentialFile, 'utf8')
    const user = /smtpUser\s*=\s*'([^']+)'/.exec(source)?.[1]
    const pass = /smtpPass\s*=\s*'([^']+)'/.exec(source)?.[1]
    if (!user || !pass) throw new Error(`凭据文件里没找到 smtpUser / smtpPass：${config.credentialFile}`)
    return { user, pass, source: 'file' }
  }

  throw new Error(
    `没有可用凭据。任选其一：配置里给 user+password；把密码存进 DSH 凭据（${passwordName}）；` +
      `设环境变量 ${passwordName}；或指定 credentialFile。`,
  )
}

/** 凭据服务里按名字取值；服务不可用就当没设置。 */
async function fromSecret(name, secret) {
  if (typeof secret !== 'function') return undefined
  try {
    const value = await secret(name)
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function fromEnv(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function imapOptions(config, credentials) {
  return {
    host: config.imapHost ?? 'imap.qq.com',
    port: config.imapPort ?? 993,
    user: credentials.user,
    pass: credentials.pass,
    timeoutMs: config.connectTimeoutMs ?? 60_000,
  }
}

const MESSAGE_ID_SUFFIX = '@mail-channel'
const SENT_MAILBOX = '"Sent Messages"'
const PENDING_HINT =
  '发件箱同步通常 20–60 秒，稍后用同一个 messageId 重查（不会误判成 fail）；' +
  'QQ 会改写 Message-ID，插件用自定义头 X-Mail-Channel-Id + 主题/时间窗兜底匹配'

function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 规范化 Message-ID：去尖括号/空白、转小写。
 * 比较发件箱里那封和发信时记录的 id 用——QQ 可能改写大小写、折行或补空白。
 */
export function normalizeMessageId(value) {
  return String(value ?? '').replace(/[<>\s]/g, '').toLowerCase()
}

function generateMessageId() {
  return `${randomUUID()}${MESSAGE_ID_SUFFIX}`
}

/**
 * 组一封待发信（纯函数，便于离线测试）。
 * @returns {{message: Buffer, messageId: string}} messageId 是含尖括号的实际头部值
 */
export function buildOutgoing(config, { to, subject, text, html, attachments, messageId }) {
  // 调用方可能传带尖括号的 id，也可能传裸 id；统一成裸 id 再交给 buildMail（它会补一对尖括号）。
  const id = normalizeMessageId(messageId) || generateMessageId()
  const message = buildMail({
    from: config.selfAddress,
    fromName: config.fromName ?? '',
    to,
    subject,
    text,
    html,
    attachments,
    messageId: id,
    // 稳定定位用：QQ 等会改写 Message-ID，自定义头一般会保留。
    extraHeaders: { 'X-Mail-Channel-Id': id },
  })
  return { message, messageId: `<${id}>`, xMailChannelId: id }
}

/** 发一封信；返回 { ok, port, error, messageId }，messageId 含尖括号。 */
export async function sendNow(config, credentials, { to, subject, text, html, attachments, signal, messageId }) {
  const from = config.selfAddress
  const outgoing = buildOutgoing(config, { to, subject, text, html, attachments, messageId })
  const result = await sendMail({
    host: config.smtpHost ?? 'smtp.qq.com',
    port: config.smtpPort || undefined,
    user: credentials.user,
    pass: credentials.pass,
    from,
    to,
    message: outgoing.message,
    timeoutMs: config.sendTimeoutMs ?? 120_000,
    signal,
  })
  return { ...result, messageId: outgoing.messageId }
}

/** 一封信的解析结果是否就是期望的那封（规范化后精确相等，不做模糊匹配）。 */
export function matchesMessageId(parsed, messageId) {
  const expected = normalizeMessageId(messageId)
  if (expected === '') return true
  return normalizeMessageId(parsed?.messageId) === expected
}

/**
 * 纯函数：对发件箱里解析出的一封信跑三类检查，并报告 Message-ID 是否命中。
 * checks 的 label 保持 mail_verify 既有风格；ok 是 checks 全通过。
 */
export function matchSentMail(parsed, { messageId = '', to = [], attachments, contains = [] } = {}) {
  const mail = parsed ?? {}
  const checks = []
  if (to.length > 0) {
    checks.push({
      label: `收件人含 ${to.join('、')}`,
      ok: to.every((address) => String(mail.to ?? '').includes(address)),
    })
  }
  if (Number.isInteger(attachments)) {
    checks.push({ label: `附件数 = ${attachments}`, ok: (mail.attachments ?? []).length === attachments })
  }
  const body = `${mail.text ?? ''}\n${mail.html ?? ''}`
  for (const keyword of contains) {
    checks.push({ label: `正文含「${keyword}」`, ok: body.includes(keyword) })
  }
  return {
    ok: checks.every((check) => check.ok),
    messageIdMatched: matchesMessageId(mail, messageId),
    subject: mail.subject ?? '',
    to: mail.to ?? '',
    date: mail.date ?? '',
    attachments: (mail.attachments ?? []).map((item) => item.name),
    checks,
    inspected: checks.length === 0 ? '只查看，未校验' : undefined,
  }
}

function pendingResult(messageId) {
  return {
    ok: false,
    passed: false,
    matched: 'pending',
    pending: true,
    messageId,
    error: '发件箱里还没同步到这封信',
    hint: PENDING_HINT,
  }
}

/**
 * 已连上的 IMAP client 上执行回查（可注入假 client，离线测试用）。
 *
 * 定位顺序（Message-ID 在 QQ 上会被改写，所以不能只靠它）：
 *   1. `HEADER X-Mail-Channel-Id` —— 自家埋的稳定头；
 *   2. `HEADER Message-ID` —— 服务商不改写时最精确；
 *   3. 尾部 10 封扫描：自定义头/Message-ID 规范化相等，或"主题相同 + 发信时间 ±15 分钟"；
 *   4. 仍找不到 → pending（同步滞后），**不判 fail**。
 */
export async function verifyWithClient(
  client,
  config,
  { messageId = '', subject = '', sentAt = '', to = [], attachments, contains = [] } = {},
) {
  const wanted = String(messageId ?? '')
  const expected = normalizeMessageId(wanted)
  await client.select(config.sentMailbox ?? SENT_MAILBOX)
  const uids = await client.uidSearchAll()
  if (uids.length === 0) {
    return wanted === '' ? { ok: false, passed: false, matched: 'latest', error: '发件箱是空的' } : pendingResult(wanted)
  }

  let targetUid = null
  let parsed = null
  let matched = 'latest'

  if (wanted !== '') {
    matched = 'message-id'
    // 候选来源：两个 HEADER SEARCH 的命中 + 尾部 10 封。**不直接相信服务商的搜索结果**——
    // 有的服务器会忽略/宽松解释带尖括号的 SEARCH 值，返回一堆不相关的 UID；
    // 所以拿回来后逐封 fetch，用“身份谓词”再验一遍。
    const candidates = []
    const addCandidates = (hits) => {
      for (const uid of hits.slice(-3).reverse()) if (!candidates.includes(uid)) candidates.push(uid)
    }
    if (expected !== '') {
      try {
        addCandidates(await client.uidSearch(`HEADER X-Mail-Channel-Id ${quote(expected)}`))
      } catch {
        // 服务商不支持 HEADER SEARCH：继续往下退
      }
    }
    try {
      addCandidates(await client.uidSearch(`HEADER Message-ID ${quote(wanted)}`))
    } catch {
      // 同上
    }
    for (const uid of uids.slice(-10).reverse()) if (!candidates.includes(uid)) candidates.push(uid)

    const sentStamp = Date.parse(sentAt)
    const wantSubject = String(subject ?? '').trim()
    for (const uid of candidates) {
      const candidate = parseMail(await client.uidFetch(uid))
      const sameXHeader = expected !== '' && normalizeMessageId(candidate.xMailChannelId) === expected
      const sameMessageId = expected !== '' && normalizeMessageId(candidate.messageId) === expected
      const sameSubject = wantSubject !== '' && String(candidate.subject ?? '').trim() === wantSubject
      let closeInTime = true
      if (Number.isFinite(sentStamp)) {
        const received = Date.parse(candidate.date)
        closeInTime = Number.isFinite(received) && Math.abs(received - sentStamp) <= 15 * 60_000
      }
      if (!sameXHeader && !sameMessageId && !(sameSubject && closeInTime)) continue
      targetUid = uid
      parsed = candidate
      matched = sameXHeader || sameMessageId ? 'message-id' : 'subject-window'
      break
    }
    if (targetUid === null) return pendingResult(wanted)
  } else {
    targetUid = uids[uids.length - 1]
  }

  if (parsed === null) parsed = parseMail(await client.uidFetch(targetUid))
  const detail = matchSentMail(parsed, { messageId: wanted, to, attachments, contains })
  const actualMessageId = String(parsed.messageId ?? '')
  const result = {
    ok: detail.ok,
    passed: detail.ok,
    matched,
    messageId: wanted !== '' ? wanted : actualMessageId,
    subject: detail.subject,
    to: detail.to,
    date: detail.date,
    attachments: detail.attachments,
    checks: detail.checks,
    ...(detail.inspected === undefined ? {} : { inspected: detail.inspected }),
  }
  // 服务商改写 Message-ID 时让调用方看得见实际值（诊断用，不影响匹配结论）。
  if (wanted !== '' && normalizeMessageId(actualMessageId) !== normalizeMessageId(wanted)) {
    result.actualMessageId = actualMessageId
  }
  const actualXId = String(parsed.xMailChannelId ?? '')
  if (actualXId !== '') result.xMailChannelId = actualXId
  return result
}

/**
 * 按 Message-ID 回查发件箱；找不到时返回 pending（同步滞后），不误判 fail。
 * @param {object} [options.clientFactory] 测试注入：返回 IMAP client 的函数
 * @param {string} [options.subject] 最近一封的主题（QQ 改写 Message-ID 时的兜底匹配）
 * @param {string} [options.sentAt] 最近一封的发送时间（ISO；与 subject 配合做时间窗匹配）
 * @returns {Promise<object>} 见 notes/p1-spec.md §2.2
 */
export async function verifySent(
  config,
  credentials,
  { messageId = '', subject = '', sentAt = '', to = [], attachments, contains = [], clientFactory } = {},
) {
  const connect = typeof clientFactory === 'function' ? clientFactory : (options) => ImapClient.connect(options)
  const client = await connect(imapOptions(config, credentials))
  try {
    return await verifyWithClient(client, config, { messageId, subject, sentAt, to, attachments, contains })
  } finally {
    try {
      client.close()
    } catch {
      /* 关闭阶段的错误无所谓 */
    }
  }
}

/** 兼容旧用法：不指定 Message-ID 时回查发件箱最后一封。 */
export async function verifyLatest(config, credentials, { to = [], attachments, contains = [] } = {}) {
  return verifySent(config, credentials, { to, attachments, contains })
}

function safeName(name, fallback = 'part') {
  return String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || fallback
}

async function readBaseline(mailDir) {
  try {
    const raw = await readFile(join(mailDir, STATE_FILE), 'utf8')
    return Number(JSON.parse(raw.replace(/^\uFEFF/, '')).last_uid) || 0
  } catch {
    return 0
  }
}

async function writeBaseline(mailDir, uid) {
  await writeFile(join(mailDir, STATE_FILE), JSON.stringify({ last_uid: Number(uid) }, null, 2), 'utf8')
}

/** 把一封信落成守望同款 JSON，附件落到 收件箱\<uid>\。 */
export async function spoolMail(mailDir, uid, mail, { owners = [], receivedAt = new Date() } = {}) {
  await mkdir(join(mailDir, QUEUE), { recursive: true })
  const attachments = []
  for (const item of mail.attachments) {
    const name = safeName(item.name)
    const outDir = join(mailDir, SPOOL, String(uid))
    await mkdir(outDir, { recursive: true })
    const path = join(outDir, name)
    await writeFile(path, item.data)
    attachments.push({ name: item.name, type: item.type, bytes: item.bytes, path })
  }
  // 身份判定必须精确：From 头能伪造，子串匹配会让 `x@example.com.evil.com` 混进来。
  const fromAddress = senderAddress(mail.from)
  const record = {
    uid,
    from: mail.from,
    from_address: fromAddress,
    to: mail.to,
    subject: mail.subject,
    date: mail.date,
    is_owner: fromAddress !== '' && owners.some((address) => senderAddress(address) === fromAddress),
    text: mail.text,
    html: mail.html,
    attachments,
    body: (mail.text.trim() || stripHtml(mail.html)).trim(),
    received_at: formatLocal(receivedAt),
  }
  await writeFile(join(mailDir, QUEUE, `mail-${uid}.json`), JSON.stringify(record, null, 2), 'utf8')
  return record
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

function formatLocal(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 断线重连退避：30s 起、每次翻倍、封顶 reconnectMaxSeconds，±20% 抖动。
 * @param {number} failures 连续失败次数（从 1 开始）
 * @param {{reconnectBaseSeconds?:number, reconnectMaxSeconds?:number}} [config]
 * @param {() => number} [random] 测试注入，默认 Math.random
 */
export function reconnectDelayMs(failures, config = {}, random = Math.random) {
  const base = Math.max(1, Number(config.reconnectBaseSeconds) || 30)
  const cap = Math.max(base, Number(config.reconnectMaxSeconds) || 300)
  const count = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1
  const raw = Math.min(cap, base * 2 ** (count - 1)) * 1_000
  const jitter = 0.8 + random() * 0.4
  return Math.round(raw * jitter)
}

/**
 * 收信循环：一条长连接 + 定时 NOOP，断了重连。
 * 新信按 UID 升序取，落盘后回调；基线写 inbox-state.json（与守望兼容）。
 */
export class MailWatcher {
  #config
  #credentials
  #log
  #onMail
  #client = null
  #stopped = false
  #timer = null
  #baseline = 0
  /** 当日登录计数按本地日归零：预算看的是"今天"，不是进程生命周期。 */
  #loginDay = ''
  #loginsToday = 0
  #status = {
    alive: false,
    lastCheck: '',
    checksDone: 0,
    logins: 0,
    reconnects: 0,
    lastError: '',
    lastErrorAt: '',
    failures: 0,
  }

  constructor(config, credentials, { onMail, log }) {
    this.#config = config
    this.#credentials = credentials
    this.#onMail = onMail
    this.#log = log
    this.#baseline = 0
  }

  get baseline() {
    return this.#baseline
  }

  /** 暴露给 mail_inbox 的实时状态；不再依赖外部守望的心跳文件。 */
  get status() {
    return {
      alive: this.#status.alive,
      lastCheck: this.#status.lastCheck,
      checksDone: this.#status.checksDone,
      logins: this.#status.logins,
      loginsToday: this.#loginsToday,
      reconnects: this.#status.reconnects,
      lastError: this.#status.lastError,
      lastErrorAt: this.#status.lastErrorAt,
      failures: this.#status.failures,
      baseline: this.#baseline,
      mode: 'native long-connection',
    }
  }

  /** 记一次 LOGIN：跨本地午夜自动归零，同时保留进程内累计数用于诊断。 */
  #noteLogin() {
    const today = localDate()
    if (today !== this.#loginDay) {
      this.#loginDay = today
      this.#loginsToday = 0
    }
    this.#loginsToday += 1
    this.#status.logins += 1
  }

  async start() {
    this.#baseline = await readBaseline(this.#config.mailDir)
    if (this.#baseline === 0) {
      // 首次运行：把当前最大 UID 当基线，避免把整箱历史信当新信。
      this.#client = await this.#connect()
      const uids = await this.#client.uidSearchAll()
      this.#client.close()
      this.#client = null
      const top = uids.length > 0 ? uids[uids.length - 1] : 0
      this.#baseline = top
      await writeBaseline(this.#config.mailDir, top)
      await this.#log(`收信基线从 0 重置到 UID ${top}（历史信不处理）`)
    }
    this.#schedule(0)
  }

  #schedule(delayMs) {
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      void this.#tick()
    }, delayMs)
  }

  async #connect() {
    const client = await ImapClient.connect(imapOptions(this.#config, this.#credentials))
    await client.select(this.#config.inboxMailbox ?? 'INBOX')
    this.#noteLogin()
    this.#status.alive = true
    return client
  }

  async #tick() {
    if (this.#stopped) return
    const intervalMs = Math.max(5, Number(this.#config.imapPollSeconds) || 15) * 1_000
    try {
      if (this.#client === null) {
        this.#client = await this.#connect()
        await this.#log('收信长连接就绪')
      }
      await this.#client.noop()
      this.#status.checksDone += 1
      this.#status.lastCheck = formatLocal(new Date())
      this.#status.alive = true
      const uids = await this.#client.uidSearchAll()
      const fresh = uids.filter((uid) => uid > this.#baseline)
      if (fresh.length > 0) {
        const limit = Math.max(1, Number(this.#config.maxPerRound) || 5)
        for (const uid of fresh.slice(0, limit)) {
          const raw = await this.#client.uidFetch(uid)
          const mail = parseMail(raw)
          await spoolMail(this.#config.mailDir, uid, mail, { owners: this.#ownerList() })
          this.#baseline = Math.max(this.#baseline, uid)
          await this.#onMail({ uid, mail })
        }
        await writeBaseline(this.#config.mailDir, this.#baseline)
      }
      // 一整轮成功（NOOP + 搜索都过了）才清错误态；lastErrorAt 保留，供诊断"最近一次出错过"。
      if (this.#status.failures !== 0 || this.#status.lastError !== '') {
        await this.#log(`收信连接已恢复（连续失败 ${this.#status.failures} 次）`)
      }
      this.#status.lastError = ''
      this.#status.failures = 0
      this.#schedule(intervalMs)
    } catch (error) {
      this.#client?.close()
      this.#client = null
      this.#status.alive = false
      this.#status.reconnects += 1
      this.#status.failures += 1
      this.#status.lastError = `${error.name}: ${error.message}`
      this.#status.lastErrorAt = new Date().toISOString()
      const delayMs = reconnectDelayMs(this.#status.failures, this.#config)
      await this.#log(
        `收信异常（连续失败 ${this.#status.failures} 次，${Math.round(delayMs / 1000)}s 后重连）：${this.#status.lastError}`,
      )
      this.#schedule(delayMs)
    }
  }

  #ownerList() {
    return [this.#config.ownerAddress, ...(this.#config.ownerAliases ?? [])].filter(Boolean)
  }

  stop() {
    this.#stopped = true
    this.#status.alive = false
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#client?.close()
    this.#client = null
  }
}

/** 手动拉一次未读（不做长连接）：给 mail_inbox 的 refresh 用。 */
export async function fetchNewOnce(config, credentials, { limit = 5 } = {}) {
  const client = await ImapClient.connect(imapOptions(config, credentials))
  try {
    await client.select(config.inboxMailbox ?? 'INBOX')
    const baseline = await readBaseline(config.mailDir)
    const uids = await client.uidSearchAll()
    const fresh = uids.filter((uid) => uid > baseline).slice(0, limit)
    const spooled = []
    for (const uid of fresh) {
      const mail = parseMail(await client.uidFetch(uid))
      await spoolMail(config.mailDir, uid, mail, {
        owners: [config.ownerAddress, ...(config.ownerAliases ?? [])].filter(Boolean),
      })
      spooled.push(uid)
    }
    if (spooled.length > 0) await writeBaseline(config.mailDir, spooled[spooled.length - 1])
    return spooled
  } finally {
    client.close()
  }
}
