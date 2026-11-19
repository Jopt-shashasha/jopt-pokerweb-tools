# Claude 工作记录

更新：2026-11-19（Asia/Tokyo）。Claude 与 Codex 在同一目录工作，互相读这里和 `slack-setup.md`。
分工：Claude 改 `src/` `public/` `migrations/` `tests/` `scripts/`；Codex 管 Google OAuth、Slack App、频道清单、托管比较（`docs/`）。

## 已完成

| # | 功能 | 主要文件 |
|---|---|---|
| 1 | Codex 一键连接：按钮 → `codex://` 打开 Codex → 自动设定 | `src/agent-tokens.ts` `src/codex-setup.ps1` |
| 2 | 远程 MCP `/mcp`：个人令牌识别本人（共用 Codex 账号也可） | `src/remote-mcp.ts` |
| 3 | Codex 干活前先检索门户；可建议沿用代码/企划 | `src/codex-setup.ps1`（AGENTS.md 规则） |
| 4 | 效果一行（对象者・作業・前・後・頻度） | `src/impact.ts` |
| 5 | Slack：部门频道介绍、个人 DM、周报、测试频道 | `src/slack.ts` |
| 6 | Slack 防误发：去重、每周上限、超时记「未確認」不重发 | `src/slack.ts` |
| 7 | 点击统计 `/go/<资料ID>` | `src/slack.ts` |
| 8 | AI 新闻：Slack 推送 + 周报 + Codex 提醒 | `src/slack.ts` `src/remote-mcp.ts` |
| 9 | Codex 提醒频率：每台电脑每周 1 次（可改每天），其余返回 skip | `src/agent-tokens.ts` |
| 10 | 频道清单导入脚本（不自动开启发送） | `scripts/apply-slack-channels.ts` |
| 11 | 部署准备：`HOST` 设定、每日备份脚本 | `src/local.ts` `scripts/backup.ts` |
| 12 | 修复：导入时部门写入依赖列顺序 | `src/importer.ts` |

测试：`npm test` 56 通过 / 0 失败。迁移到 `015`。未提交 Git，未发送任何 Slack 消息。

## 未验证

- `src/codex-setup.ps1` 未在 Windows 实机运行。
- 真实 Slack 发送未测（只用了假接口）。

## 状态变更（12:31）

部署目标定为 **ChatGPT Sites**（不用 VPS/Fly）。现有代码依赖本地 SQLite/文件/Chrome，Sites 跑不了。
**Claude 暂停改代码，Sites 改造由 Codex 负责**，清单见 `docs/sites-migration-checklist.md`。

## 下一步

1. **Sha 测试**：按 `docs/test-checklist.md` 打勾，问题截图给 Claude。
2. Codex 按 `sites-migration-checklist.md` 改成 Sites 版。
3. **等决定**：推送方式（频道 / DM / 新闻频道 / 周报频道）→ 调默认设定。
4. 测试后修 Bug。

## 状态变更（14:57）

Slack 功能**先藏起来不用**：右上「Slack連携」按钮、详情页「Slackで紹介」都隐藏（`public/app.js` 的 `SLACK_UI=false`、`index.html` 的 `hidden`）。代码和接口保留。
以后要用的设想：员工登录工具 → 每周汇总 → 发到指定的一个频道（周报）。
