/**
 * 日志轮转单测 —— 纯本地文件，不碰网络。
 *
 *   node test/rotate.test.mjs
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendWithRotation, readRotated } from '../lib/rotate.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'mail-rotate-'))
  roots.push(dir)
  return dir
}

async function readText(file) {
  return readFile(file, 'utf8')
}

// ── 未超阈值：不轮转 ──
const dir1 = await freshDir()
const log1 = join(dir1, 'plugin.log')
const small = await appendWithRotation(log1, 'a'.repeat(100), { maxBytes: 1024 })
check('首次追加不轮转', small.rotated === false)
check('文件被创建且内容完整', (await readText(log1)) === 'a'.repeat(100))
check('没有生成 file.1', existsSync(`${log1}.1`) === false)
const second = await appendWithRotation(log1, 'b'.repeat(50), { maxBytes: 1024 })
check('累计仍未超阈值 → 不轮转', second.rotated === false)
check('两次追加都在同一个文件里', (await readText(log1)) === `${'a'.repeat(100)}${'b'.repeat(50)}`)

// ── 超阈值：轮转并保留 keep 份 ──
// maxBytes=10，每段 4 字节：第 3、5、7 次写入前会超阈值
const dir2 = await freshDir()
const log2 = join(dir2, 'plugin.log')
const segments = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF', 'GGGG']
const results = []
for (const segment of segments) {
  results.push(await appendWithRotation(log2, segment, { maxBytes: 10, keep: 2 }))
}
check(
  '只有超阈值的那几次轮转',
  results.map((item) => item.rotated).join(',') === 'false,false,true,false,true,false,true',
  results.map((item) => item.rotated).join(','),
)
check('当前文件只剩最新一段', (await readText(log2)) === 'GGGG')
check('file.1 是上一段', (await readText(`${log2}.1`)) === 'EEEEFFFF')
check('file.2 是保留的最早一段', (await readText(`${log2}.2`)) === 'CCCCDDDD')
check('只保留 keep(=2) 份历史（file.3 不存在）', existsSync(`${log2}.3`) === false)
check('更早的分片（AAAABBBB）按 keep 淘汰', !existsSync(`${log2}.3`))
check(
  'readRotated 旧 → 新顺序拼回',
  (await readRotated(log2, { keep: 2 })) === 'CCCCDDDDEEEEFFFFGGGG',
  await readRotated(log2, { keep: 2 }),
)
check('readRotated 默认 keep=2', (await readRotated(log2)) === 'CCCCDDDDEEEEFFFFGGGG')

// ── readRotated：缺分片跳过 / 完全不存在返回空串 ──
const dir3 = await freshDir()
const log3 = join(dir3, 'send.log')
await writeFile(log3, 'newest', 'utf8')
check('只有当前文件时 readRotated 返回它', (await readRotated(log3, { keep: 2 })) === 'newest')
check('日志完全不存在时返回空串', (await readRotated(join(dir3, 'no-such.log'))) === '')

// ── 自定义 keep=3 ──
const dir4 = await freshDir()
const log4 = join(dir4, 'plugin.log')
for (const segment of ['1111', '2222', '3333', '4444', '5555', '6666']) {
  await appendWithRotation(log4, segment, { maxBytes: 5, keep: 3 })
}
check('keep=3：当前文件', (await readText(log4)) === '6666')
check('keep=3：file.1', (await readText(`${log4}.1`)) === '5555')
check('keep=3：file.2', (await readText(`${log4}.2`)) === '4444')
check('keep=3：file.3', (await readText(`${log4}.3`)) === '3333')
check('keep=3：file.4 不存在', existsSync(`${log4}.4`) === false)
check(
  'keep=3：readRotated 顺序',
  (await readRotated(log4, { keep: 3 })) === '3333444455556666',
  await readRotated(log4, { keep: 3 }),
)

// ── keep<=1 边界：不留历史 ──
const dir5 = await freshDir()
const log5 = join(dir5, 'plugin.log')
await writeFile(log5, '历史内容', 'utf8')
const keep0 = await appendWithRotation(log5, '新', { maxBytes: 10, keep: 0 })
check('keep=0 触发轮转', keep0.rotated === true)
check('keep=0 不保留历史（只剩新内容）', (await readText(log5)) === '新')
check('keep=0 没有生成 file.1', existsSync(`${log5}.1`) === false)
check('keep=0 时 readRotated 只读当前文件', (await readRotated(log5, { keep: 0 })) === '新')

const dir6 = await freshDir()
const log6 = join(dir6, 'plugin.log')
await writeFile(log6, '旧日志', 'utf8')
await writeFile(`${log6}.1`, '上一代', 'utf8')
const keep1 = await appendWithRotation(log6, '新的', { maxBytes: 10, keep: 1 })
check('keep=1 触发轮转', keep1.rotated === true)
check('keep=1 不保留历史（只剩新内容）', (await readText(log6)) === '新的')
check('keep=1 顺手清掉上一代分片', existsSync(`${log6}.1`) === false)

// ── 轮转失败降级：直接追加，不抛 ──
// 用"同名目录占住 file.2"制造轮转失败：unlink 目录在 Windows/Linux 都会报错。
// 比只读目录可移植（Windows 上普通用户对 ACL 之外难造不可写目录）。
const dir7 = await freshDir()
const log7 = join(dir7, 'plugin.log')
await writeFile(log7, '0123456789', 'utf8')
await mkdir(`${log7}.2`)
await writeFile(join(`${log7}.2`, '占位'), 'x', 'utf8')
const degraded = await appendWithRotation(log7, 'HELLO', { maxBytes: 10, keep: 2 })
check('轮转失败降级：rotated=false', degraded.rotated === false)
check('降级后内容仍追加成功', (await readText(log7)) === '0123456789HELLO')
check('降级不动原有分片（目录还在）', existsSync(`${log7}.2`))

// ── 目标目录不存在：静默返回，不抛 ──
const dir8 = await freshDir()
const silent = await appendWithRotation(join(dir8, 'no-such-dir', 'x.log'), 'x')
check('目录不存在时静默返回 {rotated:false}', silent.rotated === false)

// ── 多字节字符按 UTF-8 字节数计阈值 ──
const dir9 = await freshDir()
const log9 = join(dir9, 'send.log')
const multibyte = await appendWithRotation(log9, '中文中文', { maxBytes: 10 })
check('空文件不轮转（哪怕单条就超阈值）', multibyte.rotated === false)
check('中文按 UTF-8 字节数统计', (await stat(log9)).size === 12, String((await stat(log9)).size))
const multibyte2 = await appendWithRotation(log9, '中文', { maxBytes: 10 })
check('再次写入超阈值 → 轮转', multibyte2.rotated === true)
check('多字节轮转分片正确', (await readText(`${log9}.1`)) === '中文中文')

// ── Buffer 也能追加 ──
const dir10 = await freshDir()
const log10 = join(dir10, 'send.log')
await appendWithRotation(log10, Buffer.from('BUF', 'utf8'))
check('支持 Buffer 追加', (await readText(log10)) === 'BUF')

// ── 收尾 ──
for (const dir of roots) {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
console.log(failures === 0 ? '\n日志轮转全部通过 ✅' : `\n日志轮转失败 ${failures} 项 ❌`)
process.exitCode = failures === 0 ? 0 : 1
