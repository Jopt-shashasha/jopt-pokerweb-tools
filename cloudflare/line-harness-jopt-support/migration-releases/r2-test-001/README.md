# R2 test release 001 — prepared, not deployed

基于 Cloudflare 实际部署版本 `d11cc332-914f-4ddb-9f3c-c8b9f30e1aaa` 的 8 个已校验模块制作。没有从本地旧 TypeScript 或旧 GitHub 代码重新构建。只在原有对象存储 resolver 插入适配层，其他 7 个模块保持逐字节一致。现有 ASSETS 前端资源没有包含在导出中，发布时必须保留。

## 测试行为

- 新增私有绑定 `IMAGES_R2`，桶名 `line-harness-jopt-support-images`，Standard，Public Access Disabled。
- `R2_WRITE_MODE=test` 才开启双写；`off` 或未配置时仍写 Appwrite。
- `R2_TEST_ACCOUNT_ID` 和 `R2_TEST_LINE_USER_ID` 必须同时命中；直接 LINE 图片及 FAQ 表单图片均通过数据库验证归属。
- 只对选定账号双写 Appwrite + R2。两边都成功才视为上传完成，R2 失败沿用现有重试流程。
- 选定账号图片优先读 R2，未找到或 R2 故障时读 Appwrite。旧图片无需提前迁移。
- 关闭写入测试后仍能读取测试期间的图片；撤回/清理会删除两边副本。其他用户及视频逻辑保留原路径。
- 不改数据库结构、LINE webhook、自动回复、通知文案或前端；不回放历史事件。

## 已验证

`node --test storage-adapter.test.mjs`：10 项测试通过。SQL 使用本地 SQLite 执行，覆盖用户/账号/文件键隔离、FAQ 路径、两端故障、重试、关闭开关后的读取、双端撤回清理及原有列表接口。

候选 8 个模块语法检查通过，只有 `assets/worker-entry-CyzYNkRe.js` 发生变化。原始备份校验通过。**这些是本地验证，真实 Cloudflare 上传、读取、撤回和回退演练尚未执行。**

## 回退

常规回退设 `R2_WRITE_MODE=off` 并保留此兼容适配层、测试归属配置和 R2 绑定，停止新 R2 写入但继续读/清理两边。不要删除测试归属变量或解绑桶。

测试中成功上传的图片在 Appwrite 有镜像，但如果需要直接退回原始 Appwrite-only 部署，仍须先核对测试图片清单、Appwrite 镜像及撤回状态。退回旧版后它无法清理 R2；必须保留兼容清理机制，避免撤回后留下 R2 孤立副本。数据库不整体还原到旧快照，以免覆盖上线期间的新客户记录。

## 尚未完成

1. 正式项目归档：当前会话对 `D:\GitHub` 写入被拒绝。
2. 私有桶已创建；Worker 绑定和测试变量尚未发布。
3. 候选测试身份为 `ショウ.Sha`，仍须确认是用户本人；不得仅按显示名开启分流。
4. 发布前重新读取活动版本；版本变化则停止并重新导出。保留现有全部 secrets、绑定、ASSETS、触发器及 Durable Object 配置。
5. 记录 D1 恢复点，核对需要的少量记录及图片清单；测试版不修改数据库 schema。
6. 真实发图/FAQ 上传、读取、撤回、关闭开关后回读和其他用户原路径检查。
7. R2 额度监控接入原有服务残量页面以及历史图片迁移，属于后续阶段，当前版本不包含。
