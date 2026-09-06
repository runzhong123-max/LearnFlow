# LearnFlow 桌面子应用

本目录已迁入 LearnFlow 单仓。先阅读根目录 `../../AGENTS.md`、`../../docs/MONOREPO.md` 和根 `docs/GITHUB_COLLABORATION.md`，再阅读相关桌面领域文档。

- Git、提交、分支和发布以根仓为准；不创建嵌套 .git，不向历史 edagent 远端推送。
- backend/frontend/desktop 保留独立安装依赖与运行目录；Tauri、桌宠和本地实验能力属于本宿主。
- 五核、记忆、纠错和基础注册声明从 `../../packages/learning-core` 导入；不要在本目录复制实现。app.services 路径保持兼容。
- 本地账号、模型配置、视觉凭据、桌宠权限、文件系统与实验运行不替换为 Web 策略。云身份与项目同步仍待实现。
- `architecture_registry.py` 只组合本宿主可执行的能力、工具和事件，共同事件必须通过根跨端检查。
- 本目录 docs 保留迁移时桌面规格与历史验收；涉及当前目录、仓库关系和共享源码，以根单仓文档为准。
- 修改共享代码同时跑两端测试；桌面改动跑本目录后端 pytest、前端 npm test/build；打包执行 desktop 的 build:sidecar/build。
- 原外部仓库保留为迁移前恢复点，不自动双向同步，不迁移数据库、密钥或研究材料。
