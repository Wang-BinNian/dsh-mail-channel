# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.1.0 — 2026-11-07

首个公开发布版：把"邮件"做成 Agent 与主人之间的常驻通信通道（不是邮箱客户端）。

### 核心能力

- **9 个常驻工具**：`mail_inbox` / `mail_read` / `mail_send` / `mail_verify` / `mail_bind` / `mail_contacts` / `mail_history` / `mail_doctor` / `mail_setup`。
- **首次配置不用改 yaml（P4.2）**：对 Agent 说"帮我配置邮箱：主人 …、本机 …、授权码 …"，`mail_setup` 把地址写进插件自己的 `settings.json`、把账号/授权码写进 DSH 凭据库；地址与凭据立即生效，`mailDir` 变更提示重启。合并顺序 `DEFAULTS < settings.json < profile patch config`，老用户配置继续赢。
- **到信唤醒**：收到主人来信后唤醒绑定的会话，并把主题/发件人/摘要/处理流程直接投进对话；侧栏「邮件」开关控制自动收信，切换对话自动跟随焦点。
- **传输层自包含**：进程内自实现 SMTP（587 STARTTLS → 465 隐式 TLS 回退）与 IMAP（长连接 + NOOP，不用 IDLE、不重复登录），零第三方运行时依赖。
- **磁盘判据**：`待办\mail-<uid>.json` + `.done` / `.woken` 标记，重启不重放；`enabledSince` 水位线保证"开启不补唤醒积压"。
- **地址与别名**：一个邮箱多个地址时"识别全认、发送只发 canonical"；地址簿支持 `@备注名`、`learn` 从历史信补齐。
- **可观测**：`mail_doctor` 7+ 项自检（凭据/目录/连接/待办/开关/用量/地址/策略/鉴权/锁/日志）；当日登录/发信/回查预算。

### 行为约定

- **回复渠道 = 请求来源渠道（P4.1）**：对话里下达的任务在对话里汇报，**不额外发邮件**；只有"本轮由邮件唤醒"或"主人明确要求邮件汇报/远程处理"才走 `mail_send` + `mail_verify`。系统提示、`mail_inbox`/`mail_send` 的工具描述都写明这条规则；唤醒模板标明"本轮由邮件唤醒"。

### 安全

- **发信门**：主人地址（含别名）+ `allowedRecipients` 直发；其余按 `sendPolicy`：`owner-only` 拒绝 / `confirm` 走宿主审批 / `open` 放行并警告；审批不可用或会话策略 `never` 时 fail-closed。
- **唤醒门**：`From` 按 addr-spec 精确匹配（挡掉寄生域名与显示名伪造）；可选 `wakeAuth='token'` 一次性回信令牌（TTL + 用后作废）或静态口令（单独一行、常量时间比较）。
- 凭据四级解析（配置 → DSH 凭据服务 → 环境变量 → 凭据文件），日志与工具返回不回显凭据。
- 默认不预置任何私人地址；`ownerAddress` / `selfAddress` 填好之前收发与唤醒都不可用（安全默认）。

### 可靠性

- **回查精确化**：`mail_send` 记录 `Message-ID` 并附带 `X-Mail-Channel-Id` 自定义头；`mail_verify` 按候选验证定位发件箱里的那一封——QQ 这类会把 Message-ID 改写成 `<tencent_…@qq.com>` 的服务商，用自定义头或"主题 + 发送时间 ±15 分钟"兜底；同步滞后返回 `pending:true`（不是失败），可传 `messageId` 复核任意一封。
- **启动重试**：收信启动失败按指数退避自动重试（30s→600s 封顶、±20% 抖动）；失败会先释放实例锁。
- **断线退避**：连续失败 30→60→120→240→300s 封顶；恢复后清空 `lastError`、保留 `lastErrorAt`。
- **单实例锁**：`instance.lock`（pid + 心跳，原子抢锁/陈旧接管）；占用时只停收信，工具与 UI 照常。
- **日志轮转**：`plugin.log` / `send.log` 超 5 MB 轮转（保留 2 份历史分片 + 当前）；`mail_history` 读全部分片，轮转不丢历史。
- 218 → 379 项离线断言（mime/security/harness/verify/lock/rotate/client），全绿。
