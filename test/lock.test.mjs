/**
 * 单实例锁单测 —— 纯本地文件，不碰网络。
 *
 *   node test/lock.test.mjs
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInstanceLock, LOCK_FILE } from '../lib/lock.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  [OK] ${label}`)
  else {
    failures += 1
    console.log(`  [!!] ${label} ${detail}`)
  }
}

const roots = []
async function freshDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mail-lock-'))
  roots.push(dir)
  return dir
}

/** 死 pid：999999 远大于测试机上可能出现的进程号，极不可能真的存在。 */
const DEAD_PID = 999999
const HOST = hostname()

/** 构造一条手写锁记录（模拟"另一个进程写的锁"）。 */
function lockRecord({ pid, heartbeatAt, startedAt = heartbeatAt, version = 1 }) {
  return { version, pid, host: HOST, startedAt, heartbeatAt }
}

async function writeRawLock(dir, record) {
  await writeFile(join(dir, LOCK_FILE), JSON.stringify(record), 'utf8')
}

async function readRawLock(dir) {
  return JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8'))
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString()
}

// ── 首次获取 ──
const dir1 = await freshDir()
const first = await acquireInstanceLock(dir1)
check('首获成功', first.ok === true, JSON.stringify(first))
check(
  '返回 lock 句柄（file/pid/startedAt/heartbeat/release/read）',
  typeof first.lock?.file === 'string' &&
    first.lock?.pid === process.pid &&
    typeof first.lock?.startedAt === 'string' &&
    typeof first.lock?.heartbeat === 'function' &&
    typeof first.lock?.release === 'function' &&
    typeof first.lock?.read === 'function',
)
check('锁文件落在 mailDir 根', first.lock?.file === join(dir1, LOCK_FILE) && existsSync(first.lock.file))
const raw1 = await readRawLock(dir1)
check(
  '锁文件字段齐全',
  raw1.version === 1 && raw1.pid === process.pid && typeof raw1.host === 'string',
  JSON.stringify(raw1),
)
check(
  '时间字段是可解析的 ISO',
  Number.isFinite(Date.parse(raw1.startedAt)) && Number.isFinite(Date.parse(raw1.heartbeatAt)),
  JSON.stringify(raw1),
)
check('read() 返回当前记录', (await first.lock.read())?.pid === process.pid)

// ── 同一 mailDir 第二次获取 → held ──
const second = await acquireInstanceLock(dir1)
check('第二次 held', second.ok === false && second.reason === 'held', JSON.stringify(second))
check('held 时带 holder', second.holder?.pid === process.pid && second.holder?.host === HOST)

// ── 心跳 ──
const beforeBeat = await readRawLock(dir1)
await new Promise((resolve) => setTimeout(resolve, 15))
await first.lock.heartbeat()
const afterBeat = await readRawLock(dir1)
check(
  'heartbeat 刷新 heartbeatAt',
  Date.parse(afterBeat.heartbeatAt) > Date.parse(beforeBeat.heartbeatAt),
  `${beforeBeat.heartbeatAt} -> ${afterBeat.heartbeatAt}`,
)
check('heartbeat 保留 startedAt', afterBeat.startedAt === beforeBeat.startedAt)
check('heartbeat 后仍是本进程持有', afterBeat.pid === process.pid)

// ── 释放 ──
await first.lock.release()
check('release 删除自己的锁文件', existsSync(join(dir1, LOCK_FILE)) === false)
const reacquired = await acquireInstanceLock(dir1)
check('release 后可再次获取', reacquired.ok === true)
await reacquired.lock.release()

// ── release / heartbeat 只动自己的锁 ──
const dir2 = await freshDir()
const holderA = await acquireInstanceLock(dir2)
// 模拟"另一个进程"已经接管：手写锁文件，pid 用死 pid
const otherRecord = lockRecord({ pid: DEAD_PID, heartbeatAt: isoAgo(1000) })
await writeRawLock(dir2, otherRecord)
await holderA.lock.release()
check('release 不删别人的锁', existsSync(join(dir2, LOCK_FILE)))
const keptAfterRelease = await readRawLock(dir2)
check('别人的锁内容未被 release 改动', keptAfterRelease.pid === DEAD_PID)
await holderA.lock.heartbeat()
const keptAfterBeat = await readRawLock(dir2)
check(
  'heartbeat 不覆盖别人的锁',
  keptAfterBeat.pid === DEAD_PID && keptAfterBeat.heartbeatAt === otherRecord.heartbeatAt,
  JSON.stringify(keptAfterBeat),
)

// ── 陈旧接管 1：心跳过期（pid 还是活着的本进程） ──
const dir3 = await freshDir()
await writeRawLock(dir3, lockRecord({ pid: process.pid, heartbeatAt: isoAgo(11 * 60_000) }))
const heartbeatStale = await acquireInstanceLock(dir3)
check('心跳过期 → 接管成功', heartbeatStale.ok === true, JSON.stringify(heartbeatStale))
check('接管记录 tookOverFrom', heartbeatStale.lock?.tookOverFrom?.pid === process.pid)
const raw3 = await readRawLock(dir3)
check('接管后文件归本进程', raw3.pid === process.pid && Number.isFinite(Date.parse(raw3.heartbeatAt)))

// ── 陈旧接管 2：pid 不存在（心跳还新鲜） ──
const dir4 = await freshDir()
await writeRawLock(dir4, lockRecord({ pid: DEAD_PID, heartbeatAt: isoAgo(0) }))
const pidStale = await acquireInstanceLock(dir4)
check('pid 不存在 → 接管成功', pidStale.ok === true, JSON.stringify(pidStale))
check('tookOverFrom 记录死 pid', pidStale.lock?.tookOverFrom?.pid === DEAD_PID)
check('接管后锁文件 pid 是本进程', (await readRawLock(dir4)).pid === process.pid)

// ── 陈旧接管 3：坏 JSON / 空文件 ──
const dir5 = await freshDir()
await writeFile(join(dir5, LOCK_FILE), '{ 这不是 JSON', 'utf8')
const badJson = await acquireInstanceLock(dir5)
check('坏 JSON → 接管成功', badJson.ok === true, JSON.stringify(badJson))
check('坏 JSON 没有 tookOverFrom', badJson.lock?.tookOverFrom === undefined)

const dir6 = await freshDir()
await writeFile(join(dir6, LOCK_FILE), '', 'utf8')
check('空锁文件 → 接管成功', (await acquireInstanceLock(dir6)).ok === true)

// ── now / staleMs 注入 ──
const dir7 = await freshDir()
await writeRawLock(dir7, lockRecord({ pid: process.pid, heartbeatAt: isoAgo(0) }))
const freshHeld = await acquireInstanceLock(dir7)
check('心跳新鲜 + pid 存活 → 占用中', freshHeld.ok === false && freshHeld.reason === 'held')
const logicalFuture = await acquireInstanceLock(dir7, { now: Date.now() + 11 * 60_000 })
check('now 注入：逻辑时间跨过 staleMs → 接管', logicalFuture.ok === true)

const dir8 = await freshDir()
await writeRawLock(dir8, lockRecord({ pid: process.pid, heartbeatAt: isoAgo(500) }))
const customStale = await acquireInstanceLock(dir8, { staleMs: 100 })
check('staleMs 自定义：100ms 前的心跳即视为陈旧', customStale.ok === true)

// ── 两次接管链（两个 pid 字段值模拟两个进程先后持有） ──
const dir9 = await freshDir()
await writeRawLock(dir9, lockRecord({ pid: DEAD_PID, heartbeatAt: isoAgo(0) }))
const takeover1 = await acquireInstanceLock(dir9)
check('接管链：先接管 pid=999999', takeover1.ok === true && takeover1.lock?.tookOverFrom?.pid === DEAD_PID)
await writeRawLock(dir9, lockRecord({ pid: DEAD_PID + 1, heartbeatAt: isoAgo(0) }))
const takeover2 = await acquireInstanceLock(dir9)
check(
  '接管链：再接管 pid=1000000',
  takeover2.ok === true && takeover2.lock?.tookOverFrom?.pid === DEAD_PID + 1,
  JSON.stringify(takeover2),
)

// ── IO 失败：reason:'error'，不抛 ──
const blockerDir = await freshDir()
const blocker = join(blockerDir, 'not-a-dir')
await writeFile(blocker, 'x', 'utf8')
const broken = await acquireInstanceLock(blocker)
check('mailDir 不可写 → {ok:false, reason:"error"}', broken.ok === false && broken.reason === 'error', JSON.stringify(broken))

// ── EPERM/其它异常按"存活"处理，不误接管 ──
// 真实场景里拿不到权限的进程（另一用户的进程 / 系统进程）不该被当成死了；
// 这里直接临时替换 process.kill 来精确模拟，比找一个真 EPERM 的 pid 可移植。
const dir10 = await freshDir()
await writeRawLock(dir10, lockRecord({ pid: DEAD_PID, heartbeatAt: isoAgo(0) }))
const realKill = process.kill
process.kill = () => {
  const error = new Error('operation not permitted')
  error.code = 'EPERM'
  throw error
}
const permissionHeld = await acquireInstanceLock(dir10)
process.kill = realKill
check(
  'EPERM → 视为存活 → held（不误接管）',
  permissionHeld.ok === false && permissionHeld.reason === 'held',
  JSON.stringify(permissionHeld),
)

// ── 参数非法才允许抛 ──
let threwTypeError = false
try {
  await acquireInstanceLock(null)
} catch {
  threwTypeError = true
}
check('mailDir 非法 → 抛 TypeError（只有参数错误才抛）', threwTypeError)

// ── 收尾 ──
for (const dir of roots) {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
console.log(failures === 0 ? '\n单实例锁全部通过 ✅' : `\n单实例锁失败 ${failures} 项 ❌`)
process.exitCode = failures === 0 ? 0 : 1
