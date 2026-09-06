# LearnFlow 单一前端收口验证记录

日期：2026-08-26

## 目标与结果

本轮把原 `vnext/` 提升为唯一产品前端，并固定到仓库标准位置 `frontend/`。旧版 `frontend/` 的源码已经从当前版本移除；文档、报告图片与架构资料继续保留。原 `vnext` 内部稳定 ID、接口名和浏览器存储键只作为兼容标识保留，不代表仓库仍有第二套产品实现。

当前主要目录：

```text
LearnFlow/
├── backend/                 # 唯一后端与 Agent/五核运行时
├── frontend/                # 唯一 LearnFlow 产品前端（原 vNext）
├── desktop/                 # Tauri 桌面壳与 sidecar
├── docs/                    # 架构、产品与验证文档
│   ├── assets/reports/      # 架构报告图片和 PDF
│   ├── product/             # 原 vNext 产品逻辑文档
│   └── validation/          # 可复查的验收留痕
└── start.sh                 # Web/demo 统一启动入口
```

旧版前端的 ignored 构建内容没有直接永久删除，迁移时临时保存在：

```text
/private/tmp/learnflow-legacy-frontend.hZjl4L/frontend
```

受 Git 管理的旧源码仍可从历史提交恢复。本轮没有迁移或删除 `.env.local`、用户数据库、五核数据与学习对象。

## 修复内容

- 统一 Web 端口为 `4174`，同步 Vite、后端 CORS、Tauri、启动脚本与文档。
- 修复 `start.sh status` 误启动服务的问题；加入进程存活和 HTTP 就绪检查、分离正式与 demo 日志，并在失败时清理残留进程。
- 桌面端不再假设固定后端地址：前端从 Tauri 获取 sidecar 的随机端口和访问令牌，统一通过 runtime client 注入认证头。
- 桌面端 Tutor 回退到正式 Agent session API，避免调用仅由 Vite 开发代理提供的 `/api/tutor`。
- 修复桌面 Tutor 已由后端持久化后又被全局对话接口重复写入的问题。
- 新增只读 `GET /api/auth/status`，消除应用初始化时把预期的未登录状态表现为 401 控制台错误；身份初始化改为单例，避免多个标签页并发重复登录。
- 浏览器保存的正式 session 绑定若已经失效，普通对话会自动创建替代 session 并重新同步，避免旧对话持续 404 或跨浏览器缺失。
- seeded demo 统一进入 `/review`，并自动建立隔离 demo 身份；核心演示继续保持离线可用。
- 更新 Vite 与 React 插件依赖，收紧开发代理和桌面 CSP；保留本地 API Key 文件且继续忽略提交。
- 清理仓库根部的临时 `output/` 层，将应长期留存的报告资产归档到 `docs/assets/reports/`。

## 架构与兼容性

Contract impact：

- 架构注册表版本提升到 `2026-08-26.25`，新增 `frontend_authority`，明确 `frontend/` 是唯一产品前端。
- 竞赛演示 surface 从旧入口统一为 `/review`。
- `GET /api/auth/status` 是向后兼容的新增接口，不改变已有登录、注册或开发登录协议。
- 没有改变 `EvidenceEvent -> five_kernel_reducer -> KernelMutation -> KernelState` 写入链，也没有改变五核、学习任务、项目关卡或 Memory Graph 的 schema 与证据语义。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| 后端全量测试 | `189 passed` |
| 前端单元测试 | `76 passed` |
| 前端生产构建 | 通过，Vite 8.2.2，320 modules transformed |
| 架构注册与用户隔离定向测试 | `17 passed` |
| Tauri `cargo check` | 通过 |
| `git diff --check` | 通过 |
| `bash -n start.sh` | 通过 |
| `git ls-files 'vnext/**'` | 0 个文件 |
| 非文档运行代码中的旧 `5173` 引用 | 0 |
| 非文档运行代码中的旧 `vnext/` 路径引用 | 0 |
| npm production dependency audit | 0 vulnerabilities |

后端测试仍会输出既有 Pydantic/SQLAlchemy 弃用警告，但不存在测试失败；这些警告不属于本轮前端收口引入的回归。

## 浏览器与 demo 验证

使用真实 WebKit 浏览器完成以下验证：

- `/learning-files`、`/tasks`、`/learning-path`、`/learner-profile`、`/projects`、`/review` 均可渲染。
- 项目列表可进入“从零实现迷你 GPT · 项目 Tutor”，项目侧面板中的关卡、来源、讲义与练习可打开。
- 没有关卡图时页面保持可用；已有项目只允许调整未学习关卡的约束仍然可见。
- 清空浏览器状态后初始化无 console error/warning，`/api/auth/status` 与开发登录各只请求一次。
- seeded demo 使用隔离数据库、离线模式和 `/review` 入口，能展示到期复习、纠错任务、熟练度证据和 Knowledge 记忆。
- `/api/demo/status` 返回 `enabled: true, offline: true`；`/api/architecture/validate` 返回 `valid: true` 且无错误。
