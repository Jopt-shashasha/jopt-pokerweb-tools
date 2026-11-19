# ChatGPT Sites 改造清单

部署目标为可通过 HTTPS 访问的 Worker、D1 和私有 R2。新资料登记创建者已经发布的 HTTP(S) URL。R2 用于保留既有缩略图和历史附件。

## 1. 数据库

- [x] Worker 使用异步 D1 适配器。Node 的 SQLite 适配器用于本地开发、迁移和回归测试。
- [x] Worker 调用链已切换至异步查询。资料写入与搜索索引、浏览器确认登记、一次性设定码及 Slack 发送占位使用原子写入。
- [x] 构建时从 `migrations/001`～`016` 生成 Sites 的 Drizzle 迁移。已在 Miniflare 的 D1 上执行，Worker 请求内不运行迁移。

## 2. 文件

- [x] Worker 绑定私有 R2，沿用现有资料权限检查后提供缩略图和历史 MD。
- [x] 从本地目录导出 66 个实际引用的预览文件，共 3,088,905 字节。133 条记录均有原件 URL。

## 3. 缩略图

- [x] Worker 直接读取已有缩略图。缺少缩略图时使用现有自动封面，无需运行 Chromium。

## 4. 入口和环境变量

- [x] `npm run build:sites` 输出 `dist/server/index.js` 和 `dist/.openai/hosting.json`。静态 HTML、JS、CSS 和 PowerShell 脚本随构建嵌入。
- [x] 使用 `nodejs_compat` 的 Worker 环境完成了兼容性测试。登录和设定码的限流使用 D1。
- [x] Worker 从环境变量读取配置。必填 `APP_ORIGIN` 为站点 HTTPS origin，可配置 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`ALLOWED_GOOGLE_DOMAINS`、`INITIAL_ADMIN_EMAIL`、`NEWS_FEED_URLS` 和 `SLACK_WORKSPACE_URL`。Slack 实发同时需要 `SLACK_SEND_ENABLED=true` 和 `SLACK_BOT_TOKEN`，默认只预览。

## 5. MCP

- [x] Worker 通过 `/portal-mcp` 提供 Streamable HTTP，避开 Sites 保留的 `/mcp`。个人令牌可以搜索、读取和准备登记。实际登记需同一门户身份在浏览器确认。本地 Node 入口保持 `/mcp`。
- [x] `portal_register_link` 会要求 AI 询问可选的对象、作业、使用前效果、使用后效果及频率。使用者不知道的数据留空。
- [x] 本地 stdio 版仍可用于本地开发。

## 6. 数据迁移

- [x] SQLite 导入和修复脚本继续作为离线工具。只读迁移快照导出命令如下。
- [x] 在隔离 D1／R2 中实跑迁移，逐行校验 14 张表，并逐个校验 66 个文件的 SHA-256。保存资料 ID、原 URL、创建者、状态、可见范围、活动分类、标签和搜索数据。新环境由 Google 重新登录、重新签发 MCP 令牌。
- [x] 私有 Sites 的正式 D1／R2 已导入相同快照。正式 Worker 校验 R2 对象后一次提交 D1，并记录绑定快照 SHA-256 的迁移标记。已核对正式 D1 的标记，移除一次性凭据并确认线上导入接口返回 HTTP 404。
- [ ] 核实正式 D1 的恢复能力和保留期，安排定期导出及 R2 备份。现有 SQLite 备份脚本用于保留本地回退快照。

```powershell
npm run build:sites
npx tsx scripts/sites-transfer.ts export .local/sites-transfer
npx tsx scripts/sites-transfer.ts verify .local/sites-transfer
```

快照目录含内部数据，留在 Git 忽略的 `.local`。导入要求目标 D1 为空，同一快照可安全重跑。生产导入前保留源库，并确认目标读写权限。

## 7. 部署地址

- [x] 独立的 Sites 项目已私有部署，`APP_ORIGIN` 已指向 [JOPT 業務ポータル](https://jopt-gyomu-portal.xhpc007.chatgpt.site)。
- [x] Codex 设置脚本、MCP 链接和 Slack 门户跳转从 `APP_ORIGIN` 生成，Worker 测试使用独立域名确认。
- [ ] Google OAuth 客户端目前仅登记本机回调。追加 `https://jopt-gyomu-portal.xhpc007.chatgpt.site/auth/callback`，在 Sites 配置客户端凭据并验证公司账号登录。
- [ ] 从员工浏览器和 Codex 客户端验证站点访问。Sites 的站点访问设置须允许员工到达门户和远程 MCP，门户继续按 Google Workspace 身份控制资料访问。

## 8. 测试

- [x] `npm test` 跑 57 项 Node／SQLite 回归测试。
- [x] `npm run test:sites` 用 Miniflare 验证 Worker、D1 和 R2，包括私有资料与缩略图、浏览器确认、令牌撤销、设定码唯一消费、并发写入、Slack 超时重发拦截，以及 `/go` 跳转。
- [x] 正式 Worker 健康检查返回 HTTP 200。无门户会话访问资料接口或无令牌访问 `/portal-mcp` 返回 HTTP 401。
