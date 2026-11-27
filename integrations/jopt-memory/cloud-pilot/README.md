# JOPT Memory 云端试点

公司主机上的 Caddy 提供 HTTPS。MCP 网关通过 Google OAuth 验证试点账号，只提供 `bm_search`、`bm_read`、`bm_write` 和 `bm_edit`。Basic Memory 限定为独立的 `main` 项目，后端端口仅在容器网络内可访问。桌面和网页端应连接同一个远程项目。

## 部署

1. 准备公司控制的 Linux 主机、Docker Compose 和专用 HTTPS 域名。域名解析到该主机，由 Caddy 使用 80 和 443 端口申请证书及提供服务。
2. 在公司 Google Cloud 项目创建 Web 应用 OAuth 客户端，注册 `https://<MCP_HOST>/auth/callback` 为回调地址。使用公司内部受众。若应用处于外部测试模式，在 Google 侧登记试点账号。
3. 将 `.env.example` 复制为 `.env`，限制其读取权限。填入域名、Google OAuth 客户端 ID 和密钥、唯一允许的 Google 邮箱。
4. 在本目录执行 `docker compose config --quiet` 和 `docker compose up -d --build`。从目标客户端添加 `https://<MCP_HOST>/mcp`，选择 OAuth 登录。确认工作区允许添加连接器及写入工具。
5. 容器卷会保存 Markdown、索引和 OAuth 状态。将 `notes` 卷中的 `basic-memory/` 目录作为 Markdown 导出来源。离职交接归档需要按现有流程批准后，再保存到公司共有 Drive。恢复时可在隔离的 Basic Memory 实例导入 Markdown 并重建索引。

## 验收

- 未登录访问 MCP 应返回 401。用另一 Google 账号登录后应无法列出或调用记忆工具。用试点账号登录后应只看到四个工具。
- 员工电脑断网后，从另一台设备的目标云端客户端连接。用 `main` 项目新建 `jopt-tests/cloud-mcp-smoke.md`，写入唯一模拟标记，再从另一客户端搜索、回读并核对正文。编辑已有笔记时传回读得到的 `expected_checksum`，验证过期校验值不会覆盖新内容。
- 重启服务后回读，再从导出的 Markdown 在隔离实例重建索引并核对。验证连接器写入所需的审批。另开会话，只交代一项可交接的模拟任务，检查现有长期指示能否触发主动归档。
- 多人接入前，需由服务端按账号隔离记忆库并验收跨账号访问。此部署每套只配置一个账号和一个项目。

[Basic Memory 容器部署](https://docs.basicmemory.com/reference/docker) · [ChatGPT 自定义 MCP](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) · [Claude 远程连接器](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
