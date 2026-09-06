# 服务器发布准备

2026-09-06 使用 Workbench v1.0.1 核实既有服务器：4 vCPU、约 16 GB 内存、4 GB swap、根分区 79 GB。现有 cohost 服务运行于旧独立仓目录，不是空服务器。

已执行：

- 已提交源码 0f5f338 上传到独立发布目录；未复制本地数据库或模型凭据。
- Web 后端、Web 前端镜像构建通过。首次官方 PyPI 下载失败，改用部署配置的阿里云镜像后通过。
- Atlas 首次构建缺失跨仓共享路径契约；修复 Docker 构建上下文、工作目录和挂载位置后构建通过。
- 新后端在无网络、无线上卷的临时容器初始化数据库，架构 2026-09-06.7 校验无错误。首次测试命令引用错误模块路径，修正后通过。
- Atlas 类型检查、145 项测试通过；测试工具的 IPC 需在沙箱外运行。
- Apple Silicon 桌面包的独立临时数据库启动、health、ready、platform 和注册表校验通过，codesign deep/strict 校验通过。该包为 ad-hoc 签名，未完成 Apple Developer ID 公证；不宣称 Intel 兼容。

发布配置复用现有身份加密密钥和持久数据卷，仅在新配置中补齐岗位网关签名密钥；未修改当前运行配置。版本目录中的 previous-deployment.json 记录旧镜像 ID，release.override.json 固定新镜像及原图谱目录。

用户确认后已执行线上切换：六个 cohost 服务正常运行，新后端 healthy，独立 Memory Worker 无重启且持有独占锁。LearnFlow、Role Atlas、Graph Hub 页面返回 200；`/api/platform` 返回 shared core 0.2.0、learning_platform 和 external worker，`/api/architecture/validate` 返回 valid=true。匿名 ecosystem 请求返回 401；从 LearnFlow 后端发往 Atlas 的签名 catalog.search 只读请求通过。最初诊断使用非数字主体被协议正确拒绝，修正诊断主体后通过。

切换前在服务器 `/opt/ceg/backups/pre-monorepo-0f5f338` 对 16 个 SQLite 文件进行在线备份及完整性检查，另保存旧配置和图谱。旧镜像 ID 保存在新发布目录的 previous-deployment.json；回退应用镜像不自动回退数据库。

尚未执行：真实账号跨 Web/macOS 的业务闭环验收、本地项目与云项目自动同步。桌面在线空间消费云端 Web/API，本地主窗口仍独立运行；它不是完整云本地同步实现。服务间诊断通过不等于真实账号、模型生成与学习闭环全部通过。

Contract impact：本次修复仅改变镜像构建与数据卷挂载目标，保留卷名、现有数据及源契约内容；无 API、EvidenceEvent、五核或数据库语义变更。
