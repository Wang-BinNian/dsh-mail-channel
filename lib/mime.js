/**
 * MIME 组包与拆包 —— 不依赖任何第三方库。
 *
 * 只覆盖邮件通道真正会遇到的部分：纯文本/HTML 正文、附件、中文头、
 * base64 与 quoted-printable。遇到没见过的结构宁可少解析，也不抛异常。
 */
import { randomBytes } from 'node:crypto'

const CRLF = '\r\n'
const MAX_LINE = 76

/**
 * 非 ASCII 文本按 RFC 2047 编码；长串切块，避免单行超长被截。
 *
 * 必须按**字符**切，不能按字节切：一个中文字占 3 字节，按 45 字节硬切
 * 会把它劈成两半，两段各自 base64 后解码就变成乱码（2026-10-20 实测踩到，
 * 主题里的"北"字被劈坏）。
 */
export function encodeWord(text) {
  const value = String(text ?? '')
  if (/^[\x20-\x7E]*$/.test(value)) return value
  const chunks = []
  let current = ''
  let bytes = 0
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > 45 && current !== '') {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  if (current !== '') chunks.push(current)
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`).join(' ')
}

/** 解码 RFC 2047 编码词；相邻编码词之间的空白按规范丢弃。 */
export function decodeWords(value) {
  const text = String(value ?? '')
  if (!text.includes('=?')) return text
  return text.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)(\s+(?==\?))/g, '$1').replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, charset, encoding, payload) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return decodeCharset(Buffer.from(payload, 'base64'), charset)
        }
        return decodeCharset(decodeQuotedPrintable(payload.replace(/_/g, ' ')), charset)
      } catch {
        return match
      }
    },
  )
}

function normalizeCharset(charset) {
  const name = String(charset ?? 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (name === 'gb2312' || name === 'gbk' || name === 'x-gbk') return 'gb18030'
  if (name === 'us-ascii' || name === 'ascii') return 'utf-8'
  return name || 'utf-8'
}

function decodeCharset(buffer, charset) {
  try {
    return new TextDecoder(normalizeCharset(charset)).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/**
 * quoted-printable 解码，返回**字节**而不是字符串：正文的真实编码由
 * Content-Type 的 charset 决定，先当 latin1 字符串会毁掉多字节字符。
 */
export function decodeQuotedPrintable(text) {
  const joined = String(text ?? '').replace(/=\r?\n/g, '')
  const bytes = []
  for (let index = 0; index < joined.length; index += 1) {
    const char = joined[index]
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16))
      index += 2
    } else {
      bytes.push(joined.charCodeAt(index) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

function decodeTransfer(body, encoding) {
  const kind = String(encoding ?? '').trim().toLowerCase()
  if (kind === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64')
  if (kind === 'quoted-printable') return decodeQuotedPrintable(body)
  return Buffer.from(body, 'latin1')
}

/** 拆出头部与正文；头部按 RFC 5322 展开续行。 */
export function splitMessage(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')
  const text = buffer.toString('latin1')
  const index = text.indexOf(`${CRLF}${CRLF}`)
  const separator = index >= 0 ? index : text.indexOf('\n\n')
  if (separator < 0) return { headerText: text, body: '' }
  const headerText = text.slice(0, separator)
  const bodyStart = separator + (text.startsWith(`${CRLF}${CRLF}`, separator) ? 4 : 2)
  return { headerText, body: text.slice(bodyStart) }
}

export function parseHeaders(headerText) {
  const headers = Object.create(null)
  const unfolded = String(headerText ?? '').replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
  }
  return headers
}

/** 解析 `type/sub; key=value; key="quoted"`。 */
export function parseContentType(value) {
  const parts = String(value ?? '').split(';')
  const type = (parts.shift() ?? '').trim().toLowerCase() || 'text/plain'
  const params = {}
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    let val = part.slice(eq + 1).trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1')
    params[key] = val
  }
  return { type, params }
}

/** RFC 2231 的 `filename*=utf-8''%E4%B8%AD` 与编码词文件名都要认。 */
function decodeParam(params, base) {
  const extended = params[`${base}*`]
  if (extended) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(extended)
    if (match) return decodeCharset(Buffer.from(unescapePercent(match[2]), 'latin1'), match[1] || 'utf-8')
    return extended
  }
  const plain = params[base]
  return plain === undefined ? '' : decodeWords(plain)
}

function unescapePercent(text) {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

function boundaryOf(params) {
  return params.boundary ? params.boundary.replace(/^"|"$/g, '') : ''
}

/** 按 boundary 切分 multipart 正文（保留原始字节边界）。 */
function splitParts(body, boundary) {
  if (!boundary) return []
  const marker = `--${boundary}`
  const chunks = []
  let cursor = body.indexOf(marker)
  if (cursor < 0) return []
  while (cursor >= 0) {
    const next = body.indexOf(marker, cursor + marker.length)
    if (next < 0) break
    let piece = body.slice(cursor + marker.length, next)
    if (piece.startsWith('--')) break
    piece = piece.replace(/^\r?\n/, '')
    chunks.push(piece.replace(/\r?\n$/, ''))
    cursor = next
  }
  return chunks
}

/**
 * 把整封信拆成 { from, to, subject, date, text, html, attachments }。
 * 附件保留 Buffer（写不写盘、写哪里由调用方决定）。
 */
export function parseMail(raw) {
  const { headerText, body } = splitMessage(raw)
  const headers = parseHeaders(headerText)
  const result = {
    from: decodeWords(headers.from ?? ''),
    to: decodeWords(headers.to ?? ''),
    subject: decodeWords(headers.subject ?? ''),
    date: headers.date ?? '',
    messageId: headers['message-id'] ?? '',
    // 自家埋的自定义头：QQ 等会改写 Message-ID，用这个头做稳定定位（见 native.verifyWithClient）。
    xMailChannelId: headers['x-mail-channel-id'] ?? '',
    text: '',
    html: '',
    attachments: [],
  }

  const walk = (bodyText, partHeaders, depth) => {
    if (depth > 8) return
    const { type, params } = parseContentType(partHeaders['content-type'] ?? 'text/plain')
    const boundary = boundaryOf(params)
    if (type.startsWith('multipart/') && boundary !== '') {
      for (const part of splitParts(bodyText, boundary)) {
        const { headerText: partHeader, body: partBody } = splitMessage(part)
        walk(partBody, parseHeaders(partHeader), depth + 1)
      }
      return
    }

    const disposition = parseContentType(partHeaders['content-disposition'] ?? '')
    const filename = decodeParam(disposition.params, 'filename') || decodeParam(params, 'name') || ''
    const buffer = decodeTransfer(bodyText, partHeaders['content-transfer-encoding'] ?? '')
    if (filename !== '') {
      result.attachments.push({ name: filename, type, bytes: buffer.length, data: buffer })
      return
    }
    if (type === 'text/plain' && result.text === '') {
      result.text = decodeCharset(buffer, params.charset)
    } else if (type === 'text/html' && result.html === '') {
      result.html = decodeCharset(buffer, params.charset)
    }
  }

  walk(body, headers, 0)
  return result
}

function randomToken() {
  return randomBytes(9).toString('hex')
}

/** base64 正文按 76 字符折行。 */
function wrapBase64(buffer) {
  const encoded = buffer.toString('base64')
  const lines = []
  for (let offset = 0; offset < encoded.length; offset += MAX_LINE) {
    lines.push(encoded.slice(offset, offset + MAX_LINE))
  }
  return lines.join(CRLF)
}

const TYPE_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function guessContentType(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filename ?? ''))
  return (match && TYPE_BY_EXT[match[1].toLowerCase()]) || 'application/octet-stream'
}

/**
 * 组一封带正文与附件的信。
 * @param {object} mail - from/fromName/to/subject/text/html/attachments[{name,data}]
 * @returns {Buffer} 可直接写进 SMTP DATA 的原始邮件
 */
export function buildMail({
  from,
  fromName = '',
  to,
  subject,
  text = '',
  html = '',
  attachments = [],
  date = new Date(),
  messageId,
  extraHeaders = {},
}) {
  const mixed = `=_mixed_${randomToken()}`
  const alternative = `=_alt_${randomToken()}`
  const fromHeader = fromName === '' ? from : `${encodeWord(fromName)} <${from}>`
  const lines = [
    `From: ${fromHeader}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId ?? `${randomToken()}@mail-channel`}>`,
    // 自定义头放在 Message-ID 之后、MIME 头之前；QQ 会改写 Message-ID 但通常保留自定义头。
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    '',
    `--${alternative}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(text === '' ? '(无正文)' : text, 'utf8')),
    '',
  ]
  if (html !== '') {
    lines.push(
      `--${alternative}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(html, 'utf8')),
      '',
    )
  }
  lines.push(`--${alternative}--`, '')

  for (const attachment of attachments) {
    const name = String(attachment.name ?? 'attachment')
    const encodedName = /^[\x20-\x7E]*$/.test(name)
      ? name
      : `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`
    lines.push(
      `--${mixed}`,
      `Content-Type: ${guessContentType(name)}; name="${encodedName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodedName}"`,
      '',
      wrapBase64(attachment.data ?? Buffer.alloc(0)),
      '',
    )
  }
  lines.push(`--${mixed}--`, '')
  return Buffer.from(lines.join(CRLF), 'latin1')
}
