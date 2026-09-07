# LearnFlow 单仓目录与跨端开发

2026-09-06：网页与桌面源码已整合为单仓。共享 API、在线学习入口与首发部署见 [平台整合](implementation/LEARNING_PLATFORM_INTEGRATION.md) 和 [上线计划](LAUNCH_PLAN.md)。

桌面 0.2.0 已进一步改为主窗口默认云账号，通过受保护的本机转发层访问同一 LearnFlow API；本机文件和实验按云账号及项目隔离。旧本地身份保留为显式兼容模式，详情见[桌面连接契约](../apps/desktop/docs/implementation/DESKTOP_CLOUD_CONNECTION.md)。此变更不自动迁移旧数据库或同步文件。

## 正式目录

```text
LearnFlow/                         唯一 Git 根目录 / Codex 产品开发项目
  backend/                         Web / 云端 FastAPI 宿主
  frontend/                        Web 前端与 Node Tutor
  apps/desktop/                    桌面应用（无嵌套 Git）
    backend/                       云端连接、本机文件/实验、旧本地兼容 API
    frontend/                      桌面 UI
    desktop/                       Tauri shell 与打包
    docs/                          桌面规格与历史验收
  apps/role-atlas/                  Role Atlas 与 Graph Hub
  packages/learning-core/           共用 Python 实现与基础注册声明
  packages/learning-client/         共用纯 TS 逻辑
  desktop/                         旧 npm 命令的转发入口
  labs/golden-role/                 原仓黄金岗位实验代码
  docs/                            跨端权威、迁移与来源
```

没有为了目录对称而移动已有 Web 路径：部署与 Role Atlas 静态源图依赖保留。GoldenRole 独立研究工作区及其真实资料不迁入本次产品代码整合；其固定快照不会因为单仓而自动更新。

## 第一批共享边界

- Python：learning_runtime、memory_graph、five_kernel_context、teaching_guidance、agent_observations、remediation。抽取前六份源文件逐字一致，提取不改变评分/记忆/事件规则。
- registry_core：三类主 Agent、五核、共同 contract 类型、Chat Mode、插件扩展点与基础 schema；宿主 registry 保留各自工具、事件、实现绑定与能力版本。
- TypeScript：password-policy、latency-budgets、teaching-guidance-context，两个消费者通过相对 re-export 使用唯一源码。
- 21 个共同业务 API 与平台发现 API 共用源码；runtime-surface 统一判断本地/在线页面。
- 两个宿主的共同事件定义必须完全一致；端侧新增事件可以不同，不把目录合并误报为新增能力已经在两端执行。

Contract impact：根 registry 2026-09-06.7、桌面 registry 2026-09-06.7-desktop，新增只读 shared_core_version=0.2.0。旧 Python 导入路径、模块身份和 Event schema 保留，无数据库迁移。共享包依赖宿主 app 的模型与服务，是同源复用，不是独立微服务；同一进程不同时加载两个 app。

## 安装与启动

Python 依赖沿两端各自 requirements 安装；源码模式自动定位共享包，不需要手工复制。推荐使用项目支持的 Python 3.12，两个后端分别创建自己的 venv：

```bash
python3.12 -m venv backend/venv
backend/venv/bin/python -m pip install -r backend/requirements.txt
python3.12 -m venv apps/desktop/backend/venv
apps/desktop/backend/venv/bin/python -m pip install -r apps/desktop/backend/requirements.txt -r apps/desktop/desktop/requirements-build.txt
npm --prefix frontend ci
npm --prefix apps/desktop/frontend ci
npm --prefix apps/desktop/desktop ci
npm --prefix apps/role-atlas ci
```

已有可用环境不重复创建或覆盖。Node 推荐 22.18+ 或兼容版本；Rust/Tauri 依赖沿桌面说明。各应用保留独立 package-lock 与依赖树，lerna.json 仅声明工作区边界供 Vite 发现，不要求使用 Lerna，也不混装 Atlas 与学习端的 React 依赖。

网页：`bash start.sh`。桌面：根目录 `npm run build:desktop-sidecar` 后 `npm run dev:desktop`；正式构建 `npm run build:desktop`。根 `desktop/` 的旧 npm 命令也转发到同一桌面应用。安装脚本位于 `apps/desktop/desktop/scripts/install_macos_app.sh`，安装属于单独动作，本次未替换用户应用。

桌面开发默认前端改用 4175、后端 8011，与根网页隔离；已安装 Tauri sidecar 继续使用随机 loopback 端口。不要同时运行旧仓与新仓的桌面开发实例。

## 检查与发布

```bash
python3 scripts/check_shared_contracts.py
bash scripts/verify_repository_layout.sh
(cd backend && venv/bin/python -m pytest -q)
(cd apps/desktop/backend && venv/bin/python -m pytest -q)
npm --prefix frontend test
npm --prefix apps/desktop/frontend test
npm run build:web
npm run build:desktop-ui
```

两个 Python 环境不同时可向跨端检查传入 --python-web 和 --python-desktop。完整测试分别在两个进程中运行，不能在一个 pytest 进程同时载入两个 app。共享代码 CI 验证两端，桌面打包 CI 从 apps/desktop 构建并收集共用包。迁入的 Release 工作流只允许手动选择已有 tag，不因根仓推送 tag 自动发布。容器构建以单仓根为 context，云端镜像包含共享包；桌面开发 Dockerfile 如需使用也必须以根为 context，对应 Dockerfile.dockerignore 已保留桌面源码并过滤本地数据。

单仓同一 checkout 只允许一个写入任务；同步更新由一个任务明确两端验收，成组提交。需要并行时使用独立 worktree 和明确集成责任。账号、云同步、模型凭据、文件权限仍是不同实现，不能覆盖为另一端的策略。

## Codex 项目入口

产品开发统一选择仓库根 `/Users/a1-6/LearnFlow`。网页、桌面、Atlas 都在这个项目内按交付新建任务；不用把 apps/desktop 再当作独立仓。GoldenRole 研究继续用原资料项目。旧 `LearnFlow app` 项目入口及旧任务不迁移历史，后续不再向旧代码仓分派新实现任务。

## 来源与恢复

Web 基线 3738ea2d8ba21f0997c6d612f3a595775f7586ff；桌面基线 cd88a355e72dbf10073ae4f2c3242d40b5af47d3。只引入桌面 Git 跟踪源码，不复制 .git、venv、node_modules、密钥、数据库或本地运行记录。逐文件原始 hash 在 monorepo-desktop-source.json。历史 `.github` 工作流调整到根，不作为嵌套仓流水线。

原 `/Users/a1-6/LearnFlow app/edagent` 完整保留为迁移前恢复点。未自动合并它的全部 Git 历史到根提交图，来源提交与原仓历史仍可追溯；没有声明第三方源码为新的开放许可。

回退使用本地迁移提交的反向提交；恢复源码不会删除或降级用户数据库。不要通过 reset --hard 或删除原仓回退。此次仅本地重构，不推送、不部署、不迁移真实数据。

## 视觉共享运行时

VisualSpec计算与API统一位于learning-core的visuals及api/visuals.py；表现、作者上下文与交互组件统一位于learning-client/src/visuals。两端src/visualize和server/visualize-*只作重导出，认证transport保留端侧边界。详见[设计与验收](design/visualize/README.md)。

### 图解与动画插件（2026-09-07）

`packages/learning-client/src/visuals/workflow.ts` 与 `plugin-package.ts` 是图解插件产品流程的共享源；两端 `plugins/educational_visuals` 为装配入口。`learnflow_core.visuals.workspace` 管理私有作品和任务，`svg_story` 与 `engine` 分别是结构分镜和 VisualSpec 计算构建器。宿主仅装配认证、模型、能力授权与已有纸张入口。详见 [插件工作流](design/visualize/PLUGIN-WORKFLOW.md)。
