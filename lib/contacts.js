/**
 * 地址簿 —— 纯本地数据，不碰网络。
 *
 * 存在 `<mailDir>\contacts.json`，和队列放在一起，方便直接看、直接改。
 * 发信时可以把 `to` 写成 `@主人` 或 `主人的备注名`，插件负责换成地址。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { scanQueue } from './queue.js'

const CONTACTS_FILE = 'contacts.json'

/** 从 `"显示名" <owner@example.com>` 或裸地址里拆出显示名与地址。 */
export function parseAddress(value) {
  const text = String(value ?? '').trim()
  const angled = /<([^>]+)>/.exec(text)
  const address = (angled ? angled[1] : text).trim().toLowerCase()
  let name = angled ? text.slice(0, angled.index).trim() : ''
  name = name.replace(/^["']|["']$/g, '').trim()
  return { name, address }
}

export async function readContacts(mailDir) {
  try {
    const raw = await readFile(join(mailDir, CONTACTS_FILE), 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    const contacts = Array.isArray(parsed.contacts) ? parsed.contacts : []
    return {
      version: 1,
      contacts: contacts
        .filter((item) => typeof item?.address === 'string' && item.address.length > 0)
        .map((item) => ({
          name: typeof item.name === 'string' ? item.name : '',
          address: item.address.toLowerCase(),
          aliases: Array.isArray(item.aliases) ? item.aliases.filter((alias) => typeof alias === 'string') : [],
          note: typeof item.note === 'string' ? item.note : '',
          lastSeen: typeof item.lastSeen === 'string' ? item.lastSeen : '',
        })),
    }
  } catch {
    return { version: 1, contacts: [] }
  }
}

export async function writeContacts(mailDir, book) {
  await writeFile(join(mailDir, CONTACTS_FILE), JSON.stringify(book, null, 2), 'utf8')
}

/** 按地址、名字、别名、`@名字` 找联系人。 */
export function findContact(book, token) {
  const raw = String(token ?? '').trim()
  if (raw.length === 0) return undefined
  const bare = raw.startsWith('@') ? raw.slice(1) : raw
  const lowered = bare.toLowerCase()
  return book.contacts.find((contact) => {
    if (contact.address === lowered) return true
    if (contact.name && contact.name.toLowerCase() === lowered) return true
    return contact.aliases.some((alias) => alias.toLowerCase() === lowered)
  })
}

/** 解析一个收件人：能对上地址簿就换成地址，对不上原样返回（允许直接写地址）。 */
export function resolveRecipient(book, token) {
  const contact = findContact(book, token)
  return contact ? contact.address : String(token).trim()
}

export function resolveRecipients(book, tokens, owners = []) {
  const out = []
  for (const token of tokens) {
    const text = String(token ?? '').trim()
    if (text.length === 0) continue
    // 「主人」是一个概念而不是某个地址：两个主人地址这时候已经被收敛成一个。
    if (/^@?(主人|主人们|owners?)$/i.test(text) && owners.length > 0) {
      out.push(...owners)
      continue
    }
    out.push(resolveRecipient(book, text))
  }
  const seen = new Set()
  return out.filter((address) => {
    const key = address.toLowerCase()
    if (!address.includes('@') || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 新增或更新一个联系人；已存在的保留原有备注与别名，只补空字段。 */
export function upsertContact(book, { address, name, aliases, note, lastSeen }) {
  const parsed = parseAddress(address)
  if (parsed.address.length === 0) throw new Error('地址为空')
  let contact = book.contacts.find((item) => item.address === parsed.address)
  if (contact === undefined) {
    contact = { name: name || parsed.name || '', address: parsed.address, aliases: [], note: note || '', lastSeen: lastSeen || '' }
    book.contacts.push(contact)
  } else {
    if (!contact.name && (name || parsed.name)) contact.name = name || parsed.name
    if (note) contact.note = note
    if (lastSeen) contact.lastSeen = lastSeen
  }
  for (const alias of aliases ?? []) {
    const text = String(alias).trim()
    if (text && !contact.aliases.includes(text)) contact.aliases.push(text)
  }
  return contact
}

/**
 * 从已收到的信里学联系人（只补不覆盖）。
 *
 * `aliasMap` 把同一邮箱的多个地址收敛到一个：地址别名不会被单独记成另一个人，
 * 而是挂成规范地址的 alias —— 否则发信时会重复投递。
 *
 * @param {string} mailDir
 * @param {{owners?:string[], aliasMap?:Record<string,string>}|string[]} options
 * @returns {Promise<{added:number, updated:number, total:number}>}
 */
export async function learnContacts(mailDir, options = {}) {
  const opts = Array.isArray(options) ? { owners: options } : options
  const owners = opts.owners ?? []
  const aliasMap = opts.aliasMap ?? {}
  const book = await readContacts(mailDir)
  const before = book.contacts.length
  let updated = 0

  // 同一个地址会出现很多次（每一封来信）。**要取最新的日期**，不能取第一次见到的：
  // 归档按 UID 升序扫，第一次见到的恰好是最旧那封（2026-10-20 实测踩到）。
  const found = new Map()
  const remember = (value, date) => {
    const parsed = parseAddress(value)
    if (parsed.address.length === 0 || !parsed.address.includes('@')) return
    const canonical = aliasMap[parsed.address] ?? parsed.address
    const previous = found.get(canonical)
    found.set(canonical, {
      canonical,
      name: parsed.name || previous?.name || '',
      isOwner: owners.some((owner) => owner.toLowerCase() === canonical) || previous?.isOwner === true,
      date: date > (previous?.date ?? '') ? date : (previous?.date ?? ''),
      alias: canonical === parsed.address ? previous?.alias : parsed.address,
    })
  }

  for (const mail of await scanQueue(mailDir)) {
    const record = mail.record ?? {}
    const date = String(record.received_at ?? '').slice(0, 10)
    remember(record.from, date)
    for (const address of String(record.to ?? '').split(',')) remember(address, date)
  }

  // 归档里不一定两个主人地址都出现过，但 @主人 要能展开，所以补齐。
  for (const owner of owners) remember(owner, '')

  for (const entry of found.values()) {
    const existed = book.contacts.some((item) => item.address === entry.canonical)
    // 主人有两个地址，**不能都叫「主人」**：同名会让 @主人 静默只发其中一个。
    // 用显示名或地址前缀命名，主人身份记在 note 里。
    upsertContact(book, {
      address: entry.canonical,
      name: entry.name || entry.canonical.split('@')[0],
      note: entry.isOwner ? '主人' : '',
      lastSeen: entry.date,
      aliases: entry.alias === undefined ? [] : [entry.alias],
    })
    if (existed) updated += 1
  }

  book.contacts.sort((a, b) => (a.name || a.address).localeCompare(b.name || b.address))
  await writeContacts(mailDir, book)
  return { added: book.contacts.length - before, updated, total: book.contacts.length }
}
