# 2026-09-08 记忆长尾升级发布记录

产品提交 **7276b1b4c86e5eb2738e520c130e22b125d0ea93** 已推送 `origin/main`，并于北京时间 **2026-09-08 12:55:12** 开始切换，操作耗时约 18.45 秒，最终成功。实验与已知限制见[长尾实验报告](../competition/MEMORY_LONG_TAIL_REPORT.md)。

## 版本与发布范围

- 站点：`https://learn.learnflow.club`；ECS `i-n4a084s5nh57syfytgfe`，`cn-wuhan-lr`。
- 共享核心 0.2.3，Web registry `2026-09-08.6`，读取策略 `relevance-budget.v2`。
- backend 与 memory-worker 镜像：`sha256:d58934643d5b347cbe59581507e06205c34300684ae8fcfd32e2538a953cf3c5`。
- 固定 commit 的 backend + learning-core 源包 SHA256：`f0d5eb3b16256d38ebae5d8aa8b4ad22888681ccde8be8ef573b71cded882895`。
- 实际加载的 `five_kernel_context.py` SHA256：`3f34a008a75a047751e94a2b4b05e66e20a3b71c64b88e622032b268806ce021`，与双端实验完全一致。
- 发布目录：`/opt/ceg/releases/memory-long-tail-7276b1b4`，权限 0700。

本轮只替换两项记忆服务。镜像在原有依赖镜像上复制固定提交的 backend / shared-core 源码，先验证 requirements hash 一致；构建没有联网安装依赖。共享包继续由宿主同源路径加载，未宣称另行构建或安装了 wheel。未发布桌面安装包、未替换用户本机应用。

## 验证和数据边界

| 检查 | 实际结果 |
|---|---|
| 构建前配置 | fresh inspect 捕获每服务独立 Compose 链，校验实际合并后环境、挂载、command、entrypoint |
| 隔离镜像 | `--network none`，临时数据库，无线上卷；90 passed，36.75 秒 |
| 注册表与源码 | 隔离镜像及部署后两服务均验证 registry、core、retrieval version 和源码 hash |
| Backend | running / healthy；容器内 `/ready` HTTP 200；架构 valid=true |
| Memory worker | running；没有 Docker healthcheck，未标记为 healthy |
| 数据备份 | 6 个 SQLite 文件在线 backup，逐份 integrity_check=ok；备份留服务器本地 |
| 环境与挂载 | 两个替换服务部署后与捕获值相同；原有 CORS 保留 |
| 其他服务 | frontend、Role Atlas、job-worker、launch-proxy、Caddy 的 container ID 不变，环境/挂载保持 |
| 并发防护 | 使用 `/opt/ceg/role-atlas-deploy.lock`；每服务替换前 guard；结束后实测锁可获取 |
| 回滚 | 本次未触发；保留旧镜像和逐服务 rollback JSON |

保留的前端镜像为 `sha256:da69e41f666afab3999604cb47edc0fc80c3aa86a4d87d5801bc9f6a13162a77`（457af02）；Role Atlas 为 `sha256:4ac389f4f2557d88da9779b64e861e7a514ddb3b7ed9c24e44b02876dc3a6fa2`（64a5a76）。两项均由其他任务先前发布，本轮没有把它们覆盖回旧版本。

无凭据公网核验：根路径经过登录跳转返回 HTML 200，两个只读 API `/api/architecture/validate`、`/api/learner-state/context` 返回 401。HTML 200 只证明入口可达，服务健康依据容器内 ready/registry 检查。未在生产库写入测试学习事件，未执行在线 LLM 教学评价或登录后的完整人工学习会话。

此前本地隔离 demo 的 `/demo` 返回 HTML 200、`/api/demo/status` enabled=true、`/api/architecture/validate` valid=true；验收后已停止本任务的 demo 进程。初次临时启动器路径错误与沙箱回环端口限制的失败日志和成功重试均保留。

## 回滚与交接

当前各自 Compose 链分别追加：

- `apply.learnflow-backend.json`
- `apply.learnflow-memory-worker.json`

对应 rollback 文件位于同一发布目录。回滚前必须重新检查最新实际链和其他任务修改，不能盲目使用本次快照。私有配置、operation log、数据库备份不导出；后续任务已收到准确镜像、链和锁状态交接。

本地证据包 `memory-evaluation-v3-evidence.zip`：15,720,433 字节、102 个文件，包含本轮 15,336 次正式读取、独立保留的 420 次试跑、旧 Web 对照副本、原始包、评分、源码/协议 hash、检查日志和脱敏发布结果。ZIP CRC 验证通过。

SHA256：`abeebd5702fcd79c555a5c8f200100c762764b62042a0cd1a1baedd519ed0739`。证据包作为本地产物交付，未把原始大文件、SQLite 数据或秘密提交 Git。

**Contract impact：** ContextPacket v2 增量读取字段、确定性检索策略和注册版本变更；EvidenceEvent → reducer → KernelMutation → KernelState → Fact/Module/Claim、证据等级、三类主 Agent、五核写入与 DB schema 保持兼容，无新增数据库迁移。
