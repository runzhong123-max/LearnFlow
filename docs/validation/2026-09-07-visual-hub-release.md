# Visual Hub 独立页面发布

应用版本 `9cd50a1`，已推送 GitHub main 并部署至 https://learn.learnflow.club/visualize 。Web 侧栏直接跳转，保留 /visual-hub 别名；现有 AuthGate 仍保护页面，匿名 gallery 返回 401。桌面内嵌入口不变。

- Web 构建通过；Hub 和注册表测试 26 passed。
- 服务器镜像隔离读取全部 70 份维护作品通过。
- LearnFlow 前端、后端、memory worker 切换至 visual-9cd50a1，后端 healthy。Role Atlas 与 Caddy 未切换。
- 服务器经公网 HTTPS 读取 /visualize 成功；入口资源 index-w2EVIlJo.js 包含独立路由和返回学习空间入口。架构校验 valid/schema_valid/implementation_valid 均 true。
- 原 /data 卷及星辰凭据挂载保留；在线 SQLite 备份通过 integrity_check，备份权限 0600。
- 发布目录 /opt/ceg/releases/learnflow-hub-9cd50a1 保留 prior-configs.json 和 rollback.override.json，可按原配置链回退三个服务镜像；不自动回退数据库。

本机 curl 公网 TLS 连接被重置，公网验收改由服务器发起。未操作真实账号或调用付费模型；本轮未重复桌面构建与无关全仓测试。之前新增作品的交互验收见 VISUAL_HUB_VALIDATION.md。

Contract impact：Web registry 2026-09-07.9 更新工作台页面绑定；没有新事件、五核变更或数据迁移。
