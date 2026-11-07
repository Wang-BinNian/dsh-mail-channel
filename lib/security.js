/**
 * 安全原语 —— 地址规范化、发信策略判定、唤醒身份校验、一次性回信令牌。
 *
 * 两条独立的门（P0）：
 *
 *   1) 发信门：`mail_send` 只对"主人地址 ∪ allowedRecipients"直接放行；其余按
 *      sendPolicy 处理（owner-only 直接拒 / confirm 交宿主审批 / open 放行并留警告）。
 *      纯判定放在 `evaluateSend()`，审批动作留在宿主侧（index.js），这样离线可测。
 *
 *   2) 唤醒门：SMTP 的 From 可以伪造，所以"是不是主人"必须按 addr-spec **精确**匹配。
 *      旧实现是 `from.includes(address)` 子串匹配，`owner@example.com.evil.com` 和
 *      `"owner@example.com" <evil@example.com>` 都能混进来。需要更强保证时开
 *      `wakeAuth='token'`：每封去信带一次性 `[wake:…]` 令牌，回信必须带上、未过期、
 *      未用过，才允许唤醒；"新写一封信"走可选的静态口令 `wakePassphrase`。
 *
 * 令牌落 `wake-tokens.json`（与队列同目录，ASCII 字段，便于直接看）。单实例假设与
 * 插件其它部分一致：两个进程共用一个 mailDir 会抢令牌，不做跨进程锁。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const TOKENS_FILE = 'wake-tokens.json'
const MAX_TOKENS = 50
const TOKEN_BRACKET = /\[wake:([A-Za-z0-9]{6,64})\]/i
const TOKEN_HASH = /#wake:([A-Za-z0-9]{6,64})\b/i

/**
 * 从任意地址串里取 addr-spec（小写）。
 * - `Name <owner@example.com>` / `<owner@example.com>` → `owner@example.com`
 * - `owner@example.com (name)` / 裸地址 → 第一个邮箱 token
 * - 取不到返回 ''（**宁可拒绝，不要猜**；'' 永远不匹配任何白名单）
 */
export function senderAddress(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  const angled = /<\s*([^<>]+?)\s*>/.exec(text)
  const source = (angled ? angled[1] : text).toLowerCase()
  const hit = /[^\s<>@,;]+@[^\s<>@,;]+/.exec(source)
  return hit ? hit[0].toLowerCase() : ''
}

/** 地址是否在允许集合里（都先规范化；非法地址一律 false）。 */
export function addressAllowed(address, allowed = []) {
  const target = senderAddress(address)
  if (target === '') return false
  return allowed.some((item) => senderAddress(item) === target)
}

/**
 * 发信策略的纯判定（不审批、不发信）。
 * @returns {{decision:'allow'|'deny'|'confirm', outsiders:string[], reason?:string, warning?:boolean}}
 */
export function evaluateSend({ recipients = [], allowed = [], policy = 'confirm' } = {}) {
  const addresses = []
  for (const item of recipients) {
    const address = senderAddress(item)
    if (address === '') {
      return { decision: 'deny', outsiders: [], reason: `收件人地址不合法：${String(item ?? '').slice(0, 80)}` }
    }
    addresses.push(address)
  }
  if (addresses.length === 0) return { decision: 'deny', outsiders: [], reason: '收件人为空' }

  const allowedSet = new Set(allowed.map((item) => senderAddress(item)).filter(Boolean))
  const outsiders = addresses.filter((address) => !allowedSet.has(address))
  if (outsiders.length === 0) return { decision: 'allow', outsiders: [] }
  if (policy === 'open') return { decision: 'allow', outsiders, warning: true }
  if (policy === 'owner-only') {
    return {
      decision: 'deny',
      outsiders,
      reason: `收件人不在白名单：${outsiders.join('、')}（sendPolicy=owner-only）`,
    }
  }
  return { decision: 'confirm', outsiders }
}

/** 常量时间比较（先各自 sha256，长度固定，不泄漏原文长度差）。 */
export function sameSecret(left, right) {
  const a = createHash('sha256').update(String(left ?? '')).digest()
  const b = createHash('sha256').update(String(right ?? '')).digest()
  return timingSafeEqual(a, b)
}

/**
 * 记录里是否出现静态口令：口令必须**单独占一行**（前后空白忽略，大小写敏感），
 * 逐行做常量时间比较——不做子串搜索，避免在长正文里留下可测的时间差。
 * 空口令=关闭，永不命中。
 */
export function matchPassphrase(record, passphrase) {
  const secret = String(passphrase ?? '').trim()
  if (secret === '') return false
  for (const field of [record?.subject, record?.text, record?.body, record?.html]) {
    const text = String(field ?? '')
    if (text === '') continue
    for (const line of text.split(/\r?\n/)) {
      const candidate = line.trim()
      if (candidate !== '' && sameSecret(candidate, secret)) return true
    }
  }
  return false
}

/** 从信里找一次性令牌：主题 → 正文 → html，取第一个。返回大写规范化值或 ''。 */
export function findWakeToken(record) {
  for (const field of [record?.subject, record?.text, record?.body, record?.html]) {
    const text = String(field ?? '')
    if (text === '') continue
    const hit = TOKEN_BRACKET.exec(text) ?? TOKEN_HASH.exec(text)
    if (hit) return normalizeToken(hit[1])
  }
  return ''
}

export function normalizeToken(value) {
  return String(value ?? '').trim().toUpperCase()
}

function iso(time) {
  return new Date(time).toISOString()
}

/** 读令牌账本；文件坏了当空账本，不抛错（令牌只是增强，不该让插件挂掉）。 */
export async function readWakeTokens(mailDir) {
  try {
    const raw = await readFile(join(mailDir, TOKENS_FILE), 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    const tokens = Array.isArray(parsed.tokens) ? parsed.tokens : []
    return {
      version: 1,
      tokens: tokens.filter(
        (entry) =>
          typeof entry?.token === 'string' &&
          typeof entry?.issuedAt === 'string' &&
          typeof entry?.expiresAt === 'string',
      ),
    }
  } catch {
    return { version: 1, tokens: [] }
  }
}

async function writeWakeTokens(mailDir, store) {
  await writeFile(join(mailDir, TOKENS_FILE), JSON.stringify(store, null, 2), 'utf8')
}

/** 只留最近 MAX_TOKENS 条，并清掉 7 天前就过期的旧账。 */
function pruneTokens(tokens, now) {
  const cutoff = now - 7 * 24 * 3_600_000
  return tokens
    .filter((entry) => {
      const expires = Date.parse(entry.expiresAt)
      return Number.isFinite(expires) ? expires > cutoff : false
    })
    .slice(-MAX_TOKENS)
}

/** 发一封去信时签一个新令牌；返回令牌原文（调用方负责嵌进正文）。 */
export async function issueWakeToken(mailDir, { ttlMinutes = 120, subject = '', now = Date.now() } = {}) {
  const token = randomBytes(8).toString('hex').toUpperCase()
  const minutes = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 120
  const store = await readWakeTokens(mailDir)
  const record = {
    token,
    issuedAt: iso(now),
    expiresAt: iso(now + minutes * 60_000),
    subject: String(subject ?? '').slice(0, 120),
    usedAt: '',
  }
  store.tokens = pruneTokens([...store.tokens, record], now)
  await writeWakeTokens(mailDir, store)
  return token
}

/** 只读校验：未知 / 用过 / 过期 都返回原因，便于写日志。 */
export function checkWakeToken(store, token, { now = Date.now() } = {}) {
  const target = normalizeToken(token)
  if (target === '') return { ok: false, reason: 'missing' }
  const hit = (store.tokens ?? []).find((entry) => normalizeToken(entry.token) === target)
  if (hit === undefined) return { ok: false, reason: 'unknown' }
  if (hit.usedAt !== '') return { ok: false, reason: 'used' }
  const expires = Date.parse(hit.expiresAt)
  if (!Number.isFinite(expires) || expires <= now) return { ok: false, reason: 'expired' }
  return { ok: true, reason: 'ok', expiresAt: hit.expiresAt }
}

/** 一次性核销：校验通过后写 usedAt；返回 {ok, reason, expiresAt}。 */
export async function consumeWakeToken(mailDir, token, { now = Date.now() } = {}) {
  const store = await readWakeTokens(mailDir)
  const verdict = checkWakeToken(store, token, { now })
  if (!verdict.ok) return verdict
  const target = normalizeToken(token)
  const hit = store.tokens.find((entry) => normalizeToken(entry.token) === target)
  hit.usedAt = iso(now)
  store.tokens = pruneTokens(store.tokens, now)
  await writeWakeTokens(mailDir, store)
  return verdict
}

/** 当前有效令牌数（自检/状态摘要用，不返回令牌本身）。 */
export function activeTokens(store, { now = Date.now() } = {}) {
  return (store.tokens ?? []).filter((entry) => checkWakeToken(store, entry.token, { now }).ok)
}
