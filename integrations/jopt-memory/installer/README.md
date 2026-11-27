# JOPT Memory 安装试点

Windows 双击 `Install.cmd`。Mac 试点用本地 AI 执行 `bash Install-Mac.command`。在目录选择窗口选公司分配给你的共有 Drive 文件夹，核对本地笔记源、项目和目标，输入 `YES`。需要 Python 3.12+ 和 Google Drive 桌面版。没有 Basic Memory 时安装固定版本 1.0.0。Mac 的 Finder 选择和 LaunchAgent 仍待真机验收。

## 安装内容

- 已有 JOPT Basic Memory 项目时复用现有程序、配置、笔记。Codex 与 ChatGPT 桌面使用现有的本地连接配置，Claude Code 使用自己的用户配置。
- Codex、Claude Code 各安装同一份日语 `SKILL.md`。已有手写 JOPT 指示段落直接保留，安装器自己管理的段落可以重复安装。已有配置发生变更前会备份到 `%LOCALAPPDATA%\JOPT Memory\backups\`。
- Claude Code 的 `settings.json` 只在 `permissions.allow` 补齐 `mcp__basic-memory-jopt__bm_write` 与 `mcp__basic-memory-jopt__bm_edit`。现有 Codex MCP 配置保留，缺少许可时提示。保留的手写指示如需采用新规则，请自行追加。
- Claude 桌面与 ChatGPT 的连接器写入许可由应用和组织策略管理。如果应用显示「始终允许」且组织允许，请在应用里只为所需工具设置；安装器无法替它们改账号级审批。
- 本机新生成的指示文件默认沿用现有客户端指示段落语言，缺省时用操作系统语言（中、日、英之外使用英语）。可用 `--language zh|ja|en` 或各客户端的语言参数指定。业务笔记按当次对话语言写，可被明确的语言要求覆盖。
- ChatGPT 普通聊天、Claude 普通聊天的账号级规则由本人粘贴。安装后在 `%LOCALAPPDATA%\JOPT Memory\instructions\` 取得 `ChatGPT-Instructions.md`、`Claude-Chat-Instructions.md`。如果 Claude 桌面需要另外配置本地连接，使用同目录 `Claude-Desktop-MCP.json` 作为待合并的配置片段，先核对客户端使用的是哪份配置文件。Grok Bot 的 `Grok-Bot-Instructions-UNVERIFIED.md` 是留给同事实测的指示草案。
- Windows 使用当前员工的登录身份注册每小时一次、登录时补跑的上传任务，仅批量复制 `jopt-history/` 中的 Markdown 及既有根目录的事前预约笔记。本地删除不会同步成远端删除。目标出现独立改动时保留该副本并在 `upload-status.json` 记错误。电脑下线或挂载目录未就绪时，下次可用运行再试。状态中的成功表示写入 Drive 本地挂载，首次安装需在 Drive 网页核对文件。

## 隔离重装与人工验收

- 用 `Install.cmd --preview --destination "…"` 核对路径和配置，可用 `--user-home`、`--state` 和 `--no-schedule` 在隔离目录验收。
- 准备做实际重装对比时，先分别备份现用 `AGENTS.md`、`CLAUDE.md` 和两份 Skill。只移动约定的指示文件，不移动笔记库、Basic Memory 配置或其他个人设置。安装后对比两份 Skill 的 SHA-256，再比对新指示的 JOPT 规则。新生成的文件只含该安装器管理的规则，整份旧账号指示文件可从备份恢复。
- 完全退出并重新开启 ChatGPT 桌面和 Claude Code。在一个新的本地会话中，先读正式例题，再由其中一方新建一条获准的模拟笔记，另一方回读。建议也用一项不触发归档的一般问答作为对照。
- 在试点正式目录仅选用已批准上传的业务记录。模拟笔记排除在上传外。上传验收是检查一份实际变更的笔记在 Drive 网页可读，随后关掉 Drive 客户端，恢复后检查是否补传。
- 换电脑后，核对云端文件夹链接和本地正本，再用 `--adopt-destination` 接续已有上传目录。首次接续时，目标中的不同版本会保留并报告。
- 审核账号级普通聊天指示后，在其账号设置内应用，再开新会话验证。Grok Bot 需由同事在指定测试文件上确认连接器和本机权限。

[ChatGPT 与 Codex MCP](https://learn.chatgpt.com/docs/extend/mcp) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Grok Bot Skills](https://docs.x.ai/grok-bot/skills-routines-and-automations)
