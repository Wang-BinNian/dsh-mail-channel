/**
 * 插件自己的配置覆盖层 `settings.json`（放在 `$DSH_HOME/mail-channel/`）。
 *
 * 为什么需要它：DSH 第三方插件没有设置页，让第一次装插件的用户去手改
 * `~/.dsh/profiles/<profile>/cordis.patch.yml` 太劝退。`mail_setup` 工具把
 * 用户口述的地址/服务器写进这里；`apply()` 时按
 *   DEFAULTS  <  settings.json  <  profile patch 的 config
 * 的顺序合并——老用户用 profile patch 的配置继续赢，新用户完全不用碰 yaml。
 *
 * 只收白名单键；坏 JSON / 类型不对的字段一律忽略（配置层不该让插件挂掉）。
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STRING_KEYS = [
  'ownerAddress',
  'selfAddress',
  'fromName',
  'imapHost',
  'smtpHost',
  'credentialFile',
  'user',
  'passwordCredential',
  'userCredential',
  'mailDir',
  'sendPolicy',
  'wakeAuth',
  'wakePassphrase',
  'sentMailbox',
  'inboxMailbox',
]
const ARRAY_KEYS = ['ownerAliases', 'selfAliases', 'allowedRecipients']
const NUMBER_KEYS = ['imapPort', 'smtpPort', 'imapPollSeconds', 'maxPerRound']
const BOOLEAN_KEYS = ['receive', 'ownerOnly', 'wakeTokenIssue', 'notifyOnStart']

/** 测试注入用：设置后所有读写都走这个文件（离线测试不碰真实 $DSH_HOME）。 */
let overrideFile = null
export function setSettingsFile(file) {
  overrideFile = typeof file === 'string' && file !== '' ? file : null
}

/** 当前 settings.json 的绝对路径（环境变量每次现读，便于测试/多 profile）。 */
export function settingsFile() {
  if (overrideFile !== null) return overrideFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'mail-channel', 'settings.json')
}

/** 把任意输入收敛成白名单键的配置对象；非法字段直接丢弃。 */
export function normalizeSettings(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const out = {}
  for (const key of STRING_KEYS) {
    if (typeof source[key] === 'string') out[key] = source[key].trim()
  }
  for (const key of ARRAY_KEYS) {
    if (Array.isArray(source[key])) {
      out[key] = source[key]
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item !== '')
    }
  }
  for (const key of NUMBER_KEYS) {
    if (Number.isFinite(source[key])) out[key] = Number(source[key])
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof source[key] === 'boolean') out[key] = source[key]
  }
  return out
}

/** 同步读：apply() 是同步函数，配置要在建闭包前拿到。读不到返回 {}。 */
export function readSettings(file = settingsFile()) {
  try {
    const raw = readFileSync(file, 'utf8')
    return normalizeSettings(JSON.parse(raw.replace(/^\uFEFF/, '')))
  } catch {
    return {}
  }
}

/** 合并写（tmp + rename 原子替换）；返回合并后的完整设置。 */
export async function writeSettings(patch, file = settingsFile()) {
  const current = readSettings(file)
  const next = normalizeSettings({ ...current, ...normalizeSettings(patch) })
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return next
}
