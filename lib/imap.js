/**
 * 极简 IMAP 客户端 —— 够用就行：登录、选信箱、按 UID 找信、PEEK 取信、NOOP 保活。
 *
 * 关键点：FETCH 的响应里带 `{n}` 字面量，后面紧跟 n 个**二进制**字节，
 * 所以读缓冲必须是 Buffer，不能先当字符串处理。
 *
 * 只用 BODY.PEEK[]（不设 \Seen），因为收信不该改变邮箱的已读状态。
 */
import net from 'node:net'
import tls from 'node:tls'

const DEFAULT_TIMEOUT = 60_000

class ImapConnection {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.waiter = null
    this.failure = null
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.wake()
    })
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('IMAP 连接已关闭')))
  }

  fail(error) {
    this.failure = this.failure ?? error
    this.wake()
  }

  wake() {
    if (this.waiter !== null) {
      const { resolve } = this.waiter
      this.waiter = null
      resolve()
    }
  }

  async wait() {
    if (this.failure !== null) throw this.failure
    await new Promise((resolve) => {
      this.waiter = { resolve }
    })
    if (this.failure !== null) throw this.failure
  }

  async nextLine() {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline >= 0) {
        let line = this.buffer.subarray(0, newline)
        this.buffer = this.buffer.subarray(newline + 1)
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
        return line.toString('latin1')
      }
      await this.wait()
    }
  }

  async nextBytes(count) {
    while (this.buffer.length < count) await this.wait()
    const data = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return data
  }

  /** 读到带本标签的结果行为止；字面量单独收集，不混进行文本。 */
  async readTagged(tag) {
    const lines = []
    const literals = []
    for (;;) {
      const line = await this.nextLine()
      const literal = /\{(\d+)\}$/.exec(line)
      if (literal !== null) {
        lines.push(line)
        literals.push(await this.nextBytes(Number(literal[1])))
        continue
      }
      lines.push(line)
      if (line.startsWith(`${tag} `)) {
        return { status: line.split(' ')[1] ?? '', lines, literals, text: lines.join('\n') }
      }
    }
  }

  write(text) {
    this.socket.write(`${text}\r\n`)
  }

  destroy() {
    this.socket.destroy()
  }
}

function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export class ImapClient {
  #connection
  #tag = 0

  constructor(socket) {
    this.#connection = new ImapConnection(socket)
  }

  async #run(command, { okOnly = true } = {}) {
    this.#tag += 1
    const tag = `A${String(this.#tag).padStart(4, '0')}`
    this.#connection.write(`${tag} ${command}`)
    const response = await this.#connection.readTagged(tag)
    if (okOnly && response.status !== 'OK') {
      throw new Error(`IMAP ${response.status}：${response.text.split('\n').slice(-1)[0]}`)
    }
    return response
  }

  /** 建立 TLS 连接并 LOGIN。 */
  static async connect({ host, port = 993, user, pass, timeoutMs = DEFAULT_TIMEOUT }) {
    const socket = await new Promise((resolve, reject) => {
      const secure = tls.connect({ host, port, servername: host })
      secure.setTimeout(timeoutMs, () => secure.destroy(new Error('IMAP 连接超时')))
      secure.once('secureConnect', () => resolve(secure))
      secure.once('error', reject)
    })
    const client = new ImapClient(socket)
    const greeting = await client.#connection.nextLine()
    if (!greeting.startsWith('* OK')) throw new Error(`IMAP 欢迎语异常：${greeting}`)
    await client.#run(`LOGIN ${quote(user)} ${quote(pass)}`)
    return client
  }

  async select(mailbox = 'INBOX') {
    const response = await this.#run(`SELECT ${mailbox}`)
    const matched = /\[?(\d+)\]?\s+EXISTS/i.exec(response.text) ?? /\*\s+(\d+)\s+EXISTS/i.exec(response.text)
    return { exists: matched === null ? 0 : Number(matched[1]) }
  }

  /** 通用 UID SEARCH：criteria 是 IMAP 搜索表达式（不含 "UID SEARCH" 前缀）。 */
  async uidSearch(criteria) {
    const response = await this.#run(`UID SEARCH ${criteria}`)
    const line = response.lines.find((item) => /^\* SEARCH/i.test(item))
    if (line === undefined) return []
    const numbers = line.replace(/^\* SEARCH/i, '').trim()
    if (numbers === '') return []
    // 契约要求升序；服务商通常已经按升序返回，这里再兜一次底。
    return numbers
      .split(/\s+/)
      .map(Number)
      .filter(Number.isSafeInteger)
      .sort((left, right) => left - right)
  }

  /** 返回全部 UID（升序）。 */
  async uidSearchAll() {
    return this.uidSearch('ALL')
  }

  /** 取一封完整信（PEEK，不置已读）。 */
  async uidFetch(uid) {
    const response = await this.#run(`UID FETCH ${uid} (BODY.PEEK[])`)
    if (response.literals.length === 0) throw new Error(`IMAP 没取到 uid=${uid} 的正文`)
    return response.literals[0]
  }

  async noop() {
    await this.#run('NOOP')
  }

  async logout() {
    try {
      await this.#run('LOGOUT')
    } catch {
      /* 关闭阶段的错误无所谓 */
    }
    this.#connection.destroy()
  }

  close() {
    this.#connection.destroy()
  }
}

/** 便利函数：连上、跑一段逻辑、一定关掉。 */
export async function withImap(options, run) {
  const client = await ImapClient.connect(options)
  try {
    return await run(client)
  } finally {
    client.close()
  }
}
