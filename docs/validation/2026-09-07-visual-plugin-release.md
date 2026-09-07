# 图解与动画插件线上发布 · 2026-09-07

用户在本地重构验收后明确要求推送并部署。本次应用发布版本为 `cd14e348df378363bcd11e9a36289bdbd4d7ce3f`，包含插件重构 `f4f3460` 及后端容器共享源码打包修复 `7079f40`、`cd14e34`。GitHub `main` 已推送；其中 Role Atlas 的已有提交随分支推送，本次没有切换 Role Atlas 或 Caddy 服务。

## 部署范围与证据

更新既有 cohost 的 `learnflow-backend`、`learnflow-memory-worker`、`learnflow-frontend`。使用独立发布目录 `/opt/ceg/releases/learnflow-visual-plugin-cd14e34`，源归档来自 Git commit；未上传本地数据库或模型凭据。

- Web 后端、前端 Docker 镜像构建通过。
- 部署审查发现后端镜像漏带 registry 所需的共享 `packages/learning-client` 源码，已补齐 Web 与 Desktop Dockerfile；不改变业务 schema 或证据语义。
- 新后端在无网络、无线上卷的临时容器运行作品工作区与架构测试，23 passed。首次测试有 2 项因镜像不含仓库文档/Role Atlas 对照资产失败；只读挂载源码中对应测试资料后原断言全部通过，没有删除或跳过测试。
- 新前端在无网络临时容器加载 `educational_visuals@1.0.0`，确认 create、search、open、iterate、resume、cancel 六个工具。
- 切换前对现有 LearnFlow SQLite 做在线备份，`PRAGMA integrity_check` 返回 `ok`。备份仅存服务器发布目录，权限 0600。
- 服务切换完成，后端 healthy；三个服务均 running，检查时重启计数为 0。
- 容器内 `/health`、`/ready` 返回 200；注册表的 `educational_visual_plugin` 和 `visual_artifact_workspace` 均 available。
- 公网 `https://learn.learnflow.club/` 返回 200，加载 `/assets/index-S_KHKcQ-.js`，与新前端镜像一致。
- 公网 `/api/platform` 返回 shared core `0.2.1`；`/api/architecture/validate` 的 valid、schema_valid、implementation_valid 均为 true。
- 匿名 POST `/api/visuals/workspace` 返回 401。只读检查数据库表名，确认六张 `visual_workspace_*` 表已建立；没有用真实用户数据写入进行验收。

## 回退与保留边界

发布目录保留 `before.json`、`prior-configs.json`、`rollback.override.json` 和 `pre-switch-learnflow.sqlite3`。回退使用原 Compose 配置链及记录的旧镜像 ID，仅切换这三个服务；不自动回退数据库。新增作品表可保留，旧应用不会因此删除或改写既有学习数据。

本次没有重新调用线上模型、重做真实用户旧对话或安装桌面应用。三例真实模型黄金案例及交互验收见 [插件验收记录](../design/visualize/PLUGIN-WORKFLOW-VALIDATION.md)，它们使用隔离账号和数据库完成。

Contract impact：发布了已经登记的插件产物授权、私有作品表、manage_visual_workspace capability 与零 target 审计事件。三类 Agent 与五核证据链不变；本次额外修复只涉及镜像打包。
