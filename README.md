# 邮件通道 · dsh-mail-channel

> 给 DeepSeek Harness 的**邮件通道**——不是邮箱客户端。

把邮箱变成 Agent 与主人之间的常驻通信通道：无论新开哪个对话，Agent 都自带收发信工具；主人来信会**唤醒绑定的会话**，Agent 读完即认领、发完必回查。传输层（SMTP / IMAP）完全跑在插件进程内，零运行时依赖、不调用任何外部脚本。

```
主人 ──SMTP──> 邮箱 ──IMAP──> 插件 ──fs.watch──> 唤醒绑定对话
                                  ▲                    │
                                  └── mail_send ◄── 干活 │
```

## 这是什么 / 不是什么

**是**：

- 一套给 Agent 用的**邮件工具**（9 个工具常驻，含 `mail_setup` 首次配置），让 Agent 能读信、回信、查往来、自检；
- 一条**可预测的唤醒通道**：收到主人来信 → 自动注入绑定的对话，不需要人盯着；
- 一套**本地优先**的通信记录：地址簿、往来检索、待办队列、发信记录都落盘，检索不额外连网。

**不是**：

- 不是邮件客户端——没有收件箱界面、没有富文本编辑、没有签名模板；日常入口是对话里的工具和侧栏一个开关；
- 不做多账号 / OAuth2 / POP3；一个 profile 跑一个邮箱；
- 不替代主人的邮箱 App：它只是 Agent 的一双手。

## 特性

- **9 个工具常驻**：`mail_inbox / mail_read / mail_send / mail_verify / mail_bind / mail_contacts / mail_history / mail_doctor / mail_setup`
- **到信唤醒**：新信落盘后（`fs.watch` 1.5s 去抖）把主题/发件人/摘要/处理流程注入绑定的会话
- **读即认领**：`mail_read` 同时写 `.done`，避免重复处理；**发必回查**：`mail_verify` 按 Message-ID/自定义头定位刚发的那封（服务商改写 id 时用主题+时间窗兜底），`pending` 不算失败
- **侧栏开关**：侧栏底部「邮件」按钮一键开关自动收信；开启后绑定当前对话，切换对话自动跟随焦点；**开启不补唤醒积压**
- **安全默认**：地址精确匹配才唤醒（From 头伪造无效）；发信受 `sendPolicy` 保护；可选一次性回信令牌 / 静态口令
- **可靠性**：启动失败指数退避重试、断线重连退避、单实例锁、日志按大小轮转且历史检索不丢
- **零运行时依赖**：只用 Node 内置模块；不依赖 Python、不依赖外部守护脚本

## 安装

### 应用内安装（推荐）

侧栏 → **插件** → **添加插件** → **安装第三方插件** → 填：

```
dsh-mail-channel
```

### 命令行安装

```bash
# 桌面应用的 profile 是 desktop；命令行环境（dsh web）把 desktop 换成 web
dsh plugin --profile desktop add dsh-mail-channel
```

装好后重启应用，**侧栏底部出现「邮件」开关**即安装成功。

## 卸载

1. 侧栏 → **插件** → 找到 `dsh-mail-channel` → 卸载（或 `dsh plugin --profile desktop remove dsh-mail-channel`）；
2. **重启 DSH 应用**（模块卸载需要重启才生效；卸载后「邮件」开关消失、来信不再唤醒）；
3. （可选）清理本地数据：删除 `$DSH_HOME/mail-channel/`（队列、归档、`settings.json`、日志）。**邮件本身在你的邮箱里，不会因此被删除。**
4. （可选）清理配置：如果曾手写过 profile 的 `cordis.patch.yml`，把 `mail-channel` 那一行删掉。

> 升级/降级：在插件面板重新安装目标版本（或 `dsh plugin --profile desktop add dsh-mail-channel@<version>`）→ 重启。数据目录与配置会保留。

## 快速开始（3 步，对话里就能完成）

> 这个插件**不需要手改配置文件**：对它说一句话就能完成首次配置。

### ① 安装并重启

按上面的方式装好 → 按提示重启 DSH → 侧栏底部出现「邮件」开关。

### ② 对 Agent 说一句话完成配置

```
帮我配置邮箱：主人是 owner@example.com，本机是 agent@example.com，授权码是 xxxxxxxx
```

Agent 会调用 `mail_setup`，把地址写进插件自己的 `$DSH_HOME/mail-channel/settings.json`，并把账号/授权码存进 **DSH 凭据库**（`MAIL_CHANNEL_USER` / `MAIL_CHANNEL_PASSWORD`）；**地址与凭据立即生效**，不用重启，也不用改 `cordis.patch.yml`。

同一句话里可以顺便说清（可选）：主人邮箱的别名（如 QQ 的数字地址）、发信署名、IMAP/SMTP 服务器（默认按 QQ：`imap.qq.com` / `smtp.qq.com`）、发件箱名、旧数据目录 `mailDir`（改它会提示重启一次）。

> **凭据也可以自己先放好**：DSH 凭据服务 / 环境变量 `MAIL_CHANNEL_USER`+`MAIL_CHANNEL_PASSWORD` / `credentialFile`（含 `smtpUser`/`smtpPass` 的文件）。这样第 ② 步只需给两个地址，**授权码不会进对话记录**（更稳妥；如果授权码是在对话里给的，配置完成后建议去邮箱重置一次）。

### ③ 打开开关 + 自检

侧栏底部点「邮件」→ 开关打开并**自动绑定当前对话**；对 Agent 说「做一次邮件通道自检」跑 `mail_doctor`，确认凭据 / 收信连接 / 地址配置 / 实例锁全部通过。

> 手动配置也行：`ownerAddress` / `selfAddress` 写进插件自己的 `settings.json`（`mail_setup` 就是写这个文件），或写 profile 的 `cordis.patch.yml`（见下面的「配置」；账号/授权码走 DSH 凭据服务或环境变量）。

## 回复渠道 = 请求来源渠道（重要）

插件同时是"工具"和"自动唤醒通道"，但**不要把所有任务的结果都发邮件**：

- **对话里下达的任务**（普通聊天、侧栏操作）：在对话里汇报结果，**不要调用 `mail_send`**；除非主人明确说"发邮件 / 用邮件汇报"。
- **邮件唤醒的回合**（主人回复邮件下达任务）：按 `mail_read`（读即认领）→ 干活 → `mail_send` 回信 → `mail_verify` 回查 的固定流程走。
- **主人明确要求邮件通信 / 远程处理**：按邮件流程走。
- 判断依据：本轮是否由「MAIL ARRIVED」唤醒，或主人是否明确要求邮件。这条规则写进了系统提示，`mail_send` 的描述也限定为这两种场景；发信门与审批策略是另一层（安全），不替代这条渠道规则。

## 配置

**最省事的方式是对 Agent 说一句"帮我配置邮箱"，由 `mail_setup` 写插件自己的 `settings.json`**（见「快速开始」）。下面的 profile patch 是传统/高级用法，适合想**覆盖**插件默认值的场景；合并顺序是 `DEFAULTS < settings.json < profile patch config`，所以 profile patch 仍然赢。

也可以手写 profile 的 `cordis.patch.yml`（用户层 patch）。**注意用 id 定向覆盖，不要用 `- insert:`**——插件包自己已经 `insert` 了一行，用户层再 insert 会在 profile 里出现重复的 `mail-channel` 行：

```yaml
# 用户层 patch：按 id 覆盖已安装 bundle 行的 config（不是再次 insert）
- id: mail-channel
  config:
    # ── 地址与署名（必填）──
    ownerAddress: owner@example.com
    ownerAliases:
      - owner-alias@example.com
    selfAddress: agent@example.com
    selfAliases:
      - agent-alias@example.com
    fromName: Example Agent
    # ── 连接（默认按 QQ 邮箱预填，换服务商改这里）──
    imapHost: imap.example.com
    imapPort: 993
    smtpHost: smtp.example.com
    smtpPort: 587            # 0 = 先试 587 STARTTLS，失败退 465
    receive: true             # true = 插件自己收信
    imapPollSeconds: 15
    # ── 安全（P0）──
    sendPolicy: confirm       # owner-only | confirm | open
    allowedRecipients: []
    wakeAuth: address         # address | token
    wakeTokenTtlMinutes: 120
    wakeTokenIssue: true
    wakePassphrase: ''        # 空 = 关闭静态口令
    # ── 可靠性（P1）──
    reconnectBaseSeconds: 30
    reconnectMaxSeconds: 300
    logMaxBytes: 5242880
    logKeep: 2
    instanceStaleMinutes: 10
    startRetryMaxSeconds: 600
    # ── 预算 ──
    dailyLoginBudget: 100
    dailySendBudget: 50
```

> 插件管理面板如果提供"bundle 配置"输入框，直接粘贴上面 `config:` 下面的内容即可。

### 数据目录与凭据

| 键 | 默认 | 说明 |
|---|---|---|
| `mailDir` | `$DSH_HOME/mail-channel` | 队列、归档、状态目录；`DSH_HOME` 未设时用 `~/.dsh/mail-channel` |
| `passwordCredential` / `userCredential` | `MAIL_CHANNEL_PASSWORD` / `MAIL_CHANNEL_USER` | DSH 凭据服务里的名字 |
| `credentialFile` | 空 | 兼容用：正则读取 `smtpUser` / `smtpPass` |
| `user` / `password` | 空 | 直接给凭据（优先级最高，不建议写进配置） |

凭据解析顺序（前面的赢）：配置 `user`+`password` → DSH 凭据服务 → 同名环境变量 → `credentialFile`。

### 连接

| 键 | 默认 | 说明 |
|---|---|---|
| `imapHost` / `imapPort` | `imap.qq.com` / `993` | 收信服务器（TLS）；默认按 QQ 邮箱预填，换服务商改这里 |
| `smtpHost` / `smtpPort` | `smtp.qq.com` / `0` | 发信服务器；`0` = 先试 587 STARTTLS，失败退 465 |
| `receive` | `true` | `true` = 插件自己收信；`false` = 只读外部心跳文件（兼容旧部署，新装建议保持 `true`） |
| `imapPollSeconds` | `15` | NOOP 轮询间隔（秒） |
| `maxPerRound` | `5` | 每轮最多取几封 |
| `inboxMailbox` / `sentMailbox` | `INBOX` / `"Sent Messages"` | 收发件箱名；部分服务商发件箱名带引号 |
| `connectTimeoutMs` | `60000` | 连接超时（毫秒） |

> 默认按 QQ 邮箱预填 `imap.qq.com` / `smtp.qq.com`；换服务商只改 `imapHost`/`imapPort`/`smtpHost`/`smtpPort`（必要时还有 `inboxMailbox`/`sentMailbox`）。示例配置里统一用 `example.com` 占位。

### 地址

| 键 | 默认 | 说明 |
|---|---|---|
| `ownerAddress` | 空（必须配置） | 主人邮箱规范地址：默认收件人、`@主人` 目标 |
| `ownerAliases` | `[]` | 同一邮箱的其他地址，只用于识别与收敛，不重复发送 |
| `selfAddress` | 空（必须配置） | 本机发信规范地址（署名） |
| `selfAliases` | `[]` | 本机邮箱的数字地址/别名，仅用于识别 |
| `fromName` | 空 | 对外显示名；留空则只用邮箱地址 |

### 安全（P0）

| 键 | 默认 | 取值 | 说明 |
|---|---|---|---|
| `sendPolicy` | `'confirm'` | `owner-only` \| `confirm` \| `open` | 非白名单收件人的处理方式 |
| `allowedRecipients` | `[]` | 地址数组 | 除主人地址外允许**直接**发的地址（固定信任名单） |
| `wakeAuth` | `'address'` | `address` \| `token` | 唤醒身份校验强度 |
| `wakeTokenTtlMinutes` | `120` | 整数 | 一次性回信令牌有效期（分钟） |
| `wakeTokenIssue` | `true` | 布尔 | `wakeAuth='token'` 时是否在去信里嵌令牌 |
| `wakePassphrase` | `''` | 字符串（空=关） | 可选静态口令，给"新写一封信"留入口 |

### 可靠性（P1）

| 键 | 默认 | 说明 |
|---|---|---|
| `reconnectBaseSeconds` | `30` | 断线重连起始间隔（秒，此后指数增长） |
| `reconnectMaxSeconds` | `300` | 重连间隔上限（秒） |
| `logMaxBytes` | `5242880` | `plugin.log` / `send.log` 轮转阈值（5 MB） |
| `logKeep` | `2` | 轮转保留的历史分片数（`file.N … file.1` + 当前 `file`） |
| `instanceStaleMinutes` | `10` | 实例锁心跳超时（超过即视为陈旧可接管） |
| `startRetryMaxSeconds` | `600` | 收信启动失败的重试上限间隔（秒） |

### 预算与行为

| 键 | 默认 | 说明 |
|---|---|---|
| `ownerOnly` | `true` | 只对白名单（主人地址）来信唤醒 |
| `maxWakesPerHour` | `6` | 唤醒限流，防垃圾信烧 token |
| `maxWakeAgeMinutes` | `1440` | 超过一天的信不唤醒 |
| `channelSessionId` | 空 | 写死通道会话（优先于侧栏开关）；一般不用 |
| `pollSeconds` | `30` | 待办扫描兜底间隔（秒） |
| `staleMinutes` | `5` | `receive=false` 时外部心跳文件的新鲜度阈值 |
| `notifyOnStart` | `true` | 启动后是否立即扫一轮 |
| `dailyLoginBudget` / `dailySendBudget` | `100` / `50` | 当日登录/发信预算，过半提醒 |

## 工具（9 个）

| 工具 | 作用 |
|---|---|
| `mail_inbox` | 通道状态（native 模式含存活 / `failures` / `lastErrorAt` / `retryAttempts` / `retryInMs`）+ 待办列表 + 当日预算 + `security`（发信策略/唤醒鉴权/有效令牌数）。只读本地，不连网、不动基线 |
| `mail_read` | 读一封待办来信的全文与附件绝对路径，**同时写 `mail-<uid>.done` 认领**，避免重复处理 |
| `mail_send` | 组 MIME 经 SMTP 发出；默认发给 `ownerAddress`，`to` 可写地址或 `@备注名`；记录并返回 `messageId`；非白名单收件人受 `sendPolicy` 保护 |
| `mail_verify` | 按上次发信的 `Message-ID`/`X-Mail-Channel-Id` 回查（服务商改写 id 时用主题+时间窗兜底，可显式传 `messageId`）；核验收件人/附件数/关键词；发件箱未同步时返回 `pending`（不是失败） |
| `mail_bind` | 把当前会话设为通道并同步打开侧栏开关；子会话（subagent）不可用 |
| `mail_contacts` | 本地地址簿：`list` / `add` / `remove` / `learn`（从归档自动补联系人） |
| `mail_history` | 本地往来检索：收件来自归档，发件来自 `send.log` 及其历史分片；支持按人/主题/关键词/时间过滤，不连网 |
| `mail_doctor` | 一键自检：凭据、目录、连接、待办、实例锁、日志、用量、地址配置、发信策略、唤醒鉴权，并给下一步 |
| `mail_setup` | **首次配置/换邮箱**：写地址到 `settings.json`，可选把账号/授权码写入 DSH 凭据库、指定 `credentialFile` / `mailDir`；地址与凭据立即生效（`mailDir` 变更需重启） |

## 安全模型

两条独立的安全门。默认值向后兼容：回主人照旧直发，主人来信照旧唤醒。

### 发信门（`mail_send`）

收件人先经地址簿解析（`@备注名` / `@主人` → canonical 地址）并规范化为 addr-spec；**非法地址整封拒绝**。然后按"是否全部在主人地址 ∪ `allowedRecipients` 里"分流：

| 收件人情况 | `owner-only` | `confirm`（默认） | `open` |
|---|---|---|---|
| 全部 ∈ 主人地址 ∪ `allowedRecipients` | 放行 | 放行（不弹审批） | 放行 |
| 有非白名单收件人 | **拒绝** | 交宿主审批，批准才发 | 放行 + `plugin.log` 警告 |
| 审批面不可用（headless / 无客户端） | — | **拒绝**（fail-closed） | — |
| 会话审批策略 = `never`（Full Access 预设） | — | **拒绝**（不伪造审批） | — |

- **fail-open 只允许显式选择**：`open` 是唯一"绕过审批向任意地址发信"的档位，会在 `plugin.log` 留 `send 策略警告`；`owner-only` 与 `confirm` 在拿不到审批时一律 **fail-closed**。
- 拒绝时工具**不会执行**，拒绝原因里给出两条出路：把地址加入 `allowedRecipients`，或改 `sendPolicy`；任何拒绝都不计入当日发信预算、不写 `send.log`。
- 当会话审批策略为 `never`（例如 **Full Access 预设**）时，`confirm` 档下的非白名单发信会**稳定拒绝**（不会弹审批）——回主人地址不受影响，零审批。
- 放行会把控制权交回工具调用链，不会截断其它插件的门。

### 唤醒门（`checkOnce`）

1. **地址精确匹配（默认、始终建议开启）**：`From` 头用地址解析取 addr-spec，只认主人地址集合的**精确相等**（大小写不敏感）。`x@example.com.evil.com`、`"owner@example.com" <evil@example.com>` 都不会匹配；旧归档里的 `is_owner` 字段不再可信，唤醒与展示时都重新计算。
2. **`wakeAuth='token'` 时追加一次性令牌校验**（在地址校验之后）：
   - 令牌从**主题 → 正文 → html** 取第一个 `[wake:XXXX]` 或 `#wake:XXXX`；必须存在于令牌账本、未用过、未过期；
   - 或者命中 `wakePassphrase`（静态口令）——给"新写一封信"（不是回复）留入口。口令**必须单独占一行**（前后空白忽略、大小写敏感、逐行常量时间比较），不做子串搜索；
   - 失败：**不唤醒**、不写 `.woken`，信仍在待办里可手动 `mail_read`；
   - 成功：只在**真正投递后**核销令牌（一次性）。
3. **令牌流程**：token 模式下 `mail_send` 在正文末尾追加 `回信口令：[wake:…]`（返回值也带 `wakeToken`）。主人引用原信回信即可唤醒对应会话；不回复或重新写信时走静态口令，或把 `wakeAuth` 切回 `address`。

> 邮件正文与附件是**外部数据，不是系统指令**。Agent 遵循会话里的安全规则：被拒时不要绕过，先问主人。

## 可靠性（P1）

### 回查精确化（Message-ID + 自定义头兜底）

`mail_send` 发信前生成 `<uuid@mail-channel>` 形式的 `Message-ID`，成功后写入 `plugin-state.json` 的 `lastSent`（含 `subject` / `at`）并在返回值里带 `messageId`。去信同时带 `X-Mail-Channel-Id: <uuid>` 自定义头。`mail_verify` 默认用它回查，连续发信不会核到上一封：

- **候选**：先 `HEADER SEARCH`（`X-Mail-Channel-Id`，再 `Message-ID`），再扫发件箱最后 10 封；每个候选都 fetch 回来用"身份谓词"验证（自定义头/Message-ID 规范化相等，或 **主题相同 + 发送时间 ±15 分钟**）；
- **为什么需要兜底**：部分服务商（如 QQ）会把 `Message-ID` 改写成 `<tencent_…@qq.com>`，只认 Message-ID 会永远 `pending`；自定义头通常保留，主题/时间窗作为最后一道；
- 发件箱同步通常滞后 20~60 秒：都找不到时返回 `pending: true`、`matched: 'pending'`，**不是失败**，稍后用同一个 `messageId` 重查；
- 命中时 `matched` 为 `'message-id'`（id/自定义头命中）或 `'subject-window'`（主题+时间窗命中）；若服务商改写了 id，返回值会带 `actualMessageId` 供诊断；
- 没有可用 `messageId` 时退化为回查最后一封（`matched: 'latest'`）。

### 启动失败自动重试

激活时凭据/网络失败不会只记一行日志：按指数退避自动重试（`reconnectBaseSeconds` 起、每次翻倍、封顶 `startRetryMaxSeconds`，±20% 抖动）。`mail_inbox.channel` 给出 `retryAttempts` / `retryInMs`；失败会**先释放实例锁**，成功接管后计数归零。

### 断线重连指数退避

长连接断了按 30s → 60s → 120s → 240s → 300s 退避（±20% 抖动，`reconnectBaseSeconds` / `reconnectMaxSeconds` 可调），成功一轮即重置。`channel.failures` 是连续失败次数、`lastErrorAt` 是最近一次错误时间；恢复后清空 `lastError` 但保留 `lastErrorAt`。

### 单实例锁

收信启动前在 `mailDir` 取 `instance.lock`（`pid` + 心跳）：

- 抢不到锁时**只停收信**，工具与侧栏照常可用，5 分钟后重试；
- 持有者退出或心跳超过 `instanceStaleMinutes` 时自动接管；
- 插件退出时释放锁（删不掉会靠心跳超时兜底）；
- `mail_doctor` 的「实例锁」检查显示持有 / 被谁占用 / 未持有。

### 日志轮转

`plugin.log` 与 `send.log` 按 `logMaxBytes` 轮转（`file → file.1 → file.2 …`，保留 `logKeep` 份）。`mail_history` / `mail_doctor` 读 `send.log` 时按**旧 → 新读全部分片**，轮转不会让历史发信从检索里消失。

## 数据目录

默认 `$DSH_HOME/mail-channel`（`DSH_HOME` 未设时 `~/.dsh/mail-channel`），全部是普通文件：

| 文件 / 目录 | 说明 |
|---|---|
| `待办/mail-<uid>.json` | 一封来信的完整记录；无同名 `.done` = 待处理 |
| `收件箱/<uid>/` | 附件落盘 |
| `inbox-state.json` | 收信基线 `last_uid` |
| `plugin-state.json` | 绑定会话、唤醒记录、当日用量、最后一封发信（`lastSent`） |
| `ui-state.json` | 侧栏开关状态：`enabled` / `sessionId` / `enabledSince` |
| `contacts.json` | 地址簿 |
| `settings.json` | **插件自己的配置覆盖层**（`mail_setup` 写入：地址/别名/服务器/凭据文件等）；启动时按 `DEFAULTS < settings.json < profile patch config` 合并 |
| `plugin.log` / `plugin.log.1…` | 运行流水与历史分片 |
| `send.log` / `send.log.1…` | 发信记录与历史分片（往来检索用） |
| `wake-tokens.json` | 一次性回信令牌账本（token 模式） |
| `instance.lock` | 单实例锁（pid + 心跳） |

数据目录可备份、可迁移；迁移后需重新配 `mailDir`。**不要**让两个插件实例同时使用同一个 `mailDir` 收信。

## 常见问题（troubleshooting）

| 现象 | 处理 |
|---|---|
| 登录失败 / 认证错误 | 用的是**授权码**而不是登录密码；在邮箱设置里开启 IMAP/SMTP 并生成授权码；确认 `imapHost`/`imapPort`（通常 993 SSL）与 `smtpHost`/`smtpPort`（587 STARTTLS） |
| 收到信但没唤醒 | 检查 `ownerAddress` 是否与发件人 **addr-spec 精确一致**、侧栏开关是否开、是否绑定了对话、`ownerOnly` 是否为 true；token 模式下回信要带 `[wake:…]` 或单独一行的静态口令 |
| 发信被拒 | `sendPolicy=confirm` 且审批面不可用时按设计拒绝（headless/Full Access 都会）；把收件人加入 `allowedRecipients`，或改 `sendPolicy`。token 模式/审批不可用时不建议改成 `open` |
| `mail_verify` 返回 `pending` | 发件箱还没同步到，**不是失败**；等 20~60 秒用同一个 `messageId` 重查 |
| 提示"另一个实例在收信" | 同一 `mailDir` 已有进程持有 `instance.lock`；停掉另一个 DSH 实例，或给本机换 `mailDir`；确认旧进程已退出后可等心跳超时自动接管 |
| 收信连接断了 | 插件会按退避自动重连；`mail_doctor` 的「收信连接」与 `plugin.log` 的 `收信异常` 行会给出原因；长时间不恢复先查网络/授权码 |
| QQ 邮箱收信有延迟 | QQ 不支持 IMAP IDLE，只能按 `imapPollSeconds`（默认 15s）轮询；这是服务商限制，不是插件 bug |
| 中文乱码 | 现代邮件一般 UTF-8；老式 GB2312 邮件由内置 MIME 解码兜底；仍异常时把原始 `.eml` 内容反馈 |

## 兼容性

- **DeepSeek Harness**：`>= 0.2.2-rc.1`（依赖插件 API：tools / sessions / sessionController / systemPrompt / approval / webServer）
- **Node.js**：`>= 22.19`
- **运行时依赖**：**零**（只用 Node 内置模块）
- **平台**：DSH 桌面应用支持的平台均可；侧栏开关依赖 Web GUI 的 `webServer`，Host 未加载 `webServer` 时工具仍可用、开关不可用
- **账号**：单账号、单实例；多账号/OAuth 暂不支持

## 开发与测试

源码仓库内共 7 套测试，全部离线（不连网、不发真信；临时目录 + 假 ctx / 假 IMAP client）。npm 发布包不包含 `test/`，请从源码仓库运行：

```bash
node test/mime.test.mjs        # MIME 编解码往返
node test/security.test.mjs    # 安全原语：地址归一、发信策略、令牌、静态口令
node test/verify.test.mjs      # 回查：Message-ID 命中 / pending / 退化 latest
node test/lock.test.mjs        # 单实例锁：占用、陈旧接管、心跳、释放
node test/rotate.test.mjs      # 日志轮转：阈值、保留份数、读取顺序、降级
node test/harness.mjs          # 假 ctx 走全链路：队列/认领/唤醒/地址簿/往来/预算/安全门/可靠性
node test/client.test.mjs      # Client 半区离线冒烟：侧栏开关渲染与交互
```

`harness` 用真实 `fs.watch` 走唤醒路径，耗时约 30 秒；其余均为纯函数/临时目录测试。合计 384 项断言。

## License

本项目以 **MIT License** 发布（SPDX: `MIT`）。可自由使用、修改、分发；请保留版权与许可声明。
