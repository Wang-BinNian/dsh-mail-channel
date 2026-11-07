/**
 * 安全原语单测（P0）—— 只验证纯函数与令牌账本，不连网、不发信。
 *
 *   node test/security.test.mjs
 *
 * 覆盖：senderAddress / addressAllowed / evaluateSend 三策略 /
 *       sameSecret / matchPassphrase / findWakeToken / 令牌签发-校验-核销-过期。
 * 契约见 notes/p0-spec.md（§1 配置、§2 发信门、§3 唤醒门、§5 测试契约）。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  activeTokens,
  addressAllowed,
  checkWakeToken,
  consumeWakeToken,
  evaluateSend,
  findWakeToken,
  issueWakeToken,
  matchPassphrase,
  readWakeTokens,
  sameSecret,
  senderAddress,
} from '../lib/security.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  [OK] ${label}`)
    return
  }
  failures += 1
  console.log(`  [!!] ${label} ${detail}`)
}

const OWNER = 'owner@example.com'
const ALIAS = 'owner-alias@example.com'

async function main() {
  const mailDir = join(tmpdir(), `dsh-mail-channel-security-test-${process.pid}`)
  await rm(mailDir, { recursive: true, force: true })
  await mkdir(mailDir, { recursive: true })

  // ── senderAddress：从任意 From 头里取 addr-spec ──
  check('senderAddress：Name <addr> 取尖括号内', senderAddress('">王" <owner@example.com>') === OWNER, senderAddress('"Owner" <owner@example.com>'))
  check('senderAddress：裸地址', senderAddress(OWNER) === OWNER)
  check('senderAddress：大写归一成小写', senderAddress('owner@example.com') === OWNER)
  check('senderAddress：前后空白被忽略', senderAddress('  \t owner@example.com \r\n ') === OWNER)
  check('senderAddress：a@example.com (name) 取地址', senderAddress('a@example.com (Wang)') === 'a@example.com', senderAddress('a@example.com (Wang)'))
  check('senderAddress：尖括号无显示名', senderAddress('<a@example.com>') === 'a@example.com')
  check('senderAddress：显示名与地址之间无空格', senderAddress('王<a@example.com>') === 'a@example.com')
  check('senderAddress：寄生域名不是主人', senderAddress('owner@example.com.evil.com') === 'owner@example.com.evil.com')
  check('senderAddress：寄生域名 != 主人', senderAddress('owner@example.com.evil.com') !== OWNER)
  check(
    'senderAddress：显示名里带主人地址但真实地址是 evil 时取 evil',
    senderAddress('"owner@example.com" <evil@example.com>') === 'evil@example.com',
    senderAddress('"owner@example.com" <evil@example.com>'),
  )
  check('senderAddress：显示名里的主人地址不算主人', senderAddress('"owner@example.com" <evil@example.com>') !== OWNER)
  check('senderAddress：非法串返回空', senderAddress('not an address') === '')
  check('senderAddress：空串返回空', senderAddress('') === '')
  check('senderAddress：null 返回空', senderAddress(null) === '')

  // ── addressAllowed：精确集合，不含子串/后缀匹配 ──
  check('addressAllowed：大小写不敏感命中', addressAllowed('owner@example.com', [OWNER]) === true)
  check('addressAllowed：允许集合里写 Name <addr> 也认', addressAllowed('a@example.com', ['"X" <a@example.com>']) === true)
  check('addressAllowed：别名在集合里命中', addressAllowed(ALIAS, [OWNER, ALIAS]) === true)
  check('addressAllowed：寄生域名不命中', addressAllowed('owner@example.com.evil.com', [OWNER]) === false)
  check('addressAllowed：显示名伪装的 evil 不命中', addressAllowed('"owner@example.com" <evil@example.com>', [OWNER]) === false)
  check('addressAllowed：空允许集合 = 不许', addressAllowed(OWNER, []) === false)
  check('addressAllowed：非法地址一律 false', addressAllowed('not-an-address', [OWNER]) === false)

  // ── evaluateSend：三策略 × 全白名单 / 部分 / 空 / 非法 ──
  const all = evaluateSend({ recipients: [OWNER], allowed: [OWNER, ALIAS], policy: 'confirm' })
  check('evaluateSend：全在白名单 → allow（confirm 档）', all.decision === 'allow', JSON.stringify(all))
  check('evaluateSend：全在白名单 → allow（owner-only 档）', evaluateSend({ recipients: [ALIAS], allowed: [OWNER, ALIAS], policy: 'owner-only' }).decision === 'allow')
  check('evaluateSend：全在白名单 → allow 且无警告（open 档）', evaluateSend({ recipients: [OWNER], allowed: [OWNER], policy: 'open' }).warning !== true)

  const partial = ['someone@example.com']
  const partialConfirm = evaluateSend({ recipients: partial, allowed: [OWNER], policy: 'confirm' })
  check('evaluateSend：陌生收件人 → confirm', partialConfirm.decision === 'confirm', JSON.stringify(partialConfirm))
  check('evaluateSend：confirm 列出 outsiders', partialConfirm.outsiders.join(',') === 'someone@example.com', JSON.stringify(partialConfirm))

  const partialOwnerOnly = evaluateSend({ recipients: partial, allowed: [OWNER], policy: 'owner-only' })
  check('evaluateSend：owner-only 档 → deny', partialOwnerOnly.decision === 'deny', JSON.stringify(partialOwnerOnly))
  check('evaluateSend：owner-only 的 reason 含收件人', String(partialOwnerOnly.reason).includes('someone@example.com'), partialOwnerOnly.reason)

  const partialOpen = evaluateSend({ recipients: partial, allowed: [OWNER], policy: 'open' })
  check('evaluateSend：open 档 → allow 且 warning=true', partialOpen.decision === 'allow' && partialOpen.warning === true, JSON.stringify(partialOpen))
  check('evaluateSend：open 档仍列出 outsiders', partialOpen.outsiders.join(',') === 'someone@example.com')

  check('evaluateSend：收件人为空 → deny', evaluateSend({ recipients: [], allowed: [OWNER], policy: 'confirm' }).decision === 'deny')
  check('evaluateSend：全部非法 → deny', evaluateSend({ recipients: ['bad@', 'not-an-address'], allowed: [OWNER], policy: 'open' }).decision === 'deny')
  check(
    'evaluateSend：混入非法地址整封拒绝',
    evaluateSend({ recipients: [OWNER, 'bad@'], allowed: [OWNER], policy: 'open' }).decision === 'deny',
  )
  check('evaluateSend：非法地址 reason 标"不合法"', String(evaluateSend({ recipients: ['bad@'], allowed: [] }).reason).includes('不合法'))

  const mixed = evaluateSend({ recipients: [OWNER, 'x@example.org'], allowed: [OWNER, 'x@example.org'], policy: 'confirm' })
  check('evaluateSend：白名单大小写不敏感 → allow', mixed.decision === 'allow', JSON.stringify(mixed))
  check('evaluateSend：省略 policy 默认 confirm', evaluateSend({ recipients: ['x@example.org'], allowed: [] }).decision === 'confirm')
  check('evaluateSend：默认空参数也算收件人为空', evaluateSend().decision === 'deny')

  // ── sameSecret：常量时间比较 ──
  check('sameSecret：相同 → true', sameSecret('S3CR3T', 'S3CR3T') === true)
  check('sameSecret：不同 → false', sameSecret('S3CR3T', 's3cr3t') === false)
  check('sameSecret：空 vs 空 → true', sameSecret('', '') === true)

  // ── matchPassphrase：口令必须单独占一行，大小写敏感，空=关 ──
  check('matchPassphrase：单独一行命中', matchPassphrase({ text: '你好\nS3CR3T\n再见' }, 'S3CR3T') === true)
  check('matchPassphrase：子串不算', matchPassphrase({ text: '前缀S3CR3T后缀' }, 'S3CR3T') === false)
  check('matchPassphrase：行首尾空白被忽略', matchPassphrase({ text: 'first\n   S3CR3T  \nlast' }, 'S3CR3T') === true)
  check('matchPassphrase：CRLF 分行', matchPassphrase({ text: 'a\r\nS3CR3T\r\nb' }, 'S3CR3T') === true)
  check('matchPassphrase：主题里单独一行也认', matchPassphrase({ subject: '请求\nS3CR3T' }, 'S3CR3T') === true)
  check('matchPassphrase：html 字段里单独一行也认', matchPassphrase({ html: '<p>\nS3CR3T\n</p>' }, 'S3CR3T') === true)
  check('matchPassphrase：大小写敏感', matchPassphrase({ text: 's3cr3t' }, 'S3CR3T') === false)
  check('matchPassphrase：空口令 = 关闭，永不命中', matchPassphrase({ text: 'S3CR3T' }, '') === false)
  check('matchPassphrase：record 为空不崩', matchPassphrase(null, 'S3CR3T') === false)

  // ── findWakeToken：主题 → 正文 → html，取第一个；大小写归一 ──
  check('findWakeToken：主题里的 [wake:…]', findWakeToken({ subject: '回信 [wake:ABCDEF0123456789]' }) === 'ABCDEF0123456789')
  check('findWakeToken：正文里的 #wake:…', findWakeToken({ text: '内容 #wake:ABCDEF0123456789 尾巴' }) === 'ABCDEF0123456789')
  check('findWakeToken：html 里的令牌', findWakeToken({ html: '<p>[wake:ABCDEF0123456789]</p>' }) === 'ABCDEF0123456789')
  check('findWakeToken：小写令牌归一成大写', findWakeToken({ subject: '[wake:abcdef0123456789]' }) === 'ABCDEF0123456789')
  check('findWakeToken：主题优先于正文', findWakeToken({ subject: '[wake:1111111111111111]', text: '[wake:2222222222222222]' }) === '1111111111111111')
  check('findWakeToken：没有令牌返回空', findWakeToken({ subject: '普通信', text: '正文' }) === '')
  check('findWakeToken：太短的令牌不算', findWakeToken({ subject: '[wake:ABC]' }) === '')
  check('findWakeToken：record 为空返回空', findWakeToken(null) === '')

  // ── 令牌账本：签发 → 校验 → 核销 → 过期 ──
  const now = Date.now()
  const token = await issueWakeToken(mailDir, { ttlMinutes: 60, subject: '通知', now })
  check('令牌：16 位大写十六进制', /^[0-9A-F]{16}$/.test(token), token)
  const store = await readWakeTokens(mailDir)
  check('令牌：落盘到 wake-tokens.json', store.tokens.some((entry) => entry.token === token))
  const issued = store.tokens.find((entry) => entry.token === token)
  check('令牌：TTL 60 分钟', Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt) === 60 * 60_000)

  const verdictOk = checkWakeToken(store, token, { now })
  check('令牌：未用过未过期 → ok', verdictOk.ok === true, JSON.stringify(verdictOk))
  check('令牌：小写引用也能校验', checkWakeToken(store, token.toLowerCase(), { now }).ok === true)
  check('令牌：未知令牌 → unknown', checkWakeToken(store, 'FFFFFFFFFFFFFFFF', { now }).reason === 'unknown')
  check('令牌：空令牌 → missing', checkWakeToken(store, '', { now }).reason === 'missing')

  const consumed = await consumeWakeToken(mailDir, token.toLowerCase(), { now: now + 1000 })
  check('令牌：核销返回 ok', consumed.ok === true, JSON.stringify(consumed))
  const afterConsume = await readWakeTokens(mailDir)
  check('令牌：核销写 usedAt', afterConsume.tokens.find((entry) => entry.token === token)?.usedAt !== '')
  check('令牌：用过再校验 → used', checkWakeToken(afterConsume, token, { now: now + 2000 }).reason === 'used')
  check('令牌：用过再核销也 → used', (await consumeWakeToken(mailDir, token, { now: now + 2000 })).reason === 'used')

  const expired = await issueWakeToken(mailDir, { ttlMinutes: 1, now: now - 10 * 60_000 })
  const expiredVerdict = checkWakeToken(await readWakeTokens(mailDir), expired, { now })
  check('令牌：过期 → expired', expiredVerdict.ok === false && expiredVerdict.reason === 'expired', JSON.stringify(expiredVerdict))
  const expiredConsume = await consumeWakeToken(mailDir, expired, { now })
  check('令牌：过期令牌核销失败', expiredConsume.ok === false && expiredConsume.reason === 'expired')
  const expiredStore = await readWakeTokens(mailDir)
  check('令牌：过期令牌不写 usedAt', expiredStore.tokens.find((entry) => entry.token === expired)?.usedAt === '')

  const defaultTtl = await issueWakeToken(mailDir, { subject: '默认 TTL' })
  const defaultEntry = (await readWakeTokens(mailDir)).tokens.find((entry) => entry.token === defaultTtl)
  check(
    '令牌：默认 TTL 120 分钟',
    Date.parse(defaultEntry.expiresAt) - Date.parse(defaultEntry.issuedAt) === 120 * 60_000,
    defaultEntry?.expiresAt,
  )
  const badTtl = await issueWakeToken(mailDir, { ttlMinutes: 0 })
  const badEntry = (await readWakeTokens(mailDir)).tokens.find((entry) => entry.token === badTtl)
  check(
    '令牌：非法 TTL 回落到 120 分钟',
    Date.parse(badEntry.expiresAt) - Date.parse(badEntry.issuedAt) === 120 * 60_000,
  )

  const active = activeTokens(await readWakeTokens(mailDir), { now })
  check(
    '令牌：activeTokens 只算未用过且未过期',
    active.length === 2 && !active.some((entry) => entry.token === token || entry.token === expired),
    `实际 ${active.length} 个：${active.map((entry) => entry.token).join(',')}`,
  )

  // 账本：坏文件/不存在当空账本，不抛错
  const emptyDir = join(mailDir, 'empty-subdir')
  await mkdir(emptyDir, { recursive: true })
  check('令牌：没有账本文件 → 空账本', (await readWakeTokens(emptyDir)).tokens.length === 0)
  await writeFile(join(emptyDir, 'wake-tokens.json'), '{坏掉的 JSON', 'utf8')
  check('令牌：坏账本不抛错，按空处理', (await readWakeTokens(emptyDir)).tokens.length === 0)

  // 账本：最多保留最近 50 条
  const pruneDir = join(mailDir, 'prune-subdir')
  await mkdir(pruneDir, { recursive: true })
  const latest = []
  for (let index = 0; index < 55; index += 1) latest.push(await issueWakeToken(pruneDir, { ttlMinutes: 120 }))
  const prunedStore = await readWakeTokens(pruneDir)
  check('令牌：账本最多 50 条', prunedStore.tokens.length === 50, `实际 ${prunedStore.tokens.length}`)
  check('令牌：剪枝保留最新签发', prunedStore.tokens.at(-1)?.token === latest.at(-1))
  check('令牌：剪枝丢掉最旧签发', !prunedStore.tokens.some((entry) => entry.token === latest[0]))

  await rm(mailDir, { recursive: true, force: true })
  console.log(failures === 0 ? '\n安全原语全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('security.test 崩了：', error)
  process.exitCode = 1
})
