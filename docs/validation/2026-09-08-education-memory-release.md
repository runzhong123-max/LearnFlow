# 2026-09-08 教育记忆升级发布记录

用户明确要求“部署”并再次要求“继续部署”。产品提交 `3c334e676e04d08fda396ea56a7fcb79c6fa0279` 已于北京时间 2026-09-08 19:30:13 开始切换，约 19.19 秒完成；19:31–19:32 完成后续源码与 HTTPS 检查。

## 发布范围与版本

- 站点：`https://learn.learnflow.club`；既有 ECS `i-n4a084s5nh57syfytgfe`，`cn-wuhan-lr`。
- 替换 `learnflow-backend` 与 `learnflow-memory-worker`；镜像均为 `sha256:4bb3c7514230b033d5307f9d6f1fc3b737702458d6d3e0465060859688b0c1a0`，OCI revision 为上述完整提交。
- 共享核心 `0.2.4`、Web registry `2026-09-08.8`；`concept-evidence.v2` 与 `learning-plan-guidance.v1` 实际导入验证通过。
- 发布目录：`/opt/ceg/releases/education-3c334e6-r2`，权限 0700。
- 固定提交 backend/core/docs 源包 SHA256：`44a754cff67aa9c3a3b22281eb962e4b91b850b172ab66d57d79793513dcfe9d`。
- 运行中 `planning_guidance.py` SHA256：`5599a8b2209eccc57b70c7a8b2ccace42e33706200519db81ca6412fbdaa6ae1`。

复用已有依赖镜像，在构建前核对 requirements hash 一致；无网络构建，没有重新安装依赖。前端未发生本轮产品改动，保留已经上线的镜像；Role Atlas、job-worker、proxy、Caddy 的 container ID、环境与挂载均保持。未发布桌面安装包。

## 实测验证

| 项目 | 结果 |
|---|---|
| 新镜像隔离测试 | 65 passed，2422 warnings，15.51 秒；network none、临时 SQLite、无生产数据卷 |
| 后端 | running / healthy；容器内 `/ready` HTTP 200，架构校验 valid=true |
| 记忆 worker | running；无 Docker healthcheck，不称为 healthy |
| 运行源码 | 两服务各 6 个关键 Python 文件 hash 与固定提交一致 |
| 重启计数 | 后续核验两服务均为 0 |
| 配置保护 | 分别保留实际 Compose 链、environment、mounts、command 与 entrypoint |
| 数据备份 | 切换前对 6 个 SQLite 文件在线 backup，各自 integrity_check=ok，仅留服务器本地 |
| HTTPS（ECS 发起） | 根入口经登录跳转返回 HTML 200，匿名 `/api/architecture/validate` 返回 401 |

HTML 200 只证明入口与登录路由可达；后端健康依据容器内 ready 与 registry 验证。本机 curl 两次遭遇 TLS 连接重置（exit 35），因此不声称完成了本机独立公网访问验收。未在生产库写测试学习事件，未调用在线模型或完成真实用户教学会话。

## 失败与恢复记录

- 初次上传被自动审批按私有源码外发拦截。只读核验确认仓库公开、固定提交已发布、目标实例属于当前已认证云账号；补充证据且用户再次要求继续后，同一路径上传获准执行。
- 第一版发布包未携带架构测试读取的文档，隔离测试 64 passed、1 failed，缺失 `WORK_TASK_CONVERSION_CONTEXT.md`；没有切换服务。保留 `/opt/ceg/releases/education-3c334e6`，以同一提交补齐 docs，在新目录 r2 重建后 65 项通过，未改断言或删测试。
- 正式切换未触发回滚。使用既有发布锁和每服务并发 guard；旧镜像及逐服务 rollback JSON 留在 r2 目录。未来回滚前须重新检查实际 Compose 链与并发改动，不盲目覆盖其他任务配置。

**Contract impact：** 本次部署运行已验证的教育证据与规划策略；三类 Agent、五核与 EvidenceEvent → reducer → KernelMutation → KernelState → Fact/Module/Claim 保持。没有新增数据库迁移、历史掌握回填或私有配置改写。实验及残余限制见 [教育记忆升级与同场景复验](../competition/EDUCATION_MEMORY_UPDATE_REPORT.md)；该实验报告保留部署前时点，不重写原始证据包。
