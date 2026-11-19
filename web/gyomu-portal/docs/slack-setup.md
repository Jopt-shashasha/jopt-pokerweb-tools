# Slack App 配置交接

2026-11-19 / Asia/Tokyo。代码分工：Claude 实现 Before/After、Web/MCP 登记、Slack 预览/发送/限额/摘要/统计；Codex 只处理 Google OAuth、Slack App、频道清单、托管比较。Codex 不改 `src/`、`public/` 及 Claude 的迁移和测试文件。

## App 和凭据

- App 注册名：`JOPT Gyomu Portal`；Bot 显示名：`業務ポータル`；默认用户名：`jopt_gyomu_portal`。创建表单要求英文注册名，安装后已成功设置日文 Bot 显示名。
- 已于 2026-11-19 在 `JOPT`（`T089X4N982U`）创建并安装；App ID：`A0CK1S242B0`。设置入口：https://api.slack.com/apps/A0CK1S242B0 。未改动现有 `SHA Task Radar`。
- 权限严格沿用用户指定的五项：`chat:write`、`chat:write.public`、`users:read`、`users:read.email`、`im:write`。
- 使用 Bot Token，非 Incoming Webhook。只在本机未追踪的 `.env.local` 配置 `SLACK_BOT_TOKEN`；不放进前端、数据库、普通日志或聊天。
- `.env.local` 已保存 `SLACK_BOT_TOKEN` 和 `SLACK_WORKSPACE_URL=https://jopthq.slack.com`，原 Google OAuth 配置已保留。该文件由 Git 忽略；不要复制密钥到聊天或 Claude 交接文案。
- 使用官方 `POST https://slack.com/api/auth.test` 验证通过：`ok=true`，工作区为 `JOPT`，Bot ID `B0CJNE4AQJ3`，Bot 用户 ID `U0CJXJGR8FM`。返回的 `x-oauth-scopes` 恰为上述五项；未请求用户令牌权限。
- `slack-app-manifest.json` 是不含凭据的配置模板，按已确认的设置整理，不是后台完整导出。创建向导自动生成的 App-Level Token 未保存、未使用；第一阶段发消息只用 Bot Token。
- 已关闭 Socket Mode、始终在线及 Messages Tab 的用户输入；Home Tab 未启用，Messages Tab 保留用于显示 Bot 发出的私信。Interactivity、Slash Commands、Event Subscriptions 均未启用。当前仅为出站推送准备，无需回调地址、Signing Secret 或常驻 Socket 连接；未来添加 Slack 内交互审批时另行配置。
- 无 Token 时只预览，不向 Slack 发送。首次真实推送需另外确认内容和目标频道。
- 公开频道可按用户要求使用 `chat:write.public`；私有频道仍需邀请 Bot，不能据此越过私有频道权限。频道清单不代表发送授权。

## 频道清单

2026-11-19 用户确认：本阶段只搭建功能形式；最终是否推送、推什么、向谁推送、用哪个频道及发送频率，均待与领导确认。不为此创建新频道，不要求用户现在确定频道。

`slack-channel-map.json` 是连接 Slack 搜索核实的名称与 ID，不是已启用的运行配置。八个部门已找到现有工作频道，但它们只是候选资料，不是已批准的推送目标；排除了带“解体予定”的旧频道和经联系统频道。ディレクター、全社用继续保持空值，列为待确定事项。所有 `sending_enabled` 保持 `false`。

频道链接格式为 `https://jopthq.slack.com/archives/<channel_id>`。发送前的预览应显示实际频道名及 ID，避免只靠部门名猜测。

## 与 Claude 的数据接口约定

- 用户要求的可选字段：対象者、作業、Before、After、頻度。拼接介绍行不调用模型，缺失时回退用途首句。
- 只有创建者实际提供的时间才能写成“5分→30秒”；没有来源时不补造节省数字。
- 候选展示形式：一条成果一条消息，以对象部门的原工作频道为候选目标；推送内容不加“AI”宣传标签。实际受众与频道尚待领导确认。
- 用户提供的文案原型：

```text
📌 カスタマー向け｜Voucher照合ツール
Voucherの照合作業を、まとめて確認できます。
作成：〇〇さん
[使い方を見る]
```

- 摘要预览可按此前讨论的“新成果3～5条＋最多被读取的1条”搭建；每周一发送只是候选方案，实际频率与时间待领导确认。周界线与去重采用 Asia/Tokyo，不预设生产定时任务。
- 新闻单独处理来源、摘要、发布时间和去重，不把旧日次总结伪装成新发布消息。

## 统计边界

- `/go/资料ID?src=slack` 应先跳门户详情，原 Drive/GitHub 权限继续生效。不可直接把查询参数中的任意 URL 当跳转目标。
- Slack 自动展开和机器人请求不计为人的点击。若要关联单条推送，用推送批次标识；单独 `src=slack` 可被手动填写，不能当可信归因凭证。
- `resource_usage` 当前记录 `via=codex` 的 `read`／`suggested`。读取、被建议、网页点击分别计数，不宣称等于实际业务使用次数或节省工时。
- 推送前后同长度时间窗的数据可作参考，不据此认定推送导致了使用增长。
- 发送前重新检查资料仍为已发布、社内共享。草稿、私有、已撤回条目不出现在推送/每周摘要中。未来限定共享需要核对目标频道受众，而非仅检查操作者是管理员。
- 发送超时可能出现“Slack已收到但本机未确认”，不可自动无限重试；记录待核对状态并提供人工确认，防止重复推送。

## 当前未做

未发送消息；未启用频道或定时推送；未重启服务；未替 Claude 接入路由或改变其代码。Google 的本机回调只用于当前验证，给同事使用时还需正式 HTTPS 站点和对应回调。

## Claude 接入顺序

1. 直接读取本机 `.env.local`，不要要求用户再次提供 Token。服务需在安全检查完成后重新启动，旧进程不会自动重新读取配置。
2. 频道名称和 ID 见 `slack-channel-map.json`。八个部门已识别，ディレクター及全社用保持空值；未确定目标时不要自动采用候选频道。
3. 当前 `src/slack.ts` 在存在 Token 时会进入 `live` 模式；每部门的 `slack_enabled` 和摘要开关仍必须为关闭。这里未运行频道写入脚本、未更改数据库，避免与 Claude 的迁移并发。
4. 确认迁移和程序完成后，可用 `scripts/apply-slack-channels.ts` 的 dry run 检查候选映射。保持发送关闭，不将找到的工作频道默认为正式推送目标。
5. 当前完成预览和程序搭建即可；真实发送、频道选择、频率及定时启用留待领导决定。以后用户指定测试内容与频道时再测试发送、跳转和点击统计。身份验证成功不等于消息发送或整条推送流程已验收。

官方身份验证接口说明：https://docs.slack.dev/reference/methods/auth.test/ 。

安装成功截图：`D:\JOPT work\業務ポータル\画面確認\2026-11-19\slack-installed.jpg`。
