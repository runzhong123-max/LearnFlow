# 讯飞候选生成配置修复与发布

## 修复与配置

应用提交 `825900d` 已推送到 `origin/main`。两端适配器取消未参与 HTTP 鉴权的 `XFYUN_APP_ID` 必填检查，继续要求 API Key、API Secret 和 Flow ID；旧 APP_ID 配置仍兼容。新增 `deploy/xingchen.compose.yaml` 作为可选服务端私密文件挂载模板，文档说明产物 origin 和云账号部署位置。

用户授权将提供的凭据写入现有阿里云实例，文件权限 0600，只在后端运行时只读挂载。密钥未提交 Git，Docker 构建上下文只允许适配器和测试文件，新镜像不含凭据。

## 验证

- 本地真实工作流请求成功；HTTPS 产物证书验证、交接 bundle 和确定性候选校验通过，生成 4 步，零五核写入；测试任务未写入日常数据库。
- 最终线上容器 `visual-9cd50a1` 真实调用通过：37 秒完成工作流、HTTPS 交接读取与候选校验，4 步、零五核写入，进程退出码 0；不写日常数据库。
- 本地候选模块 28 项测试通过；部署镜像内同一模块 28 项测试通过。
- 独立工作区的 Web 全量回归：703 passed、1 skipped、1 failed；桌面：729 passed、1 failed。两端均失败于未修改的 `test_visual_library_curriculum.py::test_library_links_and_all_authored_frames_compile`，原因是图解检索元数据缺少 `not_for`。未删除断言或改动相邻图解模块。
- 集成后最终 main 再跑全量：Web 703 passed、1 skipped、2 failed；桌面 729 passed、2 failed。均为上述图解元数据用例，以及同期新增图解导致的 RAG 检索首项由 `ai.rag.evidence_flow` 变为 `lab2-rag`。本次讯飞模块仍通过；全量不声明通过。
- `git diff --check` 通过。
- 新后端 healthy，容器内凭据加载和架构校验通过；公网首页、`/api/platform`、`/api/architecture/validate` 均返回 200，架构 valid=true。
- 前端构建和 seeded demo 未执行：本次未修改 UI、共享学习实现或 demo。

## 部署与回退

发布目录 `/opt/ceg/releases/learnflow-xingchen-20260907`，运行镜像 `learnflow-backend:xingchen-825900d`。线上适配器基线 SHA-256 与本地修改前一致；发布镜像基于既有线上镜像，只替换本任务适配器及回归测试，不将同期其他功能带入线上。

本次切换仅更新 `learnflow-backend`，切换完成时其他服务容器 ID 均未改变。随后并行图解发布将后端更新为 `learnflow-backend:visual-9cd50a1`；已现场核验新镜像仍包含本次修复，且保留私密挂载、Flow ID 和产物 origin。首次线上 smoke 因该容器替换被中断（exit 137），在新容器重跑。没有迁移日常数据库或安装桌面应用。目录保留 `before.json`、原配置链、`rollback.override.json` 和 `rollback.sh`，记录本次切换前的后端镜像与配置。已有后续发布时不能直接执行该旧回滚脚本，否则会撤销后续发布；应按当前配置链选择性撤销本功能。不回滚数据库。

Contract impact：仅放宽未使用的配置字段，API、候选合同、三类 Agent、确定性策略与五核事件语义不变；无需 schema 或 registry 版本迁移。
