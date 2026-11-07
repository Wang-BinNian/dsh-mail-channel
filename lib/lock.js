/**
 * 单实例锁 —— mailDir 根下的 `instance.lock`，用 pid + 心跳表示"谁是收信进程"。
 *
 * 两个进程（例如重启时旧的 DSH 还没退干净）共用同一个 mailDir 会抢邮件、双倍
 * 登录，所以收信循环启动前先拿锁。判定刻意宽松：锁文件读不出来、心跳过期、
 * pid 已经不在了，都视为陈旧可接管；反过来 `process.kill(pid, 0)` 抛出 EPERM
 * 或其它看不懂的异常时按"还活着"处理 —— 宁可多等一轮，也别把正在跑的进程踢掉
 * （契约见 notes/p1-spec.md §2.3）。
 *
 * 全部 IO 都是 best-effort：拿锁失败只是 `{ok:false, reason:'error'}`，心跳与释放
 * 静默失败，绝不把异常抛给收信循环（只有参数非法才抛 TypeError）。
 */
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

export const LOCK_FILE = 'instance.lock'

/** 本机名；取不到就留空（判活时退回"只按心跳判断"）。 */
function safeHostname() {
  try {
    return hostname()
  } catch {
    return ''
  }
}

/** 一条全新的锁记录：文件名、字段都保持 ASCII，方便旧工具读。 */
function freshRecord() {
  const now = new Date().toISOString()
  return { version: 1, pid: process.pid, host: safeHostname(), startedAt: now, heartbeatAt: now }
}

/**
 * 读锁文件并解析；不存在、坏 JSON、内容不是对象，一律返回 null。
 * 调用方拿到 null 就按"陈旧锁可接管"处理 —— 这正是坏锁不该卡死插件的原因。
 */
async function readLockFile(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/** 对外暴露的 holder 形状（pid 非法时保留 null，便于日志直接打印）。 */
function toHolder(record) {
  if (record === null || typeof record !== 'object') return null
  return {
    pid: Number.isInteger(record.pid) ? record.pid : null,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    heartbeatAt: typeof record.heartbeatAt === 'string' ? record.heartbeatAt : '',
    host: typeof record.host === 'string' ? record.host : '',
  }
}

/**
 * 进程是否还在：signal 0 只做存在性检查，不真的发信号。
 * ESRCH=不存在；EPERM=存在但没权限；其它异常按"在"处理，避免误接管。
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

/**
 * 现有 holder 是否还活着。
 * 加了 host 判断：锁文件在共享目录上时，别拿本机的 pid 去误判另一台机器的进程。
 */
function judgeHolder(record, { staleMs, now, host }) {
  const sameHost = record.host === '' || host === '' || record.host === host
  if (sameHost && !pidAlive(record.pid)) return { alive: false, reason: 'pid 不存在' }
  const stamp = Date.parse(String(record.heartbeatAt ?? ''))
  if (!Number.isFinite(stamp)) return { alive: false, reason: '心跳时间无法解析' }
  if (now - stamp > staleMs) return { alive: false, reason: '心跳超时' }
  return { alive: true, reason: 'ok' }
}

/** 先写临时文件再改名，读方不会看到半个 JSON；改名失败退回直接覆盖写。 */
async function writeLockFile(file, record) {
  const body = JSON.stringify(record, null, 2)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, file)
  } catch {
    try {
      await unlink(tmp)
    } catch {
      /* 临时文件可能压根没建起来 */
    }
    // 某些网络盘不支持 rename 覆盖已有文件，退回普通写（非原子，但比拿不到锁强）
    await writeFile(file, body, 'utf8')
  }
}

/** 组装给调用方的 lock 句柄；heartbeat/release 都只动自己的锁。 */
function buildLock(file, record) {
  const mine = { ...record }
  return {
    file,
    pid: mine.pid,
    startedAt: mine.startedAt,
    /** 刷新心跳（保留 startedAt）。锁已被别人接管时不动别人的文件。 */
    async heartbeat() {
      try {
        const current = await readLockFile(file)
        if (current !== null && current.pid !== mine.pid) return
        mine.heartbeatAt = new Date().toISOString()
        await writeLockFile(file, mine)
      } catch {
        /* 心跳失败由下一次调用或 staleMs 兜底，不打断收信 */
      }
    },
    /** 只删自己的锁：文件里的 pid 已经不是自己就跳过，别误删新持有者。 */
    async release() {
      try {
        const current = await readLockFile(file)
        if (current === null || current.pid !== mine.pid) return
        await unlink(file)
      } catch {
        /* 删不掉就留给心跳超时兜底 */
      }
    },
    /** 读当前锁文件内容（mail_doctor 调试用）；读不到返回 null。 */
    async read() {
      return readLockFile(file)
    },
  }
}

/**
 * 接管陈旧锁：覆盖写自己的记录，再回读复盘。
 * 并发接管时只有一个赢家 —— 文件里不是本进程的 pid 就按"没抢到"返回 held。
 */
async function takeOver(file, record, holder) {
  try {
    await writeLockFile(file, record)
  } catch {
    return { ok: false, holder, reason: 'error' }
  }
  const check = await readLockFile(file)
  if (check !== null && check.pid !== record.pid) {
    return { ok: false, holder: toHolder(check), reason: 'held' }
  }
  const lock = buildLock(file, record)
  if (holder !== null) lock.tookOverFrom = holder
  return { ok: true, lock }
}

/**
 * 取得 mailDir 单实例锁。
 *
 * @param {string} mailDir 插件数据目录（锁文件就放在它根下）
 * @param {{staleMs?:number, now?:number}} [options] staleMs 心跳超时（毫秒），now 便于测试注入
 * @returns {Promise<{ok:true, lock:object} | {ok:false, holder:object|null, reason:'held'|'error'}>}
 */
export async function acquireInstanceLock(mailDir, { staleMs = 10 * 60_000, now = Date.now() } = {}) {
  if (typeof mailDir !== 'string' || mailDir === '') throw new TypeError('mailDir 必须是非空字符串')
  if (!Number.isFinite(staleMs) || staleMs < 0) throw new TypeError('staleMs 必须是非负数字')

  const file = join(mailDir, LOCK_FILE)
  const record = freshRecord()

  // 先抢一次：flag 'wx' 是"不存在才创建"，天然互斥，也避免先读后写被别人插队。
  try {
    await writeFile(file, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' })
    return { ok: true, lock: buildLock(file, record) }
  } catch (error) {
    if (error?.code !== 'EEXIST') return { ok: false, holder: null, reason: 'error' }
  }

  // 已存在：判断是"占用中"还是"陈旧可接管"。
  const existing = await readLockFile(file)
  const holder = toHolder(existing)
  if (existing === null) return takeOver(file, record, null) // 读不到/坏 JSON：按陈旧处理

  const verdict = judgeHolder(existing, { staleMs, now, host: record.host })
  if (verdict.alive) return { ok: false, holder, reason: 'held' }
  return takeOver(file, record, holder)
}
