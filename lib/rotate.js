/**
 * 日志轮转 —— plugin.log / send.log 只增不减迟早把磁盘吃光，按大小分片（P1-5）。
 *
 * 规则（契约见 notes/p1-spec.md §2.4）：追加前先看大小，写进去会超过 maxBytes
 * 就先把当前文件挪成 `file.1`、`file.i` 挪成 `file.(i+1)`，只保留 keep 份历史
 * （keep=2 → 留 file.1、file.2）；出任何 IO 问题就退回"直接追加"，日志不能反过来
 * 把业务搞挂。`readRotated` 按"旧 → 新"把分片拼回去，给 mail_history / mail_doctor
 * 读历史用（旧行不丢）。
 *
 * 边界：keep<=1 视为"不留历史" —— 轮转时直接清空当前文件并删掉上一代分片，
 * 这样 keep=0 与 keep=1 的行为一致且自洽。
 */
import { appendFile, readFile, rename, stat, unlink } from 'node:fs/promises'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_KEEP = 2

/** 阈值/份数兜底：传了非法值就退回默认，别让日志调用方为参数发愁。 */
function normalizeBytes(value, fallback = DEFAULT_MAX_BYTES) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function normalizeKeep(value, fallback = DEFAULT_KEEP) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

/** 只有"文件不存在"可以忽略；其它错误抛给上层决定是否降级。 */
function ignoreMissing(error) {
  if (error?.code !== 'ENOENT') throw error
}

/** 文件大小；不存在算 0，其它错误抛给调用方。 */
async function sizeOf(file) {
  try {
    return (await stat(file)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

/** 轮转分片；任何一步失败都会抛给 appendWithRotation 去降级。 */
async function rotate(file, keep) {
  if (keep <= 1) {
    // 不留历史：当前文件直接清掉（append 会重新创建），上一代分片一并删除
    await unlink(file).catch(ignoreMissing)
    await unlink(`${file}.1`).catch(ignoreMissing)
    return
  }
  await unlink(`${file}.${keep}`).catch(ignoreMissing) // 最老的一份让位
  for (let index = keep - 1; index >= 1; index -= 1) {
    await rename(`${file}.${index}`, `${file}.${index + 1}`).catch(ignoreMissing)
  }
  await rename(file, `${file}.1`).catch(ignoreMissing)
}

/**
 * 追加写；写进去会超过 maxBytes 时先轮转。
 *
 * @param {string} file 日志文件路径
 * @param {string|Buffer} data 要追加的内容
 * @param {{maxBytes?:number, keep?:number}} [options] maxBytes 阈值（默认 5 MB），keep 保留份数（默认 2）
 * @returns {Promise<{rotated:boolean}>} rotated 表示本次追加前是否真的轮转过
 */
export async function appendWithRotation(file, data, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
  const payload = typeof data === 'string' || Buffer.isBuffer(data) ? data : String(data ?? '')
  const limit = normalizeBytes(maxBytes)
  const keepCount = normalizeKeep(keep)
  const bytes = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, 'utf8')

  let rotated = false
  try {
    const size = await sizeOf(file)
    // 空文件轮转没有意义；只有"写进去会超阈值"才先分片
    if (size > 0 && size + bytes > limit) {
      await rotate(file, keepCount)
      rotated = true
    }
  } catch {
    rotated = false // 轮转失败/权限问题：降级为直接追加，不抛
  }

  try {
    if (Buffer.isBuffer(payload)) await appendFile(file, payload)
    else await appendFile(file, payload, 'utf8')
  } catch {
    /* 日志写不进去就算了；调用方不该因为写日志失败而中断 */
    return { rotated }
  }
  return { rotated }
}

/** 读一个分片；不存在/读不到返回 null（readRotated 里跳过即可）。 */
async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 按时间顺序读轮转后的所有分片：`file.keep … file.1, file`（旧 → 新）。
 * 缺失的分片跳过；一个都读不到就返回空串。
 *
 * @param {string} file 当前日志文件路径
 * @param {{keep?:number}} [options] keep 最多往前读几代（默认 2）
 * @returns {Promise<string>}
 */
export async function readRotated(file, { keep = DEFAULT_KEEP } = {}) {
  const keepCount = normalizeKeep(keep)
  const parts = []
  for (let index = keepCount; index >= 1; index -= 1) {
    const piece = await readIfExists(`${file}.${index}`)
    if (piece !== null) parts.push(piece)
  }
  const head = await readIfExists(file)
  if (head !== null) parts.push(head)
  return parts.join('')
}
