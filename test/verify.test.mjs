/**
 * mail_verify 精确回查（P1-1）+ 收信重连退避（P1-3）单测 —— 全部离线。
 *
 *   node test/verify.test.mjs
 *
 * 契约见 notes/p1-spec.md §2.1 / §2.2 / §5：
 *   - uidSearch 解析 * SEARCH 行并升序返回；
 *   - verifySent 按 Message-ID 精确找，找不到返回 pending 而不是误判 fail；
 *   - Message-ID 规范化（去尖括号/空白、大小写不敏感）匹配；
 *   - 无 messageId 退化为最后一封（matched:'latest'）；
 *   - 重连退避 30s→60→120→240→300s 封顶、±20% 抖动。
 *
 * 不连网：IMAP 全部用假 socket / 假 client 注入。
 */
import { EventEmitter } from 'node:events'

import { ImapClient } from '../lib/imap.js'
import { buildMail, parseMail } from '../lib/mime.js'
import {
  MailWatcher,
  buildOutgoing,
  matchSentMail,
  matchesMessageId,
  normalizeMessageId,
  reconnectDelayMs,
  verifySent,
  verifyWithClient,
} from '../lib/native.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  [OK] ${label}`)
  else {
    failures += 1
    console.log(`  [!!] ${label} ${detail}`)
  }
}

const OWNER = 'owner@example.com'
const SENT = '"Sent Messages"'
const CONFIG = { selfAddress: 'agent@example.com', fromName: 'DeepSeek', sentMailbox: SENT }

/** 造一封"发件箱里的原信"（走真实 buildMail → parseMail 往返）。 */
function rawMail({ messageId, to = [OWNER], subject = '测试主题', text = '正文：残差已收敛。', attachments = [], extraHeaders = {}, date }) {
  const options = { from: 'agent@example.com', fromName: 'DeepSeek', to, subject, text, attachments, extraHeaders }
  if (messageId !== undefined) options.messageId = normalizeMessageId(messageId)
  if (date !== undefined) options.date = new Date(date)
  return buildMail(options)
}

/** 假 IMAP client：uidSearch 结果可控、可抛错；记录调用顺序。 */
function fakeClient({ mails = [], searchHits = [], searchError = null } = {}) {
  const sorted = [...mails].sort((left, right) => left.uid - right.uid)
  const byUid = new Map(sorted.map((mail) => [mail.uid, mail.raw]))
  const calls = { select: [], search: [], searchAll: 0, fetch: [], close: 0 }
  return {
    calls,
    async select(mailbox) {
      calls.select.push(mailbox)
      return { exists: sorted.length }
    },
    async uidSearch(criteria) {
      calls.search.push(criteria)
      if (searchError !== null) throw searchError
      return [...searchHits].sort((left, right) => left - right)
    },
    async uidSearchAll() {
      calls.searchAll += 1
      return sorted.map((mail) => mail.uid)
    },
    async uidFetch(uid) {
      calls.fetch.push(uid)
      const raw = byUid.get(uid)
      if (raw === undefined) throw new Error(`假 client 没有 uid=${uid}`)
      return raw
    },
    close() {
      calls.close += 1
    },
  }
}

console.log('\n== Message-ID 规范化 ==')
check('去尖括号与空白、小写', normalizeMessageId(' <ABC-123@mail-channel> ') === 'abc-123@mail-channel')
check(
  '两个不同写法规范化后相等',
  normalizeMessageId('<ABC@Mail-Channel>') === normalizeMessageId('abc@mail-channel'),
)
check('不同 id 不命中', matchesMessageId({ messageId: '<aaa@mail-channel>' }, '<bbb@mail-channel>') === false)
check('QQ 改写大小写/括号后仍命中', matchesMessageId({ messageId: 'ABC@mail-channel' }, '<abc@mail-channel>') === true)
check('无期望 messageId 时视为命中', matchesMessageId({ messageId: '<whatever@mail-channel>' }, '') === true)
check('空 messageId 对空值命中', matchesMessageId({ messageId: '' }, '') === true)

console.log('\n== 发信侧 Message-ID 只包一对尖括号 ==')
const outgoingFixed = buildOutgoing(CONFIG, {
  to: [OWNER],
  subject: '主题',
  text: '正文',
  messageId: '<fixed-id@mail-channel>',
})
check('返回值含尖括号', outgoingFixed.messageId === '<fixed-id@mail-channel>', outgoingFixed.messageId)
check('头部与返回值一致', parseMail(outgoingFixed.message).messageId === outgoingFixed.messageId)
check('双尖括号不会出现', !outgoingFixed.message.toString('latin1').includes('<<'))

const outgoingBare = buildOutgoing(CONFIG, {
  to: [OWNER],
  subject: '主题',
  text: '正文',
  messageId: 'bare-id@mail-channel',
})
check('裸 id 也补成一对尖括号', outgoingBare.messageId === '<bare-id@mail-channel>', outgoingBare.messageId)

const outgoingAuto = buildOutgoing(CONFIG, { to: [OWNER], subject: '主题', text: '正文' })
check('缺省自动生成 @mail-channel id', /^<[0-9a-f-]{36}@mail-channel>$/.test(outgoingAuto.messageId), outgoingAuto.messageId)
check('自动生成的 id 写进了头部', parseMail(outgoingAuto.message).messageId === outgoingAuto.messageId)

console.log('\n== matchSentMail 三类检查（纯函数） ==')
const parsedTarget = parseMail(
  rawMail({ messageId: '<target@mail-channel>', attachments: [{ name: '图.png', data: Buffer.from('x') }] }),
)
const goodChecks = matchSentMail(parsedTarget, {
  messageId: '<target@mail-channel>',
  to: ['owner@example.com'],
  attachments: 1,
  contains: ['残差'],
})
check('全通过 → ok', goodChecks.ok === true)
check('Message-ID 命中标记', goodChecks.messageIdMatched === true)
check('label 风格：收件人含', goodChecks.checks[0]?.label === '收件人含 owner@example.com', goodChecks.checks[0]?.label)
check('label 风格：附件数 = 1', goodChecks.checks[1]?.label === '附件数 = 1', goodChecks.checks[1]?.label)
check('label 风格：正文含「残差」', goodChecks.checks[2]?.label === '正文含「残差」', goodChecks.checks[2]?.label)

const badChecks = matchSentMail(parsedTarget, {
  to: ['nobody@example.com'],
  attachments: 2,
  contains: ['不存在的词'],
})
check('任一项不符 → ok=false', badChecks.ok === false)
check('三项都标记失败', badChecks.checks.length === 3 && badChecks.checks.every((item) => item.ok === false))

const emptyChecks = matchSentMail(parsedTarget, {})
check(
  '无检查项 → ok=true 且提示只看未校验',
  emptyChecks.ok === true && emptyChecks.checks.length === 0 && emptyChecks.inspected === '只查看，未校验',
)

console.log('\n== verifyWithClient：Message-ID 命中 ==')
const otherRaw = rawMail({ messageId: '<other@mail-channel>', subject: '上一封' })
const targetRaw = rawMail({ messageId: '<target-2@mail-channel>', subject: '目标信' })
const hitClient = fakeClient({
  mails: [
    { uid: 10, raw: otherRaw },
    { uid: 11, raw: targetRaw },
  ],
  searchHits: [11],
})
const hit = await verifyWithClient(hitClient, CONFIG, {
  messageId: '<target-2@mail-channel>',
  to: [OWNER],
  contains: ['残差'],
})
check('命中 → ok', hit.ok === true)
check('matched=message-id', hit.matched === 'message-id')
check('SELECT 的是发件箱', hitClient.calls.select[0] === SENT, JSON.stringify(hitClient.calls.select))
check(
  '先搜自定义头，再搜 Message-ID（搜索引擎只提供候选）',
  hitClient.calls.search[0] === 'HEADER X-Mail-Channel-Id "target-2@mail-channel"' &&
    hitClient.calls.search[1] === 'HEADER Message-ID "<target-2@mail-channel>"',
  JSON.stringify(hitClient.calls.search),
)
check('只 FETCH 命中的那封', JSON.stringify(hitClient.calls.fetch) === '[11]', JSON.stringify(hitClient.calls.fetch))
check('返回主题/收件人/附件/检查项', hit.subject === '目标信' && hit.to.includes(OWNER) && hit.attachments.length === 0)

console.log('\n== verifyWithClient：SEARCH 为空 → 尾部扫描找得到 ==')
const tailClient = fakeClient({
  mails: [
    { uid: 4, raw: rawMail({ messageId: '<fourth@mail-channel>', subject: '第四封' }) },
    { uid: 5, raw: rawMail({ messageId: '<tail-target@mail-channel>', subject: '尾部目标' }) },
    { uid: 6, raw: rawMail({ messageId: '<sixth@mail-channel>', subject: '第六封' }) },
  ],
  searchHits: [],
})
const tailHit = await verifyWithClient(tailClient, CONFIG, { messageId: '<tail-target@mail-channel>' })
check('SEARCH 空但尾部扫到 → ok', tailHit.ok === true && tailHit.matched === 'message-id')
check('扫描顺序从最新往回', JSON.stringify(tailClient.calls.fetch) === '[6,5]', JSON.stringify(tailClient.calls.fetch))

console.log('\n== verifyWithClient：SEARCH 抛错 → 回退尾部扫描 ==')
let searchedErrorThrew = false
let errorFallback = null
try {
  errorFallback = await verifyWithClient(
    fakeClient({
      mails: [{ uid: 7, raw: rawMail({ messageId: '<error-target@mail-channel>', subject: '回退目标' }) }],
      searchError: new Error('IMAP BAD：Unknown search key'),
    }),
    CONFIG,
    { messageId: '<error-target@mail-channel>' },
  )
} catch {
  searchedErrorThrew = true
}
check(
  'SEARCH 抛错不冒泡且回退命中',
  searchedErrorThrew === false && errorFallback?.ok === true && errorFallback?.matched === 'message-id',
)

console.log('\n== verifyWithClient：找不到 → pending（不误判 fail） ==')
const missClient = fakeClient({
  mails: [
    { uid: 20, raw: rawMail({ messageId: '<a@mail-channel>' }) },
    { uid: 21, raw: rawMail({ messageId: '<b@mail-channel>' }) },
  ],
  searchHits: [],
})
const missing = await verifyWithClient(missClient, CONFIG, { messageId: '<not-synced-yet@mail-channel>' })
check('pending=true', missing.pending === true)
check('ok=false 但不是 fail 的检查结论', missing.ok === false && missing.passed === false)
check('matched=pending', missing.matched === 'pending')
check('error 说明还没同步', String(missing.error).includes('还没同步'), missing.error)
check('hint 提示复用同一个 messageId 重查', String(missing.hint).includes('messageId'), missing.hint)
check('pending 不带 checks（不是校验失败）', missing.checks === undefined && missing.subject === undefined)

console.log('\n== verifyWithClient：QQ 改写 Message-ID（自定义头兜底） ==')
const rewrittenRaw = rawMail({
  messageId: '<tencent_rewritten@example.com>',
  subject: '回信：已收到',
  extraHeaders: { 'X-Mail-Channel-Id': 'orig-id-123@mail-channel' },
})
const rewriteClient = fakeClient({ mails: [{ uid: 60, raw: rewrittenRaw }], searchHits: [] })
const rewritten = await verifyWithClient(rewriteClient, CONFIG, {
  messageId: '<orig-id-123@mail-channel>',
  to: [OWNER],
})
check('QQ 改写后靠自定义头仍命中', rewritten.ok === true && rewritten.matched === 'message-id', JSON.stringify(rewritten.matched))
check('返回实际被改写的 Message-ID', rewritten.actualMessageId === '<tencent_rewritten@example.com>', rewritten.actualMessageId)
check('返回自定义头值', rewritten.xMailChannelId === 'orig-id-123@mail-channel', rewritten.xMailChannelId)

console.log('\n== verifyWithClient：自定义头也被丢时，主题+时间窗兜底 ==')
const windowRaw = rawMail({
  messageId: '<tencent_window@example.com>',
  subject: '邮件任务完成通知',
  date: '2026-11-07T13:11:35.000Z',
})
const windowClient = fakeClient({ mails: [{ uid: 61, raw: windowRaw }], searchHits: [] })
const windowHit = await verifyWithClient(windowClient, CONFIG, {
  messageId: '<orig-window@mail-channel>',
  subject: '邮件任务完成通知',
  sentAt: '2026-11-07T13:11:37.000Z',
  to: [OWNER],
})
check('主题+时间窗兜底命中', windowHit.ok === true && windowHit.matched === 'subject-window', JSON.stringify(windowHit.matched))

const farRaw = rawMail({
  messageId: '<tencent_far@example.com>',
  subject: '同一主题但很久以前',
  date: '2026-11-01T00:00:00.000Z',
})
const farClient = fakeClient({ mails: [{ uid: 62, raw: farRaw }], searchHits: [] })
const farMiss = await verifyWithClient(farClient, CONFIG, {
  messageId: '<orig-far@mail-channel>',
  subject: '同一主题但很久以前',
  sentAt: '2026-11-07T13:11:37.000Z',
})
check('主题相同但超出时间窗 → pending', farMiss.pending === true && farMiss.matched === 'pending', JSON.stringify(farMiss.matched))

console.log('\n== buildOutgoing：去信带 X-Mail-Channel-Id ==')
const built = buildOutgoing(CONFIG, { to: [OWNER], subject: '带自定义头', text: 'x', messageId: '<out-id@mail-channel>' })
const builtParsed = parseMail(built.message)
check('出站信 Message-ID 正常', built.messageId === '<out-id@mail-channel>', built.messageId)
check('出站信带 X-Mail-Channel-Id', builtParsed.xMailChannelId === 'out-id@mail-channel', builtParsed.xMailChannelId)
check('返回 xMailChannelId', built.xMailChannelId === 'out-id@mail-channel')

console.log('\n== verifyWithClient：无 messageId → 退化最后一封 ==')
const latestRaw = rawMail({ messageId: '<latest@mail-channel>', subject: '最新一封' })
const latestClient = fakeClient({
  mails: [
    { uid: 30, raw: rawMail({ messageId: '<older@mail-channel>', subject: '旧信' }) },
    { uid: 31, raw: latestRaw },
  ],
})
const latest = await verifyWithClient(latestClient, CONFIG, { to: [OWNER] })
check('matched=latest', latest.matched === 'latest')
check('ok=true', latest.ok === true && latest.passed === true)
check('只 FETCH 最后一封', JSON.stringify(latestClient.calls.fetch) === '[31]', JSON.stringify(latestClient.calls.fetch))
check('不做 HEADER SEARCH', latestClient.calls.search.length === 0)
check('返回实际 messageId', latest.messageId === '<latest@mail-channel>', latest.messageId)

console.log('\n== verifyWithClient：找到但检查项不符（真 fail） ==')
const failClient = fakeClient({
  mails: [{ uid: 40, raw: targetRaw }],
  searchHits: [40],
})
const failed = await verifyWithClient(failClient, CONFIG, {
  messageId: '<target-2@mail-channel>',
  to: ['someone-else@example.com'],
  attachments: 2,
})
check('检查项不符 → ok=false passed=false', failed.ok === false && failed.passed === false)
check('但 matched 仍是 message-id，不是 pending', failed.matched === 'message-id' && failed.pending !== true)
check('checks 每条带 label', failed.checks.length === 2 && failed.checks.every((item) => typeof item.label === 'string'))

console.log('\n== verifyWithClient：空发件箱 ==')
const emptyPending = await verifyWithClient(fakeClient({ mails: [] }), CONFIG, { messageId: '<x@mail-channel>' })
check('空箱 + messageId → pending', emptyPending.pending === true && emptyPending.matched === 'pending')
const emptyLatest = await verifyWithClient(fakeClient({ mails: [] }), CONFIG, {})
check(
  '空箱 + 无 messageId → 保持旧的空箱错误',
  emptyLatest.ok === false && emptyLatest.matched === 'latest' && emptyLatest.error === '发件箱是空的',
)

console.log('\n== verifySent：clientFactory 注入与关闭 ==')
let factoryOptions = null
const injectedClient = fakeClient({ mails: [{ uid: 50, raw: targetRaw }], searchHits: [50] })
const injected = await verifySent({ ...CONFIG, sentMailbox: '"Sent"' }, { user: 'u@example.com', pass: 'p' }, {
  messageId: '<target-2@mail-channel>',
  clientFactory: async (options) => {
    factoryOptions = options
    return injectedClient
  },
})
check('clientFactory 收到 imap 连接参数', factoryOptions?.user === 'u@example.com' && factoryOptions?.host === 'imap.qq.com')
check('自定义发件箱名生效', injectedClient.calls.select[0] === '"Sent"', JSON.stringify(injectedClient.calls.select))
check('用完关闭客户端', injectedClient.calls.close === 1)
check('verifySent 精确命中结果', injected.matched === 'message-id' && injected.ok === true)

const pendingClient = fakeClient({
  mails: [{ uid: 60, raw: rawMail({ messageId: '<someone-else@mail-channel>' }) }],
  searchHits: [],
})
const pendingViaSent = await verifySent(CONFIG, { user: 'u@example.com', pass: 'p' }, {
  messageId: '<not-synced@mail-channel>',
  clientFactory: async () => pendingClient,
})
check('verifySent 也返回 pending（不抛错）', pendingViaSent.pending === true && pendingClient.calls.close === 1)

console.log('\n== uidSearch（ImapClient，假 socket） ==')
class ScriptedSocket extends EventEmitter {
  constructor(handler) {
    super()
    this.handler = handler
    this.written = []
  }

  write(text) {
    this.written.push(text)
    const reply = this.handler(text)
    if (typeof reply === 'string' && reply !== '') this.emit('data', Buffer.from(reply, 'latin1'))
    return true
  }

  destroy() {
    this.emit('close')
  }
}

const imapSocket = new ScriptedSocket((command) => {
  const tag = command.split(' ')[0]
  if (command.includes('UID SEARCH ALL')) return `* SEARCH 2 7 9\r\n${tag} OK SEARCH done\r\n`
  if (command.includes('"<none@mail-channel>"')) return `${tag} OK SEARCH done\r\n`
  if (command.includes('UID SEARCH HEADER Message-ID')) return `* SEARCH 9 2\r\n${tag} OK SEARCH done\r\n`
  return `${tag} OK\r\n`
})
const imapClient = new ImapClient(imapSocket)
const allUids = await imapClient.uidSearchAll()
check('uidSearchAll 委托 uidSearch(ALL) 并解析', JSON.stringify(allUids) === '[2,7,9]', JSON.stringify(allUids))
check('uidSearchAll 发的是 UID SEARCH ALL', /UID SEARCH ALL/.test(imapSocket.written[0]), imapSocket.written[0])
const headerUids = await imapClient.uidSearch('HEADER Message-ID "<x@mail-channel>"')
check('uidSearch 解析 * SEARCH 行且升序', JSON.stringify(headerUids) === '[2,9]', JSON.stringify(headerUids))
check(
  'uidSearch 命令前缀正确',
  imapSocket.written[1].trim() === 'A0002 UID SEARCH HEADER Message-ID "<x@mail-channel>"',
  imapSocket.written[1],
)
const emptyUids = await imapClient.uidSearch('HEADER Message-ID "<none@mail-channel>"')
check('SEARCH 无 * SEARCH 行 → 空数组', JSON.stringify(emptyUids) === '[]', JSON.stringify(emptyUids))
imapClient.close()

console.log('\n== 重连退避 reconnectDelayMs ==')
const flatJitter = () => 0.5 // 0.8 + 0.5*0.4 = 1.0，便于断言精确值
check('第 1 次失败 30s', reconnectDelayMs(1, {}, flatJitter) === 30_000, String(reconnectDelayMs(1, {}, flatJitter)))
check('第 2 次 60s', reconnectDelayMs(2, {}, flatJitter) === 60_000)
check('第 3 次 120s', reconnectDelayMs(3, {}, flatJitter) === 120_000)
check('第 4 次 240s', reconnectDelayMs(4, {}, flatJitter) === 240_000)
check('第 5 次封顶 300s', reconnectDelayMs(5, {}, flatJitter) === 300_000)
check('第 9 次仍封顶 300s', reconnectDelayMs(9, {}, flatJitter) === 300_000)
check('0 次失败按第 1 次算', reconnectDelayMs(0, {}, flatJitter) === 30_000)
check(
  '自定义 base / cap',
  reconnectDelayMs(1, { reconnectBaseSeconds: 10, reconnectMaxSeconds: 40 }, flatJitter) === 10_000 &&
    reconnectDelayMs(5, { reconnectBaseSeconds: 10, reconnectMaxSeconds: 40 }, flatJitter) === 40_000,
)
check('抖动下限 -20%', reconnectDelayMs(1, {}, () => 0) === 24_000, String(reconnectDelayMs(1, {}, () => 0)))
check('抖动上限 +20%', reconnectDelayMs(1, {}, () => 1) === 36_000, String(reconnectDelayMs(1, {}, () => 1)))

console.log('\n== MailWatcher.status 新字段 ==')
const watcher = new MailWatcher(
  { mailDir: 'unused-in-test', reconnectBaseSeconds: 30, reconnectMaxSeconds: 300 },
  { user: 'u@example.com', pass: 'p' },
  { onMail: async () => {}, log: async () => {} },
)
const watcherStatus = watcher.status
check('lastErrorAt 初始为空串', watcherStatus.lastErrorAt === '')
check('failures 初始为 0', watcherStatus.failures === 0)
check(
  '保留既有字段',
  watcherStatus.alive === false &&
    watcherStatus.reconnects === 0 &&
    watcherStatus.mode === 'native long-connection' &&
    Object.hasOwn(watcherStatus, 'lastCheck') &&
    Object.hasOwn(watcherStatus, 'loginsToday') &&
    Object.hasOwn(watcherStatus, 'baseline'),
)
watcher.stop()

console.log(failures === 0 ? '\n验证/退避单测全部通过 ✅' : `\n验证/退避单测失败 ${failures} 项 ❌`)
process.exitCode = failures === 0 ? 0 : 1
