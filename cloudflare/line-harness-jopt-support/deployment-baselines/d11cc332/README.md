# Harness 线上部署基线（2026-11-17）

这是从 Cloudflare 当前生效部署导出的 Worker 模块，不是从本机或 GitHub 旧源码重新构建的代码。

- Worker：`line-harness-jopt-support`
- Cloudflare 版本：`d11cc332-914f-4ddb-9f3c-c8b9f30e1aaa`
- 部署记录：`6d2313b8-cb99-46d6-a482-30f517703332`
- 原部署时间：2026-11-06 18:11:44（Asia/Tokyo）
- 原部署说明：Support LINE Manager default menu during FAQ release
- 原始部署包：`deployed-worker.multipart`
- 解包后的 8 个模块：`bundle/`
- 模块及原始包 SHA-256：`manifest.json`
- 部署记录：`deployment.json`
- 普通变量、资源绑定和密钥名称：`bindings-reference.json`

## 验证

安装了 Node.js 的电脑，在本目录执行：

```sh
node verify-baseline.cjs
```

验证原始包及所有模块的字节数、SHA-256 和模块文件清单。验证不会连接 Cloudflare 或修改任何文件。导出时另外执行了 JavaScript 语法和真实模块导入检查，结果见 `verification.json`。

## 作为 GitHub 基线

把整个文件夹放到现有项目的 `deployment-baselines/d11cc332/` 目录中，由负责人审核并提交。保留旧开发源码，但必须标明：本次后续改动以此线上部署基线为准，旧源码不能直接构建后覆盖线上。

新版本另放独立目录，保留与本基线的差异、测试结果、部署版本号和回退目标；不要修改本目录内的原始模块和校验清单。

## 范围与限制

本包包含部署后 JavaScript 模块，不能称为已恢复原始 TypeScript、注释、构建工程或提交历史。

本次导出接口省略 source maps；不包含 ASSETS 绑定中的前端静态文件、D1 数据、Durable Object 状态、Appwrite 图片或密钥原值。`bindings-reference.json` 也不是可以直接用于重建环境的完整 Wrangler 配置。

因此，本包是可校验的 Worker 代码基线，不能单独用于全新账户的完整灾难恢复。当前 Cloudflare 版本仍保留在线，回退优先使用其版本 ID；详见 `ROLLBACK.md`。

本次没有修改线上代码、数据库、存储位置或 GitHub。
