# 2026-09-08 记忆检索升级发布记录

用户明确要求“推送部署，并且重写实验报告……禁止造假”。本次发布固定产品 `3db20382639954e1185caa1341990b4ed5ab9521`，代码已推送 `origin/main`；后续实验工具与文档提交不改变本次产品镜像。实验结果见[扩展报告](../competition/MEMORY_ABLATION_REPORT.md)。

## 目标与版本

- 站点：`https://learn.learnflow.club`。
- ECS：`i-n4a084s5nh57syfytgfe`，`cn-wuhan-lr`。
- 源包来自固定 commit 的 git archive，SHA-256：`0a7e8ff8bd500272915dd37716ad576c91a96f9fd1981a132ce46f6ef6c73d0e`。
- 发布目录：`/opt/ceg/releases/memory-3db2038`，私有权限；配置和数据库备份仅留服务器，不导出。
- API / memory-worker 镜像：`sha256:4e405aeb469f982d4e2214e7eba18bbd4de312dfb5dd0bbff81f167a3d5a30a0`。
- Frontend 镜像：`sha256:4d243c72ae9af271326baa17e0036131d487e5ab2a81f950a39d204f00517ca4`。
- 两个镜像 OCI revision label：`3db2038`。

## 构建与切换

分别捕获三服务原有 Compose 链、运行环境、command、entrypoint、挂载与配置 hash。先比较 backend requirements 和 frontend lock 文件与运行镜像一致，再基于现有依赖镜像复制固定源码重建，保留实际已有依赖。不是从空白基础环境进行供应链重建。

先在新镜像上以 `--network none`、临时目录、没有线上卷的方式验证注册表、API、296 个视觉预览与 9 个记忆检索用例，再生成逐服务 apply/rollback 文件并校验实际 Compose 合并结果。

切换前对现有数据卷的 6 个 SQLite 文件使用在线 backup API，并验证每份备份 `PRAGMA integrity_check=ok`。备份保持服务器本地 0600；未迁移 schema、未导出真实学习数据。

2026-09-08 11:20（北京时间）启动切换，依次 `--no-deps --no-build --pull never` 更新 LearnFlow backend、memory-worker、frontend。每次先检查没有并发配置变化，切换后确认其他服务 fingerprint 不变。脚本具有失败回滚路径；本次正式 apply 未触发回滚，最终状态 `DEPLOYMENT_SUCCESS 3db2038`。

## 实際验收

11:25 的脱敏只读审计记录：

| 检查 | 实际结果 |
|---|---|
| Backend | running / healthy |
| Memory worker、frontend | running；没有各自 Docker healthcheck，因此不写成 healthy |
| 容器内 `/ready` | HTTP 200 |
| 容器内架构校验 | valid=true，registry `2026-09-08.5` |
| 读取策略 | `relevance-budget.v1` |
| 共享检索源码 hash | `8318a21d947d7032a8379f7bab51dee2e3cd20f061a20cab3b453ccdf73f07db` |
| 三项服务 environment / mounts | 与发布前逐项一致 |
| Role Atlas、proxy、Caddy | container ID 与本轮发布前相同 |
| 已有 role-atlas-job-worker | 本轮未替换，审计时仍为之前的 exited 状态，未声称修复 |
| 隔离镜像测试 | 9 passed，3331 warnings，7.23 s |
| 镜像 registry/API/预览 | 296 个预览检查通过 |
| 前端镜像编译 | npm run build 通过 |

11:22 的无凭据外部 HTTP 检查：站点根路径被导向登录页面并返回 HTML 200；`/health` 同样经过登录跳转，**不能把该 HTML 200 当作公开健康 API 成功**。`/api/architecture/validate` 与 `/api/learner-state/context` 均返回 401。服务健康依据上表容器内 `/ready`，外部检查只证明入口与匿名访问边界。

未在生产库写测试学习事件，未执行真实用户学习会话、在线 LLM 教学评价或桌面安装包发布。线上镜像核验不等于完整人工 UI 验收。

## 失败及协调记录

- 首次构建将裸 `sha256:...` 写进 Dockerfile FROM，被 Docker 当作远程仓库名称，随后拉取超时。未切换任何服务。改成唯一的本地基础镜像标签绑定同一已核验 image ID 后重建通过；初次失败状态保留。
- 首次附加只读审计直接 import `learnflow_core`，尚未经 `app.main` 初始化共享源码路径，出现 ModuleNotFoundError。按正常初始化顺序执行后通过；这是探针错误，没有改线上源码或重启服务。
- 11:25 收到另一任务的跨站发布协调信息后，本任务停止云端写入，交接精确镜像 ID 和兼容性。后续 Role/proxy/Caddy/worker 的跨站发布由该任务处理；它可保留本次新镜像、按其授权追加 CORS。此处状态是带时间的本次部署审计，不冒充后续任务结果。

旧镜像与 rollback JSON 保留在本地服务器。回滚应由当前唯一发布任务重新检查现有 Compose 状态后执行，不能在其他任务已更新配置后直接套用旧文件。

**Contract impact：** 产品 commit 增加只读检索元数据并改进选择与过滤，保留 ContextPacket v2、事件/五核写入链、HTTP 入口和 DB schema；没有破坏性迁移。本文和本轮实验工具不新增产品契约。
