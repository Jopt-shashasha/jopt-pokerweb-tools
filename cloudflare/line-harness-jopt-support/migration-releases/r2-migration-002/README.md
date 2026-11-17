# r2-migration-002

状态：已准备、未部署；选定候选为 **candidate-rc2**。

## 来源

基于本次从 Cloudflare 指定版本接口导出的 `745f07b7-e847-4fd5-b5d6-dc8567b4a590`，8 个模块均有原始包及 SHA-256 校验。服务残量页的 JavaScript 也来自当前部署网站。没有用旧 TypeScript / GitHub 重新构建。

只修改主 Worker 模块；现有其他 7 个模块、通知和聊天页的两份已有修正保持不变。原始 ASSETS、secrets、D1、Durable Object 和定时任务保留。无数据库 schema 变更，不修改 LINE webhook，不重放历史消息。

## 行为

- `R2_WRITE_MODE=test`：保持当前仅本人双写测试。
- `R2_WRITE_MODE=all-mirror`：全员图片双写，两端都成功才算完成；仅用于短期核验。
- `R2_WRITE_MODE=all`：新图片只写 R2，不依赖 Appwrite 是否休眠；非图片仍沿用旧路径。
- `R2_WRITE_MODE=off`：新文件回写 Appwrite。保留 `R2_MIGRATION_READS=enabled` 时，已迁移图片继续优先读 R2，并同时清理两端。
- `R2_MIGRATION_READS=enabled`：迁移前先启用所有图片的 R2 读取/清理兼容。R2 不存在或临时读取失败时，回读 Appwrite。
- `R2_MIGRATION_ENABLED=1`：仅 owner 可使用的临时复制入口。任务结束后取消该开关。

迁移入口：`/api/storage-migration`。它沿用现有登录和 CSRF 保护，不创建新凭证，不向浏览器提供服务端密钥。每批最多 3 张，保留原 key、内容类型及 Appwrite 原件；复制后回读 R2 并比较 SHA-256。冲突不覆盖；撤回、已删除和无法关联的私有图片跳过；复制中发生撤回时删除新 R2 副本。每批结果保存到私有 `_migration/r2-migration-002/` 审计目录。中断后可以重新检查并重复执行。

## 监控

沿用服务残量页，增加 R2 保存量、A 类、B 类三张卡，使用现有 Cloudflare 分析 token，不新增秘密值。范围为账号整体；分析值存在延迟/采样，不当作最终账单。读取失败显示未取得，未知操作类型不会按零算。

`R2_BILLING_ANCHOR` 未确认时，操作次数明确展示为过去 31 日的保守参考，不编造重置时间。确认官方账期后才配置该变量。10 GB-month 不是每月清空磁盘；当前保存量仅作参考，最终按账期日峰值的平均计费。A/B 超额会计费，不是硬性停用上限。

## 验证

```powershell
node --test migration.test.mjs capacity-reader.test.mjs ..\r2-test-001\storage-adapter.test.mjs
node prepare-release.cjs --verify candidate-rc2
```

28 项本地测试通过；候选 8 个模块和容量页语法通过。上线后仍须做 FAQ 表单上传、写开关关闭后的读取、原图撤回、监控数据权限/界面和全员路径验证。当前发布包尚未上线，尚未复制旧图片，尚未全员切换。

## 发布和回退

1. 将本次基线和选定候选归档到正式项目。发布前再次核对活动版本；如不为 `745f07b7`，停止并重新导出核对。
2. 保留全部现有配置，先以个人测试模式发布。迁移开关默认关闭。
3. 测试 FAQ 上传及关闭新 R2 写入后的读取，确认额度接口的实际权限和页面。
4. 开启迁移读取兼容，再开启 owner 复制入口，分批复制。核查每项失败/冲突，不把未存成功的历史图片说成已恢复。
5. 核验后进入短期全员镜像测试，再切到 `all`；结束时关闭迁移写入口。
6. 保存一个已验证的“全局读取兼容 + 新写入 off”配置版本，作为常规回退点。

切到 R2-only 后的新图片不保证在 Appwrite 有副本，不能直接切回 Appwrite-only 旧代码。常规回退保留本版全局读取兼容和 R2 绑定，将 `R2_WRITE_MODE=off`。如需要彻底恢复原版，必须先将仍有效的 R2-only 新图片另行回拷验证；不可恢复旧 D1 快照覆盖新客户记录。Appwrite 原件不自动删除。

## 待完成

正式目录归档、实际部署、FAQ/开关实测、全部旧图迁移校验、监控 API 权限核验、全员切换均未完成。当前线上仍为个人测试版 `745f07b7`。
