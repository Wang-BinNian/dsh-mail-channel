/**
 * MIME 编解码单测 —— 只验证纯函数，不碰网络。
 *
 *   node test/mime.test.mjs
 */
import { buildMail, decodeQuotedPrintable, decodeWords, encodeWord, parseMail } from '../lib/mime.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  [OK] ${label}`)
  else {
    failures += 1
    console.log(`  [!!] ${label} ${detail}`)
  }
}

// ── RFC 2047 ──
check('ASCII 头原样', encodeWord('hello') === 'hello')
const word = encodeWord('邮件通道')
check('中文头被编码', word.startsWith('=?UTF-8?B?') && word.endsWith('?='), word)
check('中文头往返', decodeWords(word) === '邮件通道', decodeWords(word))
const longSubject = '这是一封很长的主题：残差收敛到 1e-6，网格 200 万，下一步加密到 400 万并复算'
const encodedLong = encodeWord(longSubject)
check('长主题切成多个编码词', encodedLong.split('=?UTF-8?B?').length > 2, String(encodedLong.split(' ').length))
check('长主题往返一致', decodeWords(encodedLong) === longSubject, decodeWords(encodedLong))
check(
  '相邻编码词之间的空白被丢弃',
  decodeWords('=?UTF-8?B?5Lit?= =?UTF-8?B?5paH?=') === '中文',
  decodeWords('=?UTF-8?B?5Lit?= =?UTF-8?B?5paH?='),
)

// 回归：按字节切块会把多字节字符劈成两半（实测主题里的"北"变乱码）
const realSubject = '邮件通道状态报告（2026-10-20 22:18 北京时间）'
check('长中文主题往返（含数字与全角括号）', decodeWords(encodeWord(realSubject)) === realSubject, decodeWords(encodeWord(realSubject)))
const straddle = 'a一二三四五六七八九十一二三四五'
check('45 字节边界不在字符中间切', decodeWords(encodeWord(straddle)) === straddle, decodeWords(encodeWord(straddle)))

// ── quoted-printable ──
check('QP 解 =XX', decodeQuotedPrintable('=E4=B8=AD=E6=96=87').toString('utf8') === '中文')
check('QP 去软换行', decodeQuotedPrintable('abc=\r\ndef').toString('latin1') === 'abcdef')

// ── 组包 → 拆包往返 ──
const attachment = Buffer.from('PNG-FAKE-BYTES-0123456789', 'utf8')
const raw = buildMail({
  from: 'agent@example.com',
  fromName: 'Test Agent',
  to: ['owner@example.com'],
  subject: longSubject,
  text: '第一行\n第二行：收到请回信。',
  html: '<p>收到请回信。</p>',
  attachments: [{ name: '残差图.png', data: attachment }],
})

const parsed = parseMail(raw)
check('主题往返', parsed.subject === longSubject, parsed.subject)
check('发件人含署名', parsed.from.includes('Test Agent') && parsed.from.includes('agent@example.com'), parsed.from)
check('收件人', parsed.to.includes('owner@example.com'), parsed.to)
check('纯文本正文', parsed.text === '第一行\n第二行：收到请回信。', JSON.stringify(parsed.text))
check('HTML 正文', parsed.html === '<p>收到请回信。</p>', parsed.html)
check('附件数量', parsed.attachments.length === 1, JSON.stringify(parsed.attachments.map((a) => a.name)))
check('附件名中文往返', parsed.attachments[0]?.name === '残差图.png', parsed.attachments[0]?.name)
check('附件字节一致', parsed.attachments[0]?.data.equals(attachment))
check('附件类型按扩展名', parsed.attachments[0]?.type === 'image/png', parsed.attachments[0]?.type)

// ── 外部来信（GB2312 + QP） ──
const gbMail = [
  'From: =?gb2312?B?zfWxvsTq?= <old@example.com>',
  'To: agent@example.com',
  'Subject: =?gb2312?B?suLK1A==?=',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=gb2312',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '=CA=D5=B5=BD=C7=EB=BB=D8=D0=C5',
].join('\r\n')
const gbParsed = parseMail(gbMail)
check('GB2312 正文解码', gbParsed.text.includes('收到请回信'), gbParsed.text)
check('GB2312 主题解码非空', gbParsed.subject.length > 0, gbParsed.subject)

console.log(failures === 0 ? '\nMIME 全部通过 ✅' : `\nMIME 失败 ${failures} 项 ❌`)
process.exitCode = failures === 0 ? 0 : 1
