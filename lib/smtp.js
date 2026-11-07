/**
 * 极简 SMTP 客户端 —— 只用标准库，够发 QQ 邮箱这种主流服务。
 *
 * 策略沿用已经踩实的结论：587 + STARTTLS 为主，465 隐式 TLS 兜底；
 * 认证先 AUTH LOGIN（兼容面最广），服务器不认再退 AUTH PLAIN。
 */
import net from 'node:net'
import tls from 'node:tls'

const DEFAULT_TIMEOUT = 120_000

class SmtpConnection {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.pending = null
    this.failure = null
    socket.setEncoding('latin1')
    socket.on('data', (chunk) => {
      this.buffer += chunk
      this.pump()
    })
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('SMTP 连接已关闭')))
  }

  fail(error) {
    this.failure = this.failure ?? error
    if (this.pending !== null) {
      const { reject } = this.pending
      this.pending = null
      reject(this.failure)
    }
  }

  /** 服务器一次应答可能多行（250-…），收尾行形如 `250 xxx`。 */
  pump() {
    if (this.pending === null) return
    const collected = []
    let index = 0
    for (;;) {
      const newline = this.buffer.indexOf('\n', index)
      if (newline < 0) return
      let line = this.buffer.slice(index, newline)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      collected.push(line)
      index = newline + 1
      if (/^\d{3} /.test(line)) {
        this.buffer = this.buffer.slice(index)
        const { resolve } = this.pending
        this.pending = null
        resolve({ code: Number(line.slice(0, 3)), lines: collected })
        this.pump()
        return
      }
    }
  }

  read() {
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.pump()
    })
  }

  write(text) {
    this.socket.write(`${text}\r\n`)
  }

  async command(line, expect) {
    this.write(line)
    const response = await this.read()
    if (expect !== undefined && !expect.includes(response.code)) {
      throw new Error(`SMTP ${response.code} ${response.lines.join(' ')}（命令：${line.split(' ')[0]}）`)
    }
    return response
  }

  /** STARTTLS 前把底层 socket 的监听摘干净，避免升级后两个读端抢数据。 */
  detach() {
    this.socket.removeAllListeners('data')
    this.socket.removeAllListeners('error')
    this.socket.removeAllListeners('close')
    return this.socket
  }
}

function connectRaw(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP 连接超时')))
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function connectSecure(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host })
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP 连接超时')))
    socket.once('secureConnect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function base64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64')
}

async function authenticate(connection, user, pass) {
  const login = await connection.command('AUTH LOGIN', [334])
  void login
  await connection.command(base64(user), [334])
  await connection.command(base64(pass), [235])
}

async function deliver({ host, port, user, pass, from, to, message, timeoutMs, signal }) {
  const secureFromStart = port === 465
  let socket = secureFromStart
    ? await connectSecure(host, port, timeoutMs)
    : await connectRaw(host, port, timeoutMs)
  let connection = new SmtpConnection(socket)

  if (signal !== undefined) {
    const abort = () => socket.destroy(new Error('已取消'))
    if (signal.aborted) abort()
    signal.addEventListener('abort', abort, { once: true })
  }

  try {
    await connection.read() // 220 欢迎语
    await connection.command('EHLO mail-channel', [250])

    if (!secureFromStart) {
      await connection.command('STARTTLS', [220])
      const raw = connection.detach()
      const secure = tls.connect({ socket: raw, servername: host })
      await new Promise((resolve, reject) => {
        secure.once('secureConnect', resolve)
        secure.once('error', reject)
      })
      socket = secure
      connection = new SmtpConnection(secure)
      await connection.command('EHLO mail-channel', [250])
    }

    try {
      await authenticate(connection, user, pass)
    } catch (error) {
      // 服务器不认识 AUTH LOGIN 时退 PLAIN；密码错误不该重试。
      if (!/^SMTP (504|500)/.test(error.message)) throw error
      await connection.command(`AUTH PLAIN ${base64(`\u0000${user}\u0000${pass}`)}`, [235])
    }

    await connection.command(`MAIL FROM:<${from}>`, [250])
    for (const recipient of to) await connection.command(`RCPT TO:<${recipient}>`, [250, 251])
    await connection.command('DATA', [354])

    // 行首的 `.` 要变成 `..`，否则会被当成正文结束符。
    const body = message.toString('latin1').replace(/^\./gm, '..')
    connection.write(body.endsWith('\r\n') ? body : `${body}\r\n`)
    socket.write('.\r\n')
    const accepted = await connection.read()
    if (accepted.code !== 250) {
      throw new Error(`SMTP ${accepted.code} ${accepted.lines.join(' ')}（正文被拒）`)
    }

    connection.write('QUIT')
    return { ok: true, port: secureFromStart ? 465 : 587, ms: Date.now() }
  } finally {
    socket.destroy()
  }
}

/**
 * 发一封已经组好的信；587 失败时按 465 重试一次。
 * @returns {Promise<{ok:boolean, port:number, error?:string}>}
 */
export async function sendMail(options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const errors = []
  const ports = options.port ? [options.port] : [587, 465]
  for (const port of ports) {
    try {
      const started = Date.now()
      const result = await deliver({ ...options, port, timeoutMs })
      return { ok: true, port, ms: Date.now() - started }
    } catch (error) {
      errors.push(`${port}: ${error.name}: ${error.message}`)
    }
  }
  return { ok: false, port: 0, error: errors.join(' | ') }
}
