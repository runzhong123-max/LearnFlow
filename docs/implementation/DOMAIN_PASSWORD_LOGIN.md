# 域名与账密登录恢复（2026-09-13）

桌面默认连接 `https://learn.learnflow.club`，使用网页端同一账号和密码。TLS 校验保持开启，不回退裸 IP。云端 Cookie 和 CSRF 只留在 sidecar 内存，Webview 仅获得随机本机会话句柄；密码不落盘，退出可离线清除句柄，重启后重新登录。已有 origin/learner/project 文件绑定不自动迁移。

两端 `AUTH_API_KEYS_ENABLED` 默认 false。云端签发、列表、复制、撤销接口返回 404，已有个人 Key 不再认证；桌面 Key 连接入口返回 404。设置与账号台不再挂载签发组件。实现、加密记录与回归保留；只有运维显式重新启用后后端才会运行旧逻辑，UI 不自动恢复。模型供应商凭据设置与此开关无关。

此文取代 DESKTOP_IP_API_KEY.md 和桌面 DESKTOP_CLOUD_CONNECTION.md 的默认连接说明。生产发布须保留域名 TLS、Cookie 与 CSRF 配置，确认没有显式开启 AUTH_API_KEYS_ENABLED。安装包须重新构建才能切换现有桌面程序；仅更新源码不会改变已安装应用。

Contract impact：恢复既有 Cookie 认证适配，不改变三类 Agent、五核或 EvidenceEvent，不删除或迁移账号数据。
