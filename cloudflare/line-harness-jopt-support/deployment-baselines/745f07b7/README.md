# 当前线上基线 745f07b7

Cloudflare 账号 `9b50e8cea0fe5553c90404e7757fe679`，Worker `line-harness-jopt-support`。

指定版本导出：`745f07b7-e847-4fd5-b5d6-dc8567b4a590`。实际部署 ID 为 `d9acbf1e-e4a9-4709-9a47-2bdfa1b8b776`。原始 multipart、8 个模块及 SHA-256 清单保留，不从旧源码重建。

`node verify-baseline.cjs` 验证原始包及全部模块。`capacity-page.js` 来自当前线上服务残量页面，独立记录 SHA-256。

这是个人 R2 测试已通过且测试图已撤回后的代码/配置基线。静态 ASSETS 全量、数据库数据、存储文件及 secret 值不包含在此备份；bindings-reference.json 仅包含非秘密配置和 secret 名称。不能把本包当成全量数据备份。

该版本只支持个人测试分流。全员写入 R2 之后，不可直接退回这个版本并假设所有新图可读。应使用后续已验证的全局 R2 读取兼容版本关闭新 R2 写入作为常规回退点，或先回拷验证仍有效的新图片。
