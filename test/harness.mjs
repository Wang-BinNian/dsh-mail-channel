/**
 * 离线自检 —— 不装进 Harness、不发真信，用假 ctx 走一遍插件的关键路径。
 *
 *   node test/harness.mjs
 *
 * 覆盖：队列判据、认领、绑定、到信唤醒、主人白名单、参数构造。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../index.js'
import { readContacts, resolveRecipients } from '../lib/contacts.js'
import { loadCredentials } from '../lib/native.js'
import { issueWakeToken, readWakeTokens } from '../lib/security.js'
import { readSettings, setSettingsFile, settingsFile, writeSettings } from '../lib/settings.js'
import { bumpUsage, readState, writeState } from '../lib/state.js'

/**
 * P4：DEFAULTS 已去个人化——`ownerAddress` / `selfAddress` 默认空串，
 * `ownerAliases` / `selfAliases` 默认 []，`fromName` 默认 ''。测试不再依赖
 * 任何本机配置，每个 apply() 都用这份 example.com fixture 显式传地址；
 * 另有一个「不传地址」的实例显式验证中性默认值（安全默认不可用）。
 */
const OWNER = 'owner@example.com'
const OWNER_ALIAS = 'owner-alias@example.com'
const AGENT = 'agent@example.com'
const AGENT_ALIAS = 'agent-alias@example.com'
const FIXTURE = {
  ownerAddress: OWNER,
  ownerAliases: [OWNER_ALIAS],
  selfAddress: AGENT,
  selfAliases: [AGENT_ALIAS],
  fromName: 'Test Agent',
}

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  [OK] ${label}`)
    return
  }
  failures += 1
  console.log(`  [!!] ${label} ${detail}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 假 ctx。
 *
 * `on(event, fn)` 必须实现：P0 之后 apply() 会注册 `tools/pre-execute` 发信门，
 * 没这个方法时激活就崩。监听器收进 `__listeners`，测试直接调用以验证 waterfall
 * 是否被截断（放行必须 `return next()`，不能返回 `{kind:'allow'}`）。
 *
 * `get(name)` 默认返回 undefined（= 没有审批服务）；传 `approval` 可注入假审批，
 * 用 `overrideOf()` / `config.policy` 决定 ask 还是 never。
 */
function makeCtx({ flushResult = true, approval = undefined, sessionController = undefined, credentials = undefined } = {}) {
  const tools = new Map()
  const sections = []
  const disposers = []
  const followups = []
  const routes = new Map()
  const flushCalls = []
  const listeners = []
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:1',
    register: (route) => {
      routes.set(`${route.kind}:${route.path}`, route)
      return () => routes.delete(`${route.kind}:${route.path}`)
    },
  }
  const ctx = {
    on: (event, fn) => {
      const entry = { event, fn }
      listeners.push(entry)
      const dispose = () => {
        const index = listeners.indexOf(entry)
        if (index >= 0) listeners.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section: (section) => sections.push(section) },
    sessions: {
      flush: async (session) => {
        flushCalls.push(session)
        return flushResult
      },
    },
    sessionController: sessionController ?? {
      resolveAgent: async (id) => ({
        agent: {
          session: { id },
          followup: (message) => followups.push(message),
        },
      }),
    },
    get: (name) => (name === 'approval' ? approval : name === 'credentials' ? credentials : undefined),
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject: (deps, callback) => {
      callback({ ...ctx, webServer })
    },
    __tools: tools,
    __sections: sections,
    __followups: followups,
    __routes: routes,
    __flushCalls: flushCalls,
    __listeners: listeners,
    __dispose: () => disposers.forEach((dispose) => typeof dispose === 'function' && dispose()),
  }
  return ctx
}

function mockRequest({ method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.headers = headers
  return req
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(text = '') {
      this.body = text
    },
  }
}

async function callUiRoute(ctx, { method = 'GET', headers = {}, body = '' } = {}) {
  const route = ctx.__routes.get('exact:/dsh-mail-channel/ui')
  if (route === undefined) throw new Error('UI 路由未注册')
  const res = mockResponse()
  await route.handler(mockRequest({ method, headers, body }), res)
  return { status: res.statusCode, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

const uiPost = (ctx, patch) =>
  callUiRoute(ctx, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

/** P0 发信门监听器：apply() 注册在 `tools/pre-execute` 上，测试直接调用它。 */
const preExecuteOf = (ctx) => ctx.__listeners.find((item) => item.event === 'tools/pre-execute')

function mailRecord(uid, { subject, from, isOwner, body, attachments = [] }) {
  return {
    uid,
    from,
    to: AGENT,
    subject,
    date: 'Mon, 20 Oct 2026 20:00:00 +0800',
    is_owner: isOwner,
    text: body,
    html: '',
    attachments,
    body,
    received_at: localStamp(),
  }
}

/** 守望写的是**本地**时间（time.strftime），心跳新鲜度必须按本地解析。 */
function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function main() {
  const mailDir = join(tmpdir(), `dsh-mail-channel-test-${process.pid}`)
  const queue = join(mailDir, '待办')
  await rm(mailDir, { recursive: true, force: true })
  await mkdir(queue, { recursive: true })
  // P5：mail_setup 的 settings.json 也重定向到临时目录，绝不碰真实 $DSH_HOME。
  setSettingsFile(join(mailDir, 'settings.json'))

  await writeFile(
    join(mailDir, '守望-state.json'),
    JSON.stringify({
      last_check: localStamp(),
      checks_done: 42,
      pid: 1234,
      baseline_uid: 100,
      mailbox_top_uid: 101,
    }),
    'utf8',
  )

  // 101：主人来信，未处理；102：陌生人且已处理（不该被算待办以外的噪声）
  await writeFile(
    join(queue, 'mail-101.json'),
    JSON.stringify(
      mailRecord(101, {
        subject: '测试：CFD 结果',
        from: OWNER_ALIAS,
        isOwner: true,
        body: '跑完了吗？把残差图发我。',
        attachments: [{ name: 'residual.png', type: 'image/png', bytes: 10, path: 'C:\\x\\residual.png' }],
      }),
    ),
    'utf8',
  )
  await writeFile(
    join(queue, 'mail-102.json'),
    JSON.stringify(mailRecord(102, { subject: '广告', from: 'ads@example.com', isOwner: false, body: 'buy' })),
    'utf8',
  )
  await writeFile(join(queue, 'mail-102.done'), '', 'utf8')

  const ctx = makeCtx({ flushResult: false })
  const plugin = apply(ctx, { ...FIXTURE, mailDir, pollSeconds: 3600, notifyOnStart: false, receive: false })
  check('apply 返回配置', typeof plugin === 'object')
  check('注册了 tools/pre-execute 监听（P0 发信门）', typeof preExecuteOf(ctx)?.fn === 'function')
  check('注册了 9 个工具（含 mail_setup）', ctx.__tools.size === 9, `实际 ${[...ctx.__tools.keys()].join(',')}`)
  check('注入了协议提示', ctx.__sections.some((section) => section.name === 'mail-channel'))
  // 协议提示的 text 现在是函数（mail_setup 改配置后下一轮渲染即生效），测试时显式求值。
  const promptSection = ctx.__sections.find((section) => section.name === 'mail-channel')
  const promptText = typeof promptSection?.text === 'function' ? promptSection.text({}) : promptSection?.text ?? ''
  check(
    'P4：fixture 地址进入协议提示（不再依赖 DEFAULTS 里的本机地址）',
    promptText.includes(OWNER),
    JSON.stringify(ctx.__sections.map((section) => section.name)),
  )
  check('P4：fixture 地址进入运行时配置', plugin.config.ownerAddress === OWNER && plugin.config.selfAddress === AGENT)
  check('P4.1：协议提示写明"回复渠道 = 请求来源渠道"', promptText.includes('回复渠道 = 请求来源渠道'))
  check('P4.1：对话里下达的任务不额外发邮件', promptText.includes('不要额外发邮件'))
  check('P4.1：不再有"报告结果就发信"的旧指令', !promptText.includes('或你要把结果报告给他时'))
  check(
    'P4.1：mail_send 描述限定邮件唤醒/明确要求两种场景',
    ctx.__tools.get('mail_send').description.includes('只在两种情况下用'),
    ctx.__tools.get('mail_send').description.slice(0, 80),
  )

  // ── 侧栏开关：路由 + 首次升级迁移 ──
  const initialUi = await callUiRoute(ctx)
  check('UI 路由已注册', initialUi.status === 200, JSON.stringify(initialUi))
  check(
    '首次升级默认关闭且未绑定',
    initialUi.json.enabled === false && initialUi.json.sessionId === '',
    JSON.stringify(initialUi.json),
  )

  // schema 契约：必填项必须出现在 required 里，且作者侧标记不能泄漏进属性
  const readSchema = ctx.__tools.get('mail_read').parameters
  check('mail_read.uid 是必填', readSchema.required.includes('uid'), JSON.stringify(readSchema.required))
  check('mail_send.subject 是必填', ctx.__tools.get('mail_send').parameters.required.includes('subject'))
  check(
    '属性里没有残留 required 标记',
    Object.values(readSchema.properties).every((spec) => !Object.hasOwn(spec ?? {}, 'required')),
    JSON.stringify(readSchema.properties.uid),
  )
  check('无参工具 required 为空数组', ctx.__tools.get('mail_bind').parameters.required.length === 0)

  const exec = { agent: { session: { id: 'session-test-1' } } }

  // ── mail_inbox ──
  const inbox = JSON.parse(await ctx.__tools.get('mail_inbox').execute({}, exec))
  check('待办 1 封（已处理的 102 不计）', inbox.unhandled === 1, JSON.stringify(inbox.pending))
  check('通道被判定为存活', inbox.channel.alive === true, JSON.stringify(inbox.channel))
  check('未绑定时 bound 为空', inbox.bound.sessionId === '')
  check('摘要不含全文', inbox.pending[0].preview.length <= 160)
  check(
    'P0：mail_inbox 暴露 security（默认 confirm + address）',
    inbox.security?.sendPolicy === 'confirm' &&
      inbox.security?.wakeAuth === 'address' &&
      inbox.security?.allowedRecipients === 0 &&
      inbox.security?.wakeTokensActive === 0,
    JSON.stringify(inbox.security),
  )

  // ── mail_read + 认领 ──
  const read = JSON.parse(await ctx.__tools.get('mail_read').execute({ uid: 101 }, exec))
  check('读到正文', read.body.includes('残差图'), read.body)
  check('附件路径给出', read.attachments[0]?.path === 'C:\\x\\residual.png')
  check('写出 .done', existsSync(join(queue, 'mail-101.done')))

  const missing = JSON.parse(await ctx.__tools.get('mail_read').execute({ uid: 999 }, exec))
  check('读不存在的 uid 返回 ok:false', missing.ok === false)

  // ── mail_bind ──
  const bound = JSON.parse(await ctx.__tools.get('mail_bind').execute({}, exec))
  check('绑定当前会话', bound.channelSessionId === 'session-test-1')
  check('绑定同时打开侧栏开关', bound.enabled === true)
  const stateFile = JSON.parse(await readFile(join(mailDir, 'plugin-state.json'), 'utf8'))
  check('绑定落盘', stateFile.channelSessionId === 'session-test-1')
  const afterBindUi = await callUiRoute(ctx)
  check(
    'UI 状态跟随 mail_bind',
    afterBindUi.json.enabled === true && afterBindUi.json.sessionId === 'session-test-1',
    JSON.stringify(afterBindUi.json),
  )
  const uiFile = JSON.parse(await readFile(join(mailDir, 'ui-state.json'), 'utf8'))
  check('UI 状态落盘', uiFile.enabled === true && uiFile.sessionId === 'session-test-1')
  const subExec = { agent: { session: { id: 'session-sub', header: { origin: 'subagent' } } } }
  const subBind = JSON.parse(await ctx.__tools.get('mail_bind').execute({}, subExec))
  check('子会话不能当通道', subBind.ok === false && (await callUiRoute(ctx)).json.sessionId === 'session-test-1')

  // ── 地址簿 ──
  const learned = JSON.parse(await ctx.__tools.get('mail_contacts').execute({ action: 'learn' }, exec))
  check('从历史信里学到联系人', learned.total >= 2, JSON.stringify(learned))
  const book = await readContacts(mailDir)
  const owner = book.contacts.find((contact) => contact.address === OWNER)
  check('主人地址被标注', owner?.note === '主人', JSON.stringify(owner))
  check('主人别名收敛成主地址的别名', owner?.aliases.includes(OWNER_ALIAS), JSON.stringify(owner?.aliases))
  check('地址簿不为别名单列一条', !book.contacts.some((c) => c.address === OWNER_ALIAS))
  check('陌生发件人也进地址簿', book.contacts.some((c) => c.address === 'ads@example.com'))
  const todayStamp = localStamp().slice(0, 10)
  check('lastSeen 取最新一封而不是最旧', owner?.lastSeen === todayStamp, `${owner?.lastSeen} vs ${todayStamp}`)
  const owners = [OWNER]
  const group = resolveRecipients(book, ['@主人'], owners)
  check('@主人 只发一个地址', group.length === 1 && group[0] === OWNER, JSON.stringify(group))
  check('@主人 与主人别名去重', resolveRecipients(book, ['@主人', OWNER_ALIAS], owners).length === 1)
  check('解析：直接写地址', resolveRecipients(book, ['someone@example.com'])[0] === 'someone@example.com')
  check('解析：对不上原样保留', resolveRecipients(book, ['nothing@nowhere'])[0] === 'nothing@nowhere')

  const added = JSON.parse(
    await ctx.__tools.get('mail_contacts').execute(
      { action: 'add', address: 'friend@example.com', name: '朋友', aliases: ['老张'], note: '测试' },
      exec,
    ),
  )
  check('新增联系人', added.ok === true && added.contact.name === '朋友', JSON.stringify(added))
  const book2 = await readContacts(mailDir)
  check('别名可用于解析', resolveRecipients(book2, ['老张'])[0] === 'friend@example.com')
  const removed = JSON.parse(
    await ctx.__tools.get('mail_contacts').execute({ action: 'remove', address: '老张' }, exec),
  )
  check('按别名删除联系人', removed.ok === true && removed.removed.address === 'friend@example.com')

  // ── 本地往来检索 ──
  await writeFile(
    join(mailDir, 'send.log'),
    `2026-10-20 21:37:28  OK: 发信 -> ${OWNER_ALIAS},${OWNER} （主题：回信：通道正常，端口 587，附件 0）\n`,
    'utf8',
  )
  const all = JSON.parse(await ctx.__tools.get('mail_history').execute({ limit: 50 }, exec))
  check('往来含收与发', all.matched === 3, JSON.stringify(all))
  const fromAds = JSON.parse(await ctx.__tools.get('mail_history').execute({ from: 'ads@example' }, exec))
  check('按发件人过滤', fromAds.matched === 1)
  const keyword = JSON.parse(await ctx.__tools.get('mail_history').execute({ contains: '残差' }, exec))
  check('按正文关键词过滤', keyword.matched === 1 && keyword.items[0].direction === 'in')
  const onlyIn = JSON.parse(
    await ctx.__tools.get('mail_history').execute({ includeSent: false, limit: 50 }, exec),
  )
  check('可排除已发', onlyIn.matched === 2, JSON.stringify(onlyIn))
  const future = JSON.parse(await ctx.__tools.get('mail_history').execute({ since: '2099-01-01' }, exec))
  check('时间过滤生效', future.matched === 0)

  // ── 用量预算 ──
  const budgetBefore = JSON.parse(await ctx.__tools.get('mail_inbox').execute({}, exec)).budget
  check('预算有日期与额度', budgetBefore.date.length === 10 && budgetBefore.loginBudget > 0, JSON.stringify(budgetBefore))
  check('未发信时 sendsToday=0', budgetBefore.sendsToday === 0)
  await bumpUsage(mailDir, 'sends')
  const budgetAfter = JSON.parse(await ctx.__tools.get('mail_inbox').execute({}, exec)).budget
  check('发信后计数 +1', budgetAfter.sendsToday === 1, JSON.stringify(budgetAfter))

  // ── 自检工具（不连网） ──
  const doctor = JSON.parse(await ctx.__tools.get('mail_doctor').execute({}, exec))
  check('自检返回检查项', Array.isArray(doctor.checks) && doctor.checks.length >= 5, JSON.stringify(doctor.checks?.length))
  check('自检发现没凭据', doctor.checks.some((c) => c.name === '凭据' && c.ok === false), JSON.stringify(doctor.checks))
  check('自检给出下一步', Array.isArray(doctor.hints) && doctor.hints.length > 0, JSON.stringify(doctor.hints))
  check('自检列出待办建议', doctor.hints.some((h) => h.includes('未认领')) || doctor.checks.find((c) => c.name === '待办')?.detail.includes('0 封'), JSON.stringify(doctor.checks))
  const doctorNames = doctor.checks.map((entry) => entry.name)
  check(
    'P1：mail_doctor 有「实例锁」「日志」两项',
    doctorNames.includes('实例锁') && doctorNames.includes('日志'),
    JSON.stringify(doctorNames),
  )
  check(
    'P1：receive=false 时实例锁检查注明外部收信模式',
    String(doctor.checks.find((c) => c.name === '实例锁')?.detail).includes('外部收信模式'),
    JSON.stringify(doctor.checks.find((c) => c.name === '实例锁')),
  )
  check(
    'P1：日志检查给出轮转阈值与保留份数',
    String(doctor.checks.find((c) => c.name === '日志')?.detail).includes('阈值') &&
      String(doctor.checks.find((c) => c.name === '日志')?.detail).includes('保留'),
    JSON.stringify(doctor.checks.find((c) => c.name === '日志')),
  )

  // ── 凭据解析链（不连网） ──
  const bare = { user: '', password: '' }
  const direct = await loadCredentials({ ...bare, user: 'u@x', password: 'p' })
  check('凭据：配置优先', direct.source === 'config' && direct.pass === 'p')
  const viaSecret = await loadCredentials(
    { ...bare, passwordCredential: 'P', userCredential: 'U' },
    { secret: async (name) => (name === 'P' ? 'stored-pass' : name === 'U' ? 'stored-user' : undefined) },
  )
  check('凭据：走凭据服务', viaSecret.source === 'credentials' && viaSecret.user === 'stored-user', JSON.stringify(viaSecret))
  process.env.MAIL_CHANNEL_PASSWORD = 'env-pass'
  process.env.MAIL_CHANNEL_USER = 'env-user'
  const viaEnv = await loadCredentials({ ...bare })
  delete process.env.MAIL_CHANNEL_PASSWORD
  delete process.env.MAIL_CHANNEL_USER
  check('凭据：走环境变量', viaEnv.source === 'env' && viaEnv.pass === 'env-pass', JSON.stringify(viaEnv))
  const credFile = join(mailDir, 'creds.ps1')
  await writeFile(credFile, "$smtpUser = 'file-user@x'\n$smtpPass = 'file-pass'\n", 'utf8')
  const viaFile = await loadCredentials({ ...bare, credentialFile: credFile })
  check('凭据：文件兜底', viaFile.source === 'file' && viaFile.user === 'file-user@x', JSON.stringify(viaFile))
  let missingThrew = false
  try {
    await loadCredentials({ ...bare })
  } catch {
    missingThrew = true
  }
  check('凭据：全都没有时给明确错误', missingThrew)

  // ── 到信唤醒（走真实 fs.watch） ──
  await writeFile(
    join(queue, 'mail-103.json'),
    JSON.stringify(
      mailRecord(103, { subject: '新指令', from: OWNER, isOwner: true, body: '把网格加密到 200 万。' }),
    ),
    'utf8',
  )
  await writeFile(
    join(queue, 'mail-104.json'),
    JSON.stringify(mailRecord(104, { subject: '垃圾', from: 'spam@example.com', isOwner: false, body: 'buy' })),
    'utf8',
  )
  await sleep(4000)
  check('唤醒了一次', ctx.__followups.length === 1, `实际 ${ctx.__followups.length}`)
  const wakeText = ctx.__followups[0]?.content?.[0]?.text ?? ''
  check('唤醒了主人信 103', wakeText.includes('uid: 103'), wakeText.slice(0, 200))
  check('P4.1：唤醒模板标明"本轮由邮件唤醒"', wakeText.includes('本轮由邮件唤醒'), wakeText.slice(0, 200))
  check('没唤醒陌生人 104', !wakeText.includes('uid: 104'))
  check('唤醒消息带来源标记', ctx.__followups[0]?.source?.kind === 'mail')
  check('103 写了 .woken', existsSync(join(queue, 'mail-103.woken')))
  check('104 没写 .woken', !existsSync(join(queue, 'mail-104.woken')))

  // flush 返回 false 只表示没有耐久化监听者：投递仍算成功，不能重复注入。
  check('flush=false 仍算投递成功', ctx.__flushCalls.length > 0)
  await writeFile(join(queue, 'dummy.tmp'), 'x', 'utf8')
  await sleep(2500)
  check('flush=false 不会重复唤醒', ctx.__followups.length === 1, `实际 ${ctx.__followups.length}`)

  // ── 侧栏开关：关闭不唤醒；开启不补唤醒积压，只唤醒之后的新信 ──
  const offUi = await uiPost(ctx, { enabled: false })
  check('开关可关闭', offUi.status === 200 && offUi.json.enabled === false)
  await writeFile(
    join(queue, 'mail-105.json'),
    JSON.stringify(
      mailRecord(105, { subject: '关闭期间', from: OWNER, isOwner: true, body: '暂停期间的信' }),
    ),
    'utf8',
  )
  await sleep(2500)
  check('关闭期间不唤醒', !existsSync(join(queue, 'mail-105.woken')) && ctx.__followups.length === 1)
  const onAgain = await uiPost(ctx, { enabled: true, sessionId: 'session-test-1' })
  check('重新开启', onAgain.status === 200 && onAgain.json.enabled === true)
  await sleep(1500)
  check('开启不补唤醒积压', !existsSync(join(queue, 'mail-105.woken')) && ctx.__followups.length === 1)
  await writeFile(
    join(queue, 'mail-106.json'),
    JSON.stringify(
      mailRecord(106, { subject: '开启后的新信', from: OWNER, isOwner: true, body: '新指令' }),
    ),
    'utf8',
  )
  await sleep(2500)
  check(
    '开启后的新信会唤醒',
    existsSync(join(queue, 'mail-106.woken')) && ctx.__followups.length === 2,
    `实际 ${ctx.__followups.length}`,
  )

  // ── P0 唤醒门：From 头必须 addr-spec 精确匹配主人 ──
  // 旧实现是子串匹配，下面两种伪造都能混进来；旧归档里的 is_owner 同理不再可信。
  await writeFile(
    join(queue, 'mail-107.json'),
    JSON.stringify(
      mailRecord(107, {
        subject: '伪造 From',
        from: `"${OWNER}" <evil@example.com>`,
        isOwner: true,
        body: '显示名里带主人地址',
      }),
    ),
    'utf8',
  )
  await writeFile(
    join(queue, 'mail-108.json'),
    JSON.stringify(
      mailRecord(108, {
        subject: '寄生域名',
        from: `${OWNER}.evil.com`,
        isOwner: true,
        body: '域名后缀伪装',
      }),
    ),
    'utf8',
  )
  await sleep(2500)
  check(
    'P0：伪造 From 不唤醒（旧 is_owner=true 也不信）',
    ctx.__followups.length === 2 && !existsSync(join(queue, 'mail-107.woken')),
    `实际 ${ctx.__followups.length}`,
  )
  check(
    'P0：寄生域名后缀不唤醒',
    ctx.__followups.length === 2 && !existsSync(join(queue, 'mail-108.woken')),
    `实际 ${ctx.__followups.length}`,
  )
  await writeFile(
    join(queue, 'mail-109.json'),
    JSON.stringify(
      mailRecord(109, {
        subject: '真主人',
        from: `"Owner" <${OWNER.toUpperCase()}>`,
        isOwner: false,
        body: '继续',
      }),
    ),
    'utf8',
  )
  await sleep(2500)
  check(
    'P0：精确主人地址（显示名/大小写不同、is_owner=false）仍唤醒',
    existsSync(join(queue, 'mail-109.woken')) && ctx.__followups.length === 3,
    `实际 ${ctx.__followups.length}`,
  )
  const p0Inbox = JSON.parse(await ctx.__tools.get('mail_inbox').execute({}, exec))
  check(
    'P0：mail_inbox.isOwner 按精确地址重算（伪造信 107 = false）',
    p0Inbox.pending.find((item) => item.uid === 107)?.isOwner === false,
    JSON.stringify(p0Inbox.pending.find((item) => item.uid === 107)),
  )

  // ── 路由的入口校验 ──
  const badOrigin = await callUiRoute(ctx, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: '{}',
  })
  check('跨源请求被拒', badOrigin.status === 403)
  const badType = await callUiRoute(ctx, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
  check('非 JSON 请求被拒', badType.status === 415)
  const badSession = await uiPost(ctx, { sessionId: '../etc/passwd' })
  check('非法 sessionId 被拒', badSession.status === 400)

  // ── 传输层不再走 Python：这里只验证"发信前的输入整理"不炸 ──
  const sendPreview = await ctx.__tools.get('mail_send').execute({ subject: '', body: 'x' }, exec)
  check('空主题被拒', JSON.parse(sendPreview).ok === false)
  const noBody = await ctx.__tools.get('mail_send').execute({ subject: '标题' }, exec)
  check('空正文被拒', JSON.parse(noBody).ok === false)
  const badFile = await ctx.__tools.get('mail_send').execute(
    { subject: '标题', bodyFile: 'C:\\不存在\\正文.md' },
    exec,
  )
  check('读不到的正文文件给明确错误', JSON.parse(badFile).error?.includes('读不到'), badFile)

  // ── P0 发信门（独立临时目录 + 独立 ctx；直接调用 tools/pre-execute 监听器）──
  // 放行必须验证"返回的是 next() 的返回值"：返回 {kind:'allow'} 会截断 waterfall，
  // 把链条上别的插件的门一起绕过去。
  const gateDir = join(tmpdir(), `dsh-mail-channel-gate-test-${process.pid}`)
  await rm(gateDir, { recursive: true, force: true })
  await mkdir(join(gateDir, '待办'), { recursive: true })
  const applyGate = ({ config: overrides = {}, approval } = {}) => {
    const context = makeCtx({ approval })
    apply(context, {
      ...FIXTURE,
      mailDir: gateDir,
      pollSeconds: 3600,
      notifyOnStart: false,
      receive: false,
      ...overrides,
    })
    return context
  }
  const sentinel = { kind: 'downstream-sentinel' }
  const sendExec = (args = {}) => ({
    name: 'mail_send',
    arguments: { subject: 'P0 测试', body: '正文', ...args },
    agent: { session: { id: 'session-gate' } },
  })
  const strangerSend = sendExec({ to: ['someone@example.com'] })

  const ctxGate = applyGate()
  const pre = preExecuteOf(ctxGate)?.fn
  check('P0：注册了 tools/pre-execute 监听', typeof pre === 'function')
  check(
    'P0：发给主人放行，且返回 next() 的返回值（不截断 waterfall）',
    (await pre(sendExec(), () => sentinel)) === sentinel,
  )
  check(
    'P0：主人别名（数字版地址）同样直通',
    (await pre(sendExec({ to: [OWNER_ALIAS] }), () => sentinel)) === sentinel,
  )
  check(
    'P0：非 mail_send 工具原样交回链条',
    (await pre(
      { name: 'mail_read', arguments: { uid: 1 }, agent: { session: { id: 'session-gate' } } },
      () => sentinel,
    )) === sentinel,
  )
  const noApproval = await pre(strangerSend, () => ({ kind: 'allow' }))
  check(
    'P0：confirm 且审批服务缺失 → 明确拒绝（不伪造审批）',
    noApproval?.kind === 'deny' && String(noApproval.reason).includes('no-approval-service'),
    JSON.stringify(noApproval),
  )
  const noSession = await pre({ name: 'mail_send', arguments: strangerSend.arguments }, () => ({ kind: 'allow' }))
  check(
    'P0：拿不到会话时 confirm 也拒绝（no-agent-session）',
    noSession?.kind === 'deny' && String(noSession.reason).includes('no-agent-session'),
    JSON.stringify(noSession),
  )
  const invalidRecipient = await pre(sendExec({ to: ['not-an-address@'] }), () => ({ kind: 'allow' }))
  check(
    'P0：非法收件人直接拒绝',
    invalidRecipient?.kind === 'deny' && String(invalidRecipient.reason).includes('不合法'),
    JSON.stringify(invalidRecipient),
  )
  ctxGate.__dispose()

  const ctxOwnerOnly = applyGate({ config: { sendPolicy: 'owner-only' } })
  const ownerOnlyPre = preExecuteOf(ctxOwnerOnly).fn
  const ownerOnlyDenied = await ownerOnlyPre(strangerSend, () => ({ kind: 'allow' }))
  check(
    'P0：owner-only 下陌生收件人被拒',
    ownerOnlyDenied?.kind === 'deny' && String(ownerOnlyDenied.reason).includes('不在白名单'),
    JSON.stringify(ownerOnlyDenied),
  )
  check(
    'P0：拒绝理由给出路（allowedRecipients / sendPolicy）',
    String(ownerOnlyDenied?.reason).includes('allowedRecipients'),
  )
  check('P0：owner-only 下主人仍直通', (await ownerOnlyPre(sendExec(), () => sentinel)) === sentinel)
  ctxOwnerOnly.__dispose()

  const ctxOpen = applyGate({ config: { sendPolicy: 'open' } })
  const openPre = preExecuteOf(ctxOpen).fn
  check('P0：open 策略下陌生人直通', (await openPre(strangerSend, () => sentinel)) === sentinel)
  const openLog = await readFile(join(gateDir, 'plugin.log'), 'utf8')
  check('P0：open 放行在 plugin.log 留策略警告', openLog.includes('send 策略警告'), openLog.slice(-300))
  ctxOpen.__dispose()

  const ctxWhitelist = applyGate({ config: { allowedRecipients: ['someone@example.com'] } })
  const whitelistPre = preExecuteOf(ctxWhitelist).fn
  check(
    'P0：allowedRecipients 内直通（大小写不敏感）',
    (await whitelistPre(sendExec({ to: ['someone@example.com'] }), () => sentinel)) === sentinel,
  )
  ctxWhitelist.__dispose()

  const ctxAsk = applyGate({
    approval: { overrideOf: () => 'ask', config: { policy: 'ask' }, request: async () => 'allowed-once' },
  })
  const ask = await preExecuteOf(ctxAsk).fn(strangerSend, () => ({ kind: 'allow' }))
  check("P0：confirm + 审批可用 → {kind:'ask'}", ask?.kind === 'ask', JSON.stringify(ask))
  check(
    'P0：ask 的 displayReason 是含 en/zh 的 locale map',
    ask?.displayReason !== null &&
      typeof ask?.displayReason === 'object' &&
      typeof ask.displayReason.en === 'string' &&
      ask.displayReason.en !== '' &&
      typeof ask.displayReason.zh === 'string' &&
      ask.displayReason.zh !== '',
    JSON.stringify(ask?.displayReason),
  )
  check(
    'P0：ask 的 reason 带上收件人与主题',
    String(ask?.reason).includes('someone@example.com') && String(ask?.reason).includes('P0 测试'),
    JSON.stringify(ask?.reason),
  )
  ctxAsk.__dispose()

  const ctxNever = applyGate({ approval: { overrideOf: () => 'never', config: { policy: 'ask' } } })
  const never = await preExecuteOf(ctxNever).fn(strangerSend, () => ({ kind: 'allow' }))
  check(
    'P0：审批策略 never 时明确拒绝，而不是发一个不会弹的 ask',
    never?.kind === 'deny' && String(never.reason).includes('never'),
    JSON.stringify(never),
  )
  ctxNever.__dispose()

  // ── P0 唤醒门：token 模式（独立临时目录 + 真实 fs.watch）──
  const tokenDir = join(tmpdir(), `dsh-mail-channel-token-test-${process.pid}`)
  await rm(tokenDir, { recursive: true, force: true })
  await mkdir(join(tokenDir, '待办'), { recursive: true })
  const tokenQueue = join(tokenDir, '待办')
  const tokenFollowups = []
  const tokenCtx = makeCtx({
    sessionController: {
      resolveAgent: async (id) => ({
        agent: { session: { id }, followup: (message) => tokenFollowups.push(message) },
      }),
    },
  })
  apply(tokenCtx, {
    ...FIXTURE,
    mailDir: tokenDir,
    pollSeconds: 3600,
    notifyOnStart: false,
    receive: false,
    channelSessionId: 'session-token',
    wakeAuth: 'token',
    wakeTokenTtlMinutes: 60,
    wakePassphrase: 'OPEN-SESAME',
  })
  const tokenExec = { agent: { session: { id: 'session-token' } } }

  await writeFile(
    join(tokenQueue, 'mail-301.json'),
    JSON.stringify(
      mailRecord(301, { subject: '无口令', from: OWNER, isOwner: true, body: '没有令牌' }),
    ),
    'utf8',
  )
  await sleep(2500)
  check(
    'P0：token 模式下无令牌的主人信不唤醒',
    tokenFollowups.length === 0 && !existsSync(join(tokenQueue, 'mail-301.woken')),
    `实际 ${tokenFollowups.length}`,
  )

  const validToken = await issueWakeToken(tokenDir, { ttlMinutes: 60, subject: '通知' })
  await writeFile(
    join(tokenQueue, 'mail-302.json'),
    JSON.stringify(
      mailRecord(302, {
        subject: `回信 [wake:${validToken.toLowerCase()}]`,
        from: OWNER_ALIAS,
        isOwner: true,
        body: '继续',
      }),
    ),
    'utf8',
  )
  await sleep(2500)
  check(
    'P0：有效令牌唤醒（令牌大小写不敏感）',
    tokenFollowups.length === 1 && existsSync(join(tokenQueue, 'mail-302.woken')),
    `实际 ${tokenFollowups.length}`,
  )
  const tokenStoreAfter = await readWakeTokens(tokenDir)
  check(
    'P0：令牌用后一次性核销（usedAt 已写）',
    tokenStoreAfter.tokens.find((entry) => entry.token === validToken)?.usedAt !== '',
    JSON.stringify(tokenStoreAfter.tokens),
  )

  const expiredToken = 'AAAABBBBCCCCDDDD'
  await writeFile(
    join(tokenDir, 'wake-tokens.json'),
    JSON.stringify({
      version: 1,
      tokens: [
        {
          token: expiredToken,
          issuedAt: new Date(Date.now() - 7200000).toISOString(),
          expiresAt: new Date(Date.now() - 3600000).toISOString(),
          subject: '',
          usedAt: '',
        },
      ],
    }),
    'utf8',
  )
  await writeFile(
    join(tokenQueue, 'mail-303.json'),
    JSON.stringify(
      mailRecord(303, {
        subject: `旧 [wake:${expiredToken}]`,
        from: OWNER,
        isOwner: true,
        body: '过期令牌',
      }),
    ),
    'utf8',
  )
  await writeFile(
    join(tokenQueue, 'mail-304.json'),
    JSON.stringify(
      mailRecord(304, {
        subject: '新写一封信',
        from: OWNER,
        isOwner: true,
        body: '请处理\nOPEN-SESAME\n谢谢',
      }),
    ),
    'utf8',
  )
  await sleep(2500)
  check(
    'P0：过期令牌不唤醒',
    !existsSync(join(tokenQueue, 'mail-303.woken')),
    `实际 followups=${tokenFollowups.length}`,
  )
  check(
    'P0：静态口令（单独一行）可唤醒新写的信',
    existsSync(join(tokenQueue, 'mail-304.woken')) && tokenFollowups.length === 2,
    `实际 ${tokenFollowups.length}`,
  )

  const tokenInbox = JSON.parse(await tokenCtx.__tools.get('mail_inbox').execute({}, tokenExec))
  check(
    'P0：mail_inbox.security 字段齐全（token 模式）',
    tokenInbox.security?.sendPolicy === 'confirm' &&
      tokenInbox.security?.wakeAuth === 'token' &&
      tokenInbox.security?.allowedRecipients === 0 &&
      Number.isFinite(tokenInbox.security?.wakeTokensActive),
    JSON.stringify(tokenInbox.security),
  )
  const tokenDoctor = JSON.parse(await tokenCtx.__tools.get('mail_doctor').execute({}, tokenExec))
  const tokenDoctorNames = (tokenDoctor.checks ?? []).map((entry) => entry.name)
  check('P0：mail_doctor 有「发信策略」检查', tokenDoctorNames.includes('发信策略'), JSON.stringify(tokenDoctorNames))
  check(
    'P0：mail_doctor 有「唤醒鉴权」检查且标明 token 模式',
    tokenDoctorNames.includes('唤醒鉴权') &&
      String(tokenDoctor.checks.find((entry) => entry.name === '唤醒鉴权')?.detail).includes('token 模式'),
    JSON.stringify(tokenDoctor.checks),
  )
  tokenCtx.__dispose()
  await rm(tokenDir, { recursive: true, force: true })
  await rm(gateDir, { recursive: true, force: true })

  // ── P1-A：mail_verify schema + lastSent + pending 语义（离线，不连网）──
  const verifySchema = ctx.__tools.get('mail_verify').parameters
  check(
    'P1：mail_verify 有可选 messageId（不在 required 里）',
    verifySchema.properties.messageId !== undefined && !verifySchema.required.includes('messageId'),
    JSON.stringify(verifySchema.required),
  )
  check(
    'P1：mail_verify 说明写明 pending 不是失败',
    String(ctx.__tools.get('mail_verify').description).includes('pending'),
  )
  const verifyWithoutCreds = JSON.parse(await ctx.__tools.get('mail_verify').execute({}, exec))
  check(
    'P1：无凭据时 mail_verify 返回 ok:false 而不是抛错',
    verifyWithoutCreds.ok === false &&
      verifyWithoutCreds.passed === false &&
      String(verifyWithoutCreds.error).includes('凭据'),
    JSON.stringify(verifyWithoutCreds),
  )
  const verifyExplicitId = JSON.parse(
    await ctx.__tools.get('mail_verify').execute({ messageId: '<probe@mail-channel>' }, exec),
  )
  check(
    'P1：显式 messageId 也先走凭据检查（不抛、仍 ok:false）',
    verifyExplicitId.ok === false && typeof verifyExplicitId.error === 'string',
    JSON.stringify(verifyExplicitId),
  )

  const p1Dir = join(tmpdir(), `dsh-mail-channel-p1-test-${process.pid}`)
  await rm(p1Dir, { recursive: true, force: true })
  await mkdir(join(p1Dir, '待办'), { recursive: true })
  const lastSentFixture = {
    messageId: '<p1-fixture@mail-channel>',
    subject: 'P1 主题',
    to: OWNER,
    at: '2026-11-07T20:00:00.000Z',
  }
  await writeState(p1Dir, {
    channelSessionId: '',
    wakes: [],
    lastWakeAt: '',
    lastSent: lastSentFixture,
    usage: { date: '', sends: 0, verifies: 0 },
  })
  const stateAfterWrite = await readState(p1Dir)
  check(
    'P1：lastSent 读写往返保留 messageId',
    stateAfterWrite.lastSent?.messageId === lastSentFixture.messageId,
    JSON.stringify(stateAfterWrite.lastSent),
  )
  check(
    'P1：lastSent 往返保留 subject/to/at',
    stateAfterWrite.lastSent?.subject === lastSentFixture.subject &&
      stateAfterWrite.lastSent?.to === lastSentFixture.to &&
      stateAfterWrite.lastSent?.at === lastSentFixture.at,
    JSON.stringify(stateAfterWrite.lastSent),
  )
  await writeFile(join(p1Dir, 'plugin-state.json'), JSON.stringify({ lastSent: { subject: '缺 messageId' } }), 'utf8')
  check('P1：坏 lastSent（缺 messageId）读成 null', (await readState(p1Dir)).lastSent === null)

  // 轮转后的检索：手写旧分片 + 当前文件，mail_history 必须按旧→新读全部分片。
  await writeFile(
    join(p1Dir, 'send.log.1'),
    '2026-11-06 10:00:00  OK: 发信 -> a@example.com （主题：轮转前的旧信，端口 587，附件 0）\n',
    'utf8',
  )
  await writeFile(
    join(p1Dir, 'send.log'),
    '2026-11-07 10:00:00  OK: 发信 -> c@example.com （主题：轮转后的新信，端口 587，附件 1）\n',
    'utf8',
  )
  const ctxP1 = makeCtx()
  apply(ctxP1, { ...FIXTURE, mailDir: p1Dir, pollSeconds: 3600, notifyOnStart: false, receive: false, logKeep: 2 })
  const p1History = JSON.parse(await ctxP1.__tools.get('mail_history').execute({ limit: 50 }, exec))
  check(
    'P1：轮转后 mail_history 同时读到旧分片与新文件',
    p1History.items.some((item) => item.subject === '轮转前的旧信') &&
      p1History.items.some((item) => item.subject === '轮转后的新信'),
    JSON.stringify(p1History.items.map((item) => item.subject)),
  )
  check('P1：轮转后发信记录共 2 条', p1History.matched === 2, JSON.stringify(p1History))
  check('P1：轮转后按时间倒序（新信在前）', p1History.items[0]?.subject === '轮转后的新信')
  const p1Doctor = JSON.parse(await ctxP1.__tools.get('mail_doctor').execute({}, exec))
  check(
    'P1：mail_doctor.lastSend 取轮转后最新一条',
    String(p1Doctor.lastSend).includes('轮转后的新信'),
    JSON.stringify(p1Doctor.lastSend),
  )
  ctxP1.__dispose()

  // ── P1-B：启动失败自动重试 + 失败后释放实例锁（receive:true、无凭据、独立 tmp 目录）──
  // 离线安全：ensureReceiving 先拿锁再解析凭据，凭据缺失即失败，重试定时器是 unref 的。
  const retryDir = join(tmpdir(), `dsh-mail-channel-retry-test-${process.pid}`)
  await rm(retryDir, { recursive: true, force: true })
  await mkdir(join(retryDir, '待办'), { recursive: true })
  const retryCtx = makeCtx()
  apply(retryCtx, { ...FIXTURE, mailDir: retryDir, pollSeconds: 3600, notifyOnStart: false, receive: true })
  await sleep(2000)
  const retryInbox = JSON.parse(await retryCtx.__tools.get('mail_inbox').execute({}, exec))
  check(
    'P1：启动失败后 channel 暴露 retryAttempts>=1',
    Number.isInteger(retryInbox.channel?.retryAttempts) && retryInbox.channel.retryAttempts >= 1,
    JSON.stringify(retryInbox.channel),
  )
  check(
    'P1：启动失败原因写明凭据不可用',
    String(retryInbox.channel?.reason).includes('凭据不可用'),
    JSON.stringify(retryInbox.channel),
  )
  check(
    'P1：启动失败后已排下一次重试（retryInMs>0）',
    Number.isFinite(retryInbox.channel?.retryInMs) && retryInbox.channel.retryInMs > 0,
    JSON.stringify(retryInbox.channel),
  )
  check(
    'P1：启动失败态 lockHolder 为空（锁已释放）',
    retryInbox.channel?.lockHolder === null,
    JSON.stringify(retryInbox.channel),
  )
  check(
    'P1：启动失败后释放实例锁（instance.lock 不存在）',
    !existsSync(join(retryDir, 'instance.lock')),
    JSON.stringify(await readFile(join(retryDir, 'plugin.log'), 'utf8').then((text) => text.slice(-300))),
  )
  const retryDoctor = JSON.parse(await retryCtx.__tools.get('mail_doctor').execute({}, exec))
  const retryDoctorNames = retryDoctor.checks.map((entry) => entry.name)
  check(
    'P1：mail_doctor（启动失败态）含「实例锁」「日志」',
    retryDoctorNames.includes('实例锁') && retryDoctorNames.includes('日志'),
    JSON.stringify(retryDoctorNames),
  )
  check(
    'P1：mail_doctor 实例锁写明未持有锁',
    String(retryDoctor.checks.find((entry) => entry.name === '实例锁')?.detail).includes('未持有锁'),
    JSON.stringify(retryDoctor.checks.find((entry) => entry.name === '实例锁')),
  )
  check(
    'P1：mail_doctor 收信连接带重试次数与下次时间',
    String(retryDoctor.checks.find((entry) => entry.name === '收信连接')?.detail).includes('已试 1 次'),
    JSON.stringify(retryDoctor.checks.find((entry) => entry.name === '收信连接')),
  )
  const retryLog = await readFile(join(retryDir, 'plugin.log'), 'utf8')
  check('P1：启动失败在 plugin.log 留重试行', retryLog.includes('收信启动失败（第 1 次'), retryLog.slice(-500))
  retryCtx.__dispose()
  await rm(retryDir, { recursive: true, force: true })
  await rm(p1Dir, { recursive: true, force: true })

  // ── P4：中性默认值（不显式传地址 = 安全默认不可用）──
  // DEFAULTS 已去个人化：ownerAddress / selfAddress 空串、别名空、fromName 空。
  // 不配置地址时收件人解析为空、唤醒找不到主人地址——这是有意的安全默认，
  // 本机地址只应来自 profile 的 cordis.patch.yml。
  const neutralDir = join(tmpdir(), `dsh-mail-channel-neutral-test-${process.pid}`)
  await rm(neutralDir, { recursive: true, force: true })
  await mkdir(join(neutralDir, '待办'), { recursive: true })
  const neutralCtx = makeCtx()
  const neutralPlugin = apply(neutralCtx, {
    mailDir: neutralDir,
    pollSeconds: 3600,
    notifyOnStart: false,
    receive: false,
  })
  check(
    'P4：不传地址时默认值为空（owner/self/别名/fromName）',
    neutralPlugin.config.ownerAddress === '' &&
      neutralPlugin.config.selfAddress === '' &&
      neutralPlugin.config.ownerAliases.length === 0 &&
      neutralPlugin.config.selfAliases.length === 0 &&
      neutralPlugin.config.fromName === '',
    JSON.stringify({
      ownerAddress: neutralPlugin.config.ownerAddress,
      selfAddress: neutralPlugin.config.selfAddress,
      ownerAliases: neutralPlugin.config.ownerAliases,
      fromName: neutralPlugin.config.fromName,
    }),
  )
  const neutralDoctor = JSON.parse(await neutralCtx.__tools.get('mail_doctor').execute({}, exec))
  check(
    'P4：未配置地址时自检「地址配置」不通过（安全默认）',
    neutralDoctor.checks.find((item) => item.name === '地址配置')?.ok === false,
    JSON.stringify(neutralDoctor.checks.find((item) => item.name === '地址配置')),
  )
  const neutralSend = JSON.parse(
    await neutralCtx.__tools.get('mail_send').execute({ subject: 'P4 测试', body: '正文' }, exec),
  )
  check(
    'P4：未配置主人地址时 mail_send 拒绝（收件人解析后为空）',
    neutralSend.ok === false && String(neutralSend.error).includes('收件人'),
    JSON.stringify(neutralSend),
  )
  neutralCtx.__dispose()
  await rm(neutralDir, { recursive: true, force: true })

  // ── P5：mail_setup 首次配置（settings.json + 凭据服务 + 立即生效）──
  console.log('\n== P5：mail_setup 首次配置 ==')
  const setupDir = join(tmpdir(), `dsh-mail-channel-setup-${process.pid}`)
  await rm(setupDir, { recursive: true, force: true })
  await mkdir(setupDir, { recursive: true })
  const setupSettings = join(setupDir, 'settings.json')
  setSettingsFile(setupSettings)
  const stored = new Map()
  const fakeCredentials = {
    async set(ref, value) {
      stored.set(ref, value)
    },
    async resolve(ref) {
      return stored.has(ref) ? { value: stored.get(ref) } : undefined
    },
  }
  const setupCtx = makeCtx({ credentials: fakeCredentials })
  const setupPlugin = apply(setupCtx, { mailDir: setupDir, pollSeconds: 3600, notifyOnStart: false, receive: false })
  const setupSchema = setupCtx.__tools.get('mail_setup')?.parameters
  check('P5：mail_setup 已注册且必填 owner/self', setupSchema !== undefined && setupSchema.required.includes('ownerAddress') && setupSchema.required.includes('selfAddress'))
  const setupExec = { agent: { session: { id: 'session-setup' } } }
  const setup = JSON.parse(
    await setupCtx.__tools.get('mail_setup').execute(
      {
        ownerAddress: 'me@example.com',
        selfAddress: 'agent@example.com',
        ownerAliases: ['me-alias@example.com'],
        selfAliases: ['agent-alias@example.com'],
        fromName: '我的助手',
        password: 'super-secret-code',
        account: 'agent@example.com',
      },
      setupExec,
    ),
  )
  check('P5：mail_setup 成功并指向 settings.json', setup.ok === true && String(setup.settingsFile).endsWith('settings.json'), JSON.stringify(setup).slice(0, 200))
  const savedSettings = readSettings(join(setupDir, 'settings.json'))
  check('P5：地址写入 settings.json', savedSettings.ownerAddress === 'me@example.com' && savedSettings.selfAddress === 'agent@example.com', JSON.stringify(savedSettings))
  check('P5：别名/署名写入 settings.json', JSON.stringify(savedSettings.ownerAliases) === '["me-alias@example.com"]' && savedSettings.fromName === '我的助手')
  check('P5：密码写入 DSH 凭据服务', stored.get('MAIL_CHANNEL_PASSWORD') === 'super-secret-code' && stored.get('MAIL_CHANNEL_USER') === 'agent@example.com')
  check('P5：密码不落 settings.json / 不回显', savedSettings.password === undefined && !JSON.stringify(setup).includes('super-secret-code'))
  check('P5：地址立即生效（config 被更新）', setupPlugin.config.ownerAddress === 'me@example.com' && setupPlugin.config.selfAddress === 'agent@example.com')
  check('P5：receive=false 时不做重连', setup.receiving?.reason === 'receive=false', JSON.stringify(setup.receiving))
  const setupGate = setupCtx.__listeners.find((item) => item.event === 'tools/pre-execute')?.fn
  const gateOwner = await setupGate(
    { name: 'mail_send', arguments: { subject: 'x', body: 'y', to: ['me@example.com'] }, agent: { session: { id: 'session-setup' } } },
    () => ({ kind: 'sentinel' }),
  )
  check('P5：配置后向主人发信放行（动态 owner）', gateOwner.kind === 'sentinel', JSON.stringify(gateOwner))
  const gateStranger = await setupGate(
    { name: 'mail_send', arguments: { subject: 'x', body: 'y', to: ['stranger@example.com'] }, agent: { session: { id: 'session-setup' } } },
    () => ({ kind: 'sentinel' }),
  )
  check('P5：配置后陌生人仍被拒（confirm + 无审批）', gateStranger.kind === 'deny', JSON.stringify(gateStranger))
  const setupPromptSection = setupCtx.__sections.find((section) => section.name === 'mail-channel')
  const promptNow = typeof setupPromptSection?.text === 'function' ? setupPromptSection.text({}) : setupPromptSection?.text
  check('P5：协议提示动态反映新地址', typeof promptNow === 'string' && promptNow.includes('me@example.com'), String(promptNow).slice(0, 160))
  const badSetup = JSON.parse(
    await setupCtx.__tools.get('mail_setup').execute({ ownerAddress: 'not-an-email', selfAddress: 'agent@example.com' }, setupExec),
  )
  check('P5：非法 ownerAddress 被拒且不改配置', badSetup.ok === false && readSettings(join(setupDir, 'settings.json')).ownerAddress === 'me@example.com')
  setupCtx.__dispose()
  await rm(setupDir, { recursive: true, force: true }).catch(() => {
    /* Windows 上 watcher 句柄释放有延迟：临时目录删不掉不影响结论 */
  })

  // 启动时合并 settings.json（新用户不碰 yaml）；profile patch 仍优先
  const mergeDir = join(tmpdir(), `dsh-mail-channel-merge-${process.pid}`)
  await rm(mergeDir, { recursive: true, force: true })
  await mkdir(mergeDir, { recursive: true })
  setSettingsFile(join(mergeDir, 'settings.json'))
  await writeSettings({ ownerAddress: 'cfg-owner@example.com', selfAddress: 'cfg-agent@example.com' })
  const mergeCtx = makeCtx()
  const mergePlugin = apply(mergeCtx, { mailDir: mergeDir, pollSeconds: 3600, notifyOnStart: false, receive: false })
  check('P5：启动时合并 settings.json（不需要 yaml）', mergePlugin.config.ownerAddress === 'cfg-owner@example.com' && mergePlugin.config.selfAddress === 'cfg-agent@example.com')
  const mergePatchCtx = makeCtx()
  const mergePatchPlugin = apply(mergePatchCtx, { ...FIXTURE, mailDir: mergeDir, pollSeconds: 3600, notifyOnStart: false, receive: false })
  check('P5：profile patch config 仍优先于 settings.json', mergePatchPlugin.config.ownerAddress === OWNER, mergePatchPlugin.config.ownerAddress)
  mergeCtx.__dispose()
  mergePatchCtx.__dispose()
  await rm(mergeDir, { recursive: true, force: true }).catch(() => {
    /* 同上：临时目录清理失败不影响断言 */
  })
  setSettingsFile(join(mailDir, 'settings.json'))

  ctx.__dispose()
  await rm(mailDir, { recursive: true, force: true })

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('harness 崩了：', error)
  process.exitCode = 1
  process.exit(1)
})
