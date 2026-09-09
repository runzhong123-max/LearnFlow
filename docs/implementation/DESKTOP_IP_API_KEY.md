# 桌面公网 IP 与个人 API Key

2026-09-09，合同 `learnflow.desktop-api-key.v1`，registry Web `2026-09-09.2` / Desktop `2026-09-09.2-desktop`。

## 用户体验

桌面云模式使用固定的 `https://8.148.28.98`。输入个人 API Key 后，服务器验证并返回原 LearnFlow 账号；项目、Tutor、对话、纸张及学习记录继续属于该账号。页面不允许临时更换服务地址。旧本地工作区保留显式入口，仍使用原本地账号。

API Key 只在本次桌面应用进程内使用；页面提交后清空输入框，只保存随机本机会话句柄。没有将 Key 放入 URL、localStorage、sessionStorage、settings.env、模型配置或学习数据库。应用重启后重新输入。退出只断开本机连接，不撤销服务器 Key；撤销需账号管理接口或服务端管理命令。网络不可用也可以退出。

本轮没有新增钥匙串持久保存。现有网页账号 Cookie 登录和注册保持兼容，新桌面云模式不再转发账号密码。

## 传输与入口

裸 IP 仍然使用 HTTPS。桌面 sidecar 用可信 CA 校验证书链、有效期及 IP SAN，不允许 HTTP、不关闭证书验证，不使用环境代理，不跟随重定向。编译时 `LEARNFLOW_API_ORIGIN` 可覆盖 API 来源，默认上述 IP；原 `LEARNFLOW_PLATFORM_URL` 只负责另开的网页窗口，不再控制 API 来源。

IP 站点的 `/api/*` 在反向代理层先调用 `/api/auth/api-key/verify`，无 Key、无效 Key、或只有 Cookie 均拒绝。Tutor 路由继续送往 Node，其余 API 直接送往 FastAPI，以保留 SSE/流式响应。IP 根路径不提供网页登录。HTTP 不接收 API 凭据，只开放 ACME 验证所需路径；没有明文认证降级。

现有 Caddy 2.9.1 不必为此强行升级。部署采用 Certbot 的 IP 短期证书、webroot HTTP-01 及定时续期；先启用 challenge，再申请证书，最后启用 IP TLS。详细步骤见 `deploy/ip-api/` 的部署说明。证书、私钥、运行密钥、数据库和服务器配置秘密不进入 Git。

检查时服务器域名证书尚在有效期内，ECS 内的域名 SNI 握手通过；本机访问域名 TLS 重置，IP TLS 因未配置 IP 站点而失败。因此不能将现象直接归因为证书过期，也不能把 HTTP 302 当成 API 可用。

## 身份与撤销

云端独立 `AuthApiKey` 存储随机 `lfak_` Key 的 SHA-256 摘要，原文只在签发时返回。Key 固定账号与签发时的 `auth_epoch`，具有名称、提示、创建/使用/到期/撤销时间，默认 30 天、最长 90 天。每次请求重新验证摘要、期限、撤销状态、账号启用状态及 epoch，然后复用现有 `CurrentLearner` 和资源 ownership 校验；修改密码导致 epoch 变化后，旧 Key 失效。

显式 Authorization 失败时不退回 Cookie。没有全局共享 Key，也不接受客户端声称的 learner_id 作为身份。API Key 不可创建新 Key、修改密码、进入管理员接口或管理模型供应商凭据。即使真实账号为管理员，API Key 的对外账号角色和岗位网关委托角色也投影为 user，防止其他产品依据管理员角色放大权限；数据库中的真实角色不变。Node 获取当前账号模型凭据仍须同时持有既有内部 runtime bridge token；桌面无权调用内部 resolver。

- `POST /api/auth/api-keys`：Cookie 登录、CSRF、重新验证密码后签发；输入名称、密码、有效天数，响应只显示一次 Key。
- `GET /api/auth/api-keys`：仅当前 Cookie 账号的 Key 元数据。
- `DELETE /api/auth/api-keys/{id}`：仅当前 Cookie 账号撤销，重复撤销幂等，其他账号的 ID 返回 404。
- `GET /api/auth/api-key/verify`：仅有效 API Key 返回 204，用于 IP 网关，不输出凭据。
- 桌面本机 `POST /cloud/api/auth/api-key/connect`：接受 `{api_key}`，调用云端 `/api/auth/me` 验证，向页面返回原账号和随机本机句柄，不回传 Key。

网页域名不可用期间，维护者可以使用 `backend/scripts/manage_api_keys.py` 对明确指定的账号签发或撤销。签发原文只写入指定的新文件，文件权限 0600 且禁止覆盖；输出不打印原文。该命令需要服务器维护权限，不是公共网络接口。

## 对话与本机能力

客户端所有云请求均通过同一受限 httpx client 附加 Bearer Key，涵盖主 API、项目 ownership 验证、交接导入、设备报告和桌宠查询。请求拦截器拒绝其他 authority 和非 API 路径，并去掉 Cookie、CSRF 和本机 desktop token。

Node Tutor 的上下文读取、工具写入、插件 artifact host 与模型凭据桥接传递同一服务端身份头。API Key 请求不请求 Cookie CSRF；浏览器 Cookie 的 CSRF 规则继续生效。Key 不进入模型 prompt、ToolRun 或学习事件。

本机设备权限继续独立验证随机 desktop token、本机会话和云端项目归属。桌宠只持有短时受限句柄。连接切换/撤销清理旧句柄；退出还会取消在途登录，避免旧响应恢复身份。其他提交不自动重试。

设备绑定与缓存仍按 origin + learner + project 隔离。IP 和旧域名属于不同来源，已有目录绑定不会被自动移植；需要用户在新连接下明确重新关联，原本地文件和历史不删除。

## Contract impact 与发布

原 Cookie 会话不能承担独立可撤销、按设备分发的凭据，故新增账户认证表与 API，而不复用 UserAccount 的模型供应商 `api_key_*` 字段。新增表由既有数据库初始化机制创建，不修改旧学习对象或迁移账号数据；旧程序可忽略该表，回退不得删除它。

这是认证适配数据契约，没有新增 Agent 工具或 Action Board 学习能力，不向 EvidenceEvent/reducer/KernelState 写入密钥生命周期。三类主 Agent、五核、评分、掌握及学习事件 schema 均不变。

源代码、测试、候选构建与实际发布应分别记录。必须先发布服务端鉴权和 IP TLS 并验证证书/无 Key 拒绝，再切换已安装桌面；只安装新桌面无法修复尚未开放的服务器入口。发布与安装的实际执行状态见该次验收报告，本文不代表线上已更新。

官方参考：[Let's Encrypt IP 证书及 160 小时有效期](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html)、[Certbot IP 证书申请](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)。
