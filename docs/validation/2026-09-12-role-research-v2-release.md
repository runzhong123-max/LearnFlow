# Role Atlas 研究重构线上发布

用户明确要求“推送并部署”。应用提交 `d5a62e0257b70bd5fa5cc91e4af08f57b7bef534` 已推送至 `origin/main`，并于 2026-09-12 发布至既有 ECS `i-n4a084s5nh57syfytgfe`（cn-wuhan-lr）。发布前运行版本为 `2109765`。

## 发布结果

- 发布目录：服务器 `/opt/ceg/releases/research-v2-d5a62e0/package`。固定源码包 SHA-256：`7edbd26d34fd6a371cb5a185ebc60ffa8f93388a1a3b133f03cfa257b4857c98`。
- 更新 Web 后端、Web 前端、Memory Worker 和 Role Atlas；岗位 Job Worker 在空闲时暂停并恢复。Caddy、交接代理、环境配置、命令、网络策略和数据挂载保持原配置，部署脚本逐项验证。
- 依赖锁文件未变。前端 package.json 仅变更 scripts；打包器分别校验其他字段相等、原镜像依赖文件哈希及新镜像运行源码哈希。三个镜像采用原镜像依赖、无网络构建成功。
- 持有 `/opt/ceg/role-atlas-deploy.lock`，两次检查无在途研究任务。暂停后台写入后完成 7 份 SQLite 备份与 integrity_check；切换后主数据库 quick_check 通过。备份留在服务器，未复制本地日常数据库或重新生成密钥。
- 新版本 Role Atlas 配置为 `deepseek / deepseek-v4-flash`，GLM 搜索已配置。身份接口和项目接口对无效会话返回 401，不再出现身份服务未配置。
- 后端注册表 `2026-09-12.1`、共享核心 `0.2.5`，在线架构校验 valid=true。五个相关服务均 running、RestartCount=0，后端 healthy。

| 镜像 | ID |
|---|---|
| Web 后端及 Memory Worker | `sha256:b5eaacdc52191c72b4f478ddd08f608969b63a54d87a634ea1f8590a09ebb19b` |
| Web 前端 | `sha256:157aed7e14bfeb6259d0e8a43958fad0298f51429f8dd24b9adef4a6cd9cc670` |
| Role Atlas | `sha256:f1e1c1a5f0d8df1ba47295343deafef37c6446aa9e7590d4131d07d7e65bd679` |

## 本次实际验证

- 完整本地仓库 Role Atlas：624 项测试通过，类型检查通过。
- 新 Web 镜像：岗位包插件 113 项、任务转换 7 项、模型响应/凭据 15 项通过。
- 新后端镜像：架构、岗位包交接和工作任务转换/设计 72 项通过；隔离数据库、无网络、无模型调用。存在既有弃用警告。
- 新镜像构建和逐文件源码校验通过；后端隔离架构探针通过。
- 服务器侧三个公开 HTTPS 入口跟随登录跳转后均返回 200；本机 `https://8.148.28.98/api/auth/me` 返回预期 401。
- `git diff --check` 和共享契约检查通过。发布前本地 33 个未推送提交已同步；用户既有 `docs/competition/reports/` 未跟踪文件保持原样。

## 失败与未覆盖项

- 首次在精简 Role Atlas 镜像运行全量测试：616 通过、4 失败。原因分别为未打包的跨端 ecosystem-entry、site-session.js、冻结研究资料，以及测试需要的 Python/双端接收器缺失；同镜像类型检查也因测试引用 ecosystem-entry 缺失而失败。没有删除断言或修改应用来绕过，改在完整仓库复验，624 项及类型检查全部通过。精简镜像自身不宣称全量测试通过。
- Workbench 管理连接中途异常；改用既有 SSH 核对独立构建进程并完成发布，没有把传输失败当成构建成功。
- 本机对三个域名 TLS 连接被重置，固定正确 IP 并禁用显式代理后仍然如此；服务器访问三个域名均正常。未修改 DNS、证书或网络安全配置，未宣称该客户端访问限制已解决。
- 未用真实账号在生产发起冷启动、迭代或付费模型调用；未创建生产测试项目或学习记录。未重新运行两个后端的全部回归；相同应用提交此前完整验收见 `apps/role-atlas/reports/research-v2/validation.md`。
- 未构建、安装或发布桌面安装包。发布后磁盘可用约 5.6 GB。

## 回退与契约影响

每个目标服务的旧镜像以 `research-rollback-<service>:d5a62e0` 保留；发布目录含各服务的 `*.rollback.json`、`review.json`、`backups.json` 和 `verification.json`。回退应在核对当前容器 Compose 文件链和任务空闲状态后，追加对应 rollback 文件逐服务 `up -d --no-deps --no-build --pull never`，保留原环境与挂载；不要自动恢复旧数据库。切换脚本包含失败时逐服务恢复旧镜像的处理，本次未触发回退。

Contract impact：部署既有 `role-research/v2`、任务定义 v1、岗位包 3.1.0，继续支持旧岗位包 2.0.0/3.0.0。三类 Agent、五核和 148 个共享事件保持原语义；本次发布操作未增加契约变更。
