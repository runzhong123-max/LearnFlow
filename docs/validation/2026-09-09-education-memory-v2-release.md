# 2026-09-09 教育记忆与规划 v2 发布记录

用户明确要求“部署”。已将已验证提交 `0da6615eeb2a5dded4101535e8534cd5494b43a9` 部署到 `https://learn.learnflow.club`，目标为既有 ECS `i-n4a084s5nh57syfytgfe`（cn-wuhan-lr）。北京时间 11:20:23 开始切换，约 20.79 秒完成；11:21:56 完成后续运行源码与 HTTPS 核验。

## 发布内容

- 后端与记忆 worker 镜像：`sha256:3bb9dc104ad25cd93da034cfe455e69cd34b726484fc6b58747903545ff45241`。
- 前端镜像：`sha256:14c38d5abd1cddca947cb607fbf49c9b08962508e5a3a7a7d2a1bb6844934062`，同步保留新增教学证据来源字段。
- 三个镜像的 OCI revision 均为上述完整提交。运行共享核心 0.2.5、Web registry 2026-09-08.9、learning-plan-guidance.v2。
- 发布目录 `/opt/ceg/releases/education-v2-0da6615`，权限 0700；源包 SHA256 为 `4c87ddef482a7e812ef7694cfd73168599c10c0265f0c816765829fa11063816`。

源包逐字节核对为固定已推送提交的 git archive，只包含跟踪的 backend、共享核心、frontend、共享客户端及 docs；没有凭据、数据库或原始实验记录。构建前核对后端 requirements 与前端 package/lock hash 和现有运行时相同，复用既有依赖镜像进行无网络构建。

## 实际验证

| 项目 | 结果 |
| --- | --- |
| 新后端镜像隔离回归 | 195 passed，15955 warnings，49.72 秒；network none、临时 SQLite、无生产数据卷 |
| 新前端镜像 | `npm run build` 通过，源码探针通过 |
| 后端运行状态 | running / healthy；容器内 `/ready` 200、架构校验 valid=true |
| 记忆 worker、前端 | running，重启计数均 0；未配置 Docker healthcheck，不称为 healthy |
| 运行源码 | 后端与 worker 各 181 个 Python 文件，前端与共享客户端 197 个脚本文件，hash 全部一致 |
| 后端重启计数 | 0 |
| 配置与并发保护 | 复用发布锁；保留各服务实际 Compose 链、环境、挂载、启动参数；切换前逐服务检查漂移 |
| 数据保护 | 切换前对 6 个 SQLite 文件在线 backup，完整性检查通过；备份仅留服务器 |
| 其他服务 | Role Atlas、job-worker、launch-proxy、Caddy 的 container ID、环境与挂载保持 |
| ECS 发起 HTTPS | 根入口跳转至既有登录页后 HTML 200；匿名架构接口返回 401 |

本机独立 curl 遇到 TLS 连接重置（exit 35），没有取得 HTTP 响应，因此不声称本机公网验证通过。HTML 200 只说明入口与登录路由可达；没有在生产库写入测试学习事件，没有运行真实登录用户的教学闭环或在线模型评测。桌面安装包未发布。

上一轮双端完整回归和消融结果见[升级验收记录](2026-09-08-education-memory-v2.md)及[实验报告](../competition/EDUCATION_MEMORY_V2_REPORT.md)。本次没有重跑整个离线矩阵，不将部署探针当作学习收益证据。结构化发布证据见[发布 JSON](2026-09-09-education-memory-v2-release.json)。

## 上传审批与恢复

第一次源码包上传被自动审批按私有源码外发拒绝。随后只读核验 GitHub API：仓库公开、固定提交已公开；载荷是该提交的精确 git archive。Workbench 当前账号实例列表确认目标与既有发布记录相同。补齐这些证据后，重试同一载荷、同一路径的上传获准完成，没有改走其他通道规避拒绝。

正式切换没有触发回滚。旧镜像、逐服务 rollback JSON、切换前状态与数据库备份保存在发布目录。需要回滚时须先核对当前 Compose 链和并发变更，再使用对应旧镜像；不可盲目覆盖后续发布。

**Contract impact：** 本次部署已有兼容版本，未新增契约、数据库迁移或历史回填。三类 Agent、五核及 EvidenceEvent → reducer → KernelMutation → KernelState → Fact/Module/Claim 权威链保持。原实验报告保留部署前时点，不改写实验制品。
