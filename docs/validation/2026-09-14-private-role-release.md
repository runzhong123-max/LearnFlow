# 私有岗位引用与对话研究工作台发布

应用提交 `295b355166d93f477235f738c53488ef0e97ca27` 已推送 `origin/main`，于 2026-09-14 部署至 ECS `i-n4a084s5nh57syfytgfe`。未发布岗位可固定当前可见快照为个人岗位包后引用或转换任务；迭代与节点深化工作台移至对话底部，原有研究选项保留。

## 部署证据

- 实时基线为完整发布 `12bb721`，只需重建 Role Atlas。其他服务镜像和运行配置保持。
- 新镜像：`sha256:4706acc67d41a286ae9b7d91b090b721d7a94bbfac0124636e94030116dfd7f8`，标签 `role-task-conversion:295b355`。
- 发布目录：`/opt/ceg/releases/role-personal-295b355`。`success.json` 记录应用提交、镜像、runtimePreserved 与 backupChecked；`apply-status.log` 返回 DEPLOY_OK。
- 按 Git 对象打包 11 个变更文件，基础镜像 322 个源码/依赖文件的 SHA-256 与基线一致，新镜像变更源码与目标提交一致。
- 切换前无运行中的岗位研究。暂停岗位 worker 后复查，停止 Role Atlas 写入后使用 SQLite backup API 备份，integrity_check 通过；切换后 quick_check 通过。未取消研究或修改作业状态。
- 备份：发布目录的 `atlas-backup.sqlite`，SHA-256 `d86c4f4be7b65f24953e698c78ae994ddcb50a79ad08a8a8fa8af09c530d2cdf`。
- 原 Compose 链与 env-file 完整继承，配置比较仅 image 不同，实际 environment、mounts、command、entrypoint、runtime 一致。岗位 worker 恢复，七个相关服务 running，Web 后端 healthy。

## 验证范围

同一应用提交的本地验收已通过：Role Atlas 661 项、类型检查、生产构建，LearnFlow 引用/转换回归 33 项。

服务器重新构建成功，镜像内准备私有包、快照归属、发布质量、请求身份等 25 项回归全部通过。首次尝试镜像内全套得到 653 passed / 4 failed：生产镜像缺少 frontend/src/ecosystem-entry、frontend/public/site-session.js、research 金标准文件，以及测试调用的 Python 环境。保留 tests.log；没有删除断言或更改业务代码，后续仅执行可在镜像内运行的部署相关回归，记录于 tests-v2.log。

公网 LearnFlow、Role Atlas、Graph Hub（graphs.learnflow.club）、任务转换入口均按预期跳转统一登录并返回 200。首次误探测单数 graph.learnflow.club 未成功，依据当前 Caddy GRAPH_HUB_HOST 修正为正式域名后通过。未执行真实登录账号的研究、付费模型调用或创建生产测试项目；匿名入口检查不代表完整业务端到端验收。

## 固定 Skill 与回退

本机已创建并校验 `~/.codex/skills/learnflow-push-deploy/SKILL.md`，调用 `$learnflow-push-deploy`；附 ECS 定位与验收参考，自动发现保持默认开启。流程覆盖当前分支推送、现场基线、按服务差异构建、保留完整配置、作业检查、数据库备份、定向切换、恢复 worker 与验证。它是 Codex 维护技能，不新增产品 Agent 能力。

回退配置位于发布目录 `rollback.json`，回退镜像标签 `role-task-rollback:295b355`。核实当前配置链、运行任务及回退目标后，沿该服务完整 Compose 链追加 rollback.json 定向重建 Role Atlas；不整栈重建，不自动覆盖数据库。本次没有触发回退，也未安装替换桌面应用。

Contract impact：本轮仅发布已提交实现并固定维护流程，不增加产品协议或数据库迁移。
