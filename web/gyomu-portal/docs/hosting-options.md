# 业务门户托管方案比较

核对日期：2026-11-19（Asia/Tokyo）。本文件是方案与费用比较，未创建服务器、购买服务或部署门户。金额为 USD、税前；估算不含新域名注册费和人工运维费，不使用试用赠金抵扣。

**按“尽快给同事使用、保留现有代码”的目标，优先单台 VPS＋本地持久磁盘；不想自行维护 Linux 时，选单台 Fly Machine＋Volume。** 现阶段没有必要因 133 条资料信息先引入新的业务数据库。若继续采用 ChatGPT Sites／Cloudflare，应把 D1、R2 和预览生成的适配作为明确开发任务；Cloud Run 不是把现有 SQLite 文件挂上持久盘就能完成的替代方案。

## 已核对的代码与数据

| 项目 | 当前实现及其部署影响 |
| --- | --- |
| 服务 | `package.json` 要求 Node.js ≥22.19；`src/local.ts` 使用 Hono 的 Node HTTP 服务，当前监听 `127.0.0.1`。 |
| 数据库 | `src/db.ts` 使用同步 `node:sqlite`、WAL、SQLite 事务；当前数据库约 1.14 MiB。需要真实持久存储和可靠文件锁。 |
| 文件 | `src/storage.ts` 通过 `BlobStore` 接口读写本地文件。当前 `.local/blobs` 约 377 MiB，包括缩略图、MD 和历史 HTML 的预览输入副本；资料主入口仍是 Drive／其他外链。 |
| 预览 | `src/preview-renderer.ts` 启动本机 Chromium，`src/previews.ts` 串行生成并缓存图片。纯 Workers 运行时不能直接沿用这一子进程。 |
| 登录 | Google 登录凭据与托管选择分开。`http://127.0.0.1:8788/auth/callback` 是本机验证地址；同事使用正式网站时，还需登记该站点的 HTTPS 回调地址。 |

## 方案与月费

费用样例按单实例、轻量内部使用估算。1 GiB 机器仅用于价格比较，Chromium 预览的内存表现尚未压测；正式初配优先预留 2 GiB。

| 方案 | 能否保留 Node＋SQLite＋本地文件 | 费用依据与预算 | HTTPS／域名 | 备份与主要代价 |
| --- | --- | --- | --- | --- |
| 小型 VPS：以东京可用的 AWS Lightsail Linux 为例 | 可以，改动最少。Node 与 SQLite 在同一台机器，数据目录落在持久 SSD。 | 官方 IPv4 套餐：1 GB **$7/月**，2 GB **$12/月**，后者含 60 GB SSD、3 TB 流量额度。快照 **$0.05/计费GB/月**；假设快照计费量为 10 GB，2 GB 方案约 **$12.50/月**，超额流量另计。[官方价格](https://aws.amazon.com/lightsail/pricing/) | 现有公司子域＋Caddy 自动申请、续期证书；不需要为 HTTPS 额外买 Lightsail 负载均衡器。[Caddy HTTPS](https://caddyserver.com/docs/automatic-https) | 应用一致性数据库备份＋文件副本＋机器快照。需要有人负责 OS 更新、进程重启、磁盘和备份告警。单机故障期间会中断服务。 |
| Fly.io：单 Machine＋Volume | 可以。数据库和文件放 Volume，不能放临时 rootfs。保持单实例写入；Volume 不自动在实例间复制。 | 已核实的**新加坡**样例：1 GB Machine **$8.50**＋10 GB Volume **$1.50**＋10 GB 亚太公网出站 **$0.40**＝约 **$10.40/30天**；假设快照总存量不超过首 10 GB 免费额度。东京需在官方地区计算器重算，不能套用美国最低价。[官方价格与计算器](https://fly.io/docs/about/pricing/) | `.fly.dev` 入口；支持自定义域名。当前首 10 个单域名证书免费，共享 IPv4 免费，无需默认购买独立 IPv4。[网络与 TLS](https://fly.io/docs/networking/services/) | 平台每日 Volume 快照默认保留 5 天，可设 1～60 天；另做独立的 SQLite＋文件备份。单 Volume 不构成高可用。[Volume 限制](https://fly.io/docs/volumes/overview/)／[快照](https://docs.fly.io/volumes/snapshots) |
| Google Cloud Run | **不能安全原样迁移当前持久 SQLite/WAL。** 需外置数据库及对象存储，或选择有本地持久盘的 Google Compute Engine VM，后者属于 VPS 路线。 | 计算服务按量，轻量用量可能落在免费额度；数据库、文件存储、出站、构建与镜像仓库另计。官方默认地区请求计费示例：CPU **$0.000024/vCPU秒**、内存 **$0.0000025/GiB秒**；免费额度为每月 180,000 vCPU秒、360,000 GiB秒、200万请求。**这不是含持久数据库的总报价**，东京需用实际区域与运行时长核算。[官方计价](https://cloud.google.com/run/pricing) | Cloud Run 在平台终止 TLS；容器监听 `0.0.0.0:$PORT`，现有 `127.0.0.1` 监听需要调整。[运行约定](https://docs.cloud.google.com/run/docs/container-contract) | 默认文件系统随实例停止丢失。可挂载的 Cloud Storage FUSE 和 NFS 也不能替代当前 SQLite 的本地磁盘；数据库改造、存储迁移和恢复验证的工作量高于 VPS／Fly。 |
| Cloudflare Workers＋D1＋R2 | 需要适配。Hono 路由与大部分页面可保留；同步 Store／事务逻辑改为 D1 API，文件接口换 R2，Chromium 预览另选运行方式。 | Free 范围内可为 **$0**；生产预算可从 Workers Paid **账户最低 $5/月**起算，并非每个 Worker 各收 $5。D1 Paid 含 5 GB，超出 **$0.75/GB月**；R2 Standard 每月含 10 GB，超出 **$0.015/GB月**并按操作量计费，无公网出站费。已有公司 Paid 账户时，先确认是否产生新增基础费及共享额度余量。[Workers](https://developers.cloudflare.com/workers/platform/pricing/)／[D1](https://developers.cloudflare.com/d1/platform/pricing/)／[R2](https://developers.cloudflare.com/r2/pricing/) | 可先用 HTTPS `workers.dev` 域名，不必先买域名；正式业务优先现有公司自定义域名。[域名入口](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) | D1 Time Travel：Free 7 天、Paid 30 天；需要更长期的定期 SQL 导出。R2 文件另做独立副本，D1 恢复不等于文件也恢复。[D1 备份](https://developers.cloudflare.com/d1/reference/time-travel/) |

Fly 的样例采用当前官方已列出的新加坡价格，按 30 天连续运行计算；它不是东京或 2 GiB 机器的报价。需要 2 GiB 或增加实例时应重新估价。Lightsail 的 10 GB 快照计费量是本方案假设，实际保存的快照及变更块决定账单。已有公司子域没有新增域名注册费；若另买域名，按选定注册商的续费价格计入。

## Cloud Run 的“持久盘”为什么不能直接解决

当前代码明确启用了 WAL。SQLite 的 WAL 要求共享同一主机的内存和文件锁，不能用网络文件系统替代本地盘。[SQLite WAL 机制](https://www.sqlite.org/wal.html)

Cloud Run 默认可写文件系统在内存中，实例停止即丢失；Cloud Storage FUSE 不提供文件锁，多个覆盖写遵循最后写入者结果；Cloud Run 的 NFS 卷以 no-lock 模式挂载。因此，即使限制单个实例，也不能把这些卷描述为已验证可用的 SQLite 持久方案。[默认文件系统](https://docs.cloud.google.com/run/docs/container-contract#file_system_access)／[Cloud Storage FUSE 限制](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts#limitations)／[NFS 限制](https://docs.cloud.google.com/run/docs/configuring/services/nfs-volume-mounts#limitations)

若公司必须使用 Cloud Run，先选外部事务数据库与对象存储，再重算数据库最低配置、备份、网络及运行时长费用。若目标仍是保留 SQLite，Google Compute Engine 上的单台 VM＋持久磁盘比 Cloud Run 更接近现有实现。

## Cloudflare／ChatGPT Sites 的实际改造范围

| 部分 | 保留与改造边界 |
| --- | --- |
| 数据库 | `Store.one/all/run/transaction` 目前全部同步；D1 通过异步 prepared statement／batch 调用。需要向 Catalog、认证、MCP、统计路径传播异步，并重新验证事务原子性、并发更新和权限检查，不能只替换连接字符串。[D1 接口](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| 文件 | 已有异步 `BlobStore` 接口，新增 R2 实现即可承接现有调用；原资料继续放 Drive，不必搬进 R2。需迁移的是门户仍引用的缩略图、MD 等文件。 |
| 预览 | Workers 的 `node:child_process` 与 `node:sqlite` 是不可执行的兼容占位模块；`node:fs` 的临时写入也不跨请求持久化。现有本机 Chromium 子进程需改成在登记端预生成图片，或接独立浏览器渲染服务，后者另行核价。[Node 兼容性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#non-functional-stub-modules)／[虚拟文件系统](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) |
| ChatGPT Sites | 当前已安装 Sites 工具的部署约定同样是 Worker ESM（`dist/server/index.js`）＋D1／R2绑定，不是持久 Node 进程。它能代管托管资源配置，但不会消除上述代码适配。Sites 的账户计费不能直接等同于 Cloudflare 单独购买的报价，需在实际账户能力／账单中确认。依据：本机 Sites 1.1.7 的 `SKILL.md` 与 `references/storage.md`，核对于 2026-11-19。 |

## 采用 VPS／Fly 后的最小上线边界

保留单个 Node 服务及一个 SQLite 写入点。VPS 上由 Caddy 接外部 HTTPS，再转发到本机 Node；Fly 容器则把服务监听地址改为 `0.0.0.0`，把数据库和文件目录指向挂载的 Volume。将 `APP_ORIGIN` 设为正式 HTTPS origin，配置 Google 正式回调 URL，凭据保存在运行环境的 secret／未追踪配置中。

数据库每天通过 SQLite Online Backup API 生成一致性副本，与其引用的 Blob 文件一起另存；不要在写入时只复制 `.sqlite` 主文件、遗漏 WAL。备份目标应独立于主机／主 Volume；建议保留每日和每周版本，并用独立目录实际恢复一次，再开放给同事。[SQLite 在线备份](https://www.sqlite.org/backup.html)

首批验收包括：正式 Google 登录与账号切换、私有资料隔离、MCP 权限及令牌撤销、进程重启后数据仍在、备份可恢复、Slack 跳转使用正式站点地址。当前本机测试通过不等于这些托管环境中的验收已经完成。
