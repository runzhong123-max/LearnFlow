# 域名账密登录发布

实现提交：`754ad6a25fed871fb86cb4b636f18b18f9962db1`，已推送 main。

- 默认域名：`https://learn.learnflow.club`。桌面账密登录通过 sidecar 内存 Cookie + CSRF，个人 API Key 路径默认关闭，供应商模型凭据不受影响。
- 云端为既有 `d6dec846b6d7` 镜像上的认证增量（6 个文件），不是整个 main 的全量发布。逐文件验证生产基线 hash，再构建前后端镜像；只修改 image，保护其他服务、环境、命令与挂载。
- 发布目录：`/opt/ceg/releases/domain-password-20260913`，完成标记 `success.json`。11 个 SQLite 在线备份及 quick_check 通过，保存在该目录 backups 下。
- 后端镜像：`sha256:1f1af485499b9c33521684f3af19ad846a86fe6a44526cdbaf9eff4c25713824`。
- 前端镜像：`sha256:3c19b2bb74566da7c3ac9610fb6b0f32b3eb3af50e336cb5e86869ac14fc291c`。
- 公网受信任 HTTPS：`/login` 200、`/api/auth/status` 200、匿名 `/api/auth/me` 401、`/api/auth/api-keys` 404。生产内确认开关为 false，后端 /ready 200。
- 首次发布尝试因备份扫描路径不匹配停止于切换前；修正为生产 `/data` 后完成发布，无数据库回滚或迁移。
- 原镜像回退配置保留为 backend.rollback.json / frontend.rollback.json，沿服务既有 Compose 链定向恢复，不执行全栈重建。

验证：Web Key 回归 12 项通过（保留功能的用例显式启用开关，另验证默认关闭时旧 Key 与管理路径被拒绝）；桌面后端认证 13 项通过；桌面前端认证/云连接 16 项通过；两端前端构建、桌面 sidecar 与 macOS app 打包通过。全量后端回归与 seeded demo 未执行，本次没有改变学习契约。

已安装并启动 `/Users/a1-6/Applications/LearnFlow.app`；原应用保留为 `.backup-20260913-183022`。自动 UI 读取两次超时，未宣称已完成真人账号端到端登录或界面截图验收；没有索取或使用用户密码。

Contract impact：恢复既有认证适配并默认关闭保留的 Key 功能，不修改 Agent、五核与 EvidenceEvent 语义。
