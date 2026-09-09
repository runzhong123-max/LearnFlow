# 公网 IP API Key 正式发布（2026-09-09）

用户明确确认“上线吧”，中断后要求“继续”。应用源码 `3de98e8e99f6ae92e803c62623d4210baf3e3ce8` 已发布到既有 ECS `i-n4a084s5nh57syfytgfe`（cn-wuhan-lr），桌面 0.3.1 已安装并启动。

## 实际发布

- 入口 `https://8.148.28.98`：可信 IP SAN 证书、TLS 1.3、API Key-only gateway。HTTP API 为 426；HTTPS 非 API 路径为 404。
- 发布目录 `/opt/ceg/releases/ip-api-3de98e8`。源包为固定提交的 git archive，SHA256 `6fefe07c4d94f05ff44b423f099a0bf7921a205ee2530cec6bbc559fea0974a4`。
- 构建前发现另一任务刚发布 `9ef3d4c`；该提交已包含在本次版本中。刷新基线，保留其真实 Compose chain、env-file、环境、挂载和启动配置。只更新后端、前端、Caddy；岗位服务及 memory worker 不变。
- 后端镜像 `sha256:2999844102ba2b4f804ea6650f725e553c36477a6dc5a621459a40adccb9989b`，前端镜像 `sha256:a6137be4d1b53dd477bafb1f29d7f0dc6b2dde06c611ab0d2f83abadf1c5716b`。复用校验过的原依赖进行无网络构建。
- 使用 `/opt/ceg/role-atlas-deploy.lock`；切换前完成 11 份 SQLite 在线备份及 quick_check，备份只留服务器。回退脚本对尝试过的服务逐项恢复，超时也计入回退范围。
- Caddy 仍为 2.9.1，只追加四项只读绑定。原域名配置字节保留，首次重建后原域名 TLS/匿名 API 仍为 401。

## 证书与密钥

使用独立无邮箱 ACME 账户，没有读取旧账户邮箱。无邮箱是显式 `--without-email` 选项，不改变 TLS 校验。Staging 试签、生产签发与启用全部成功；本机验证 IP SAN 为 `8.148.28.98`，本次证书到期时间为 2026-09-15 23:29:41 UTC。

Docker Hub 直连超时后，经 DaoCloud 传输并按官方 amd64 manifest digest 校验 Certbot 5.4.0：`sha256:1dc5b4a99cce916f154c706569baf062600d7dea13e0711e7d7e1461d6230e39`。当前 Docker 内容存储的 image ID 为 manifest digest；不能拿旧存储的 config ID 直接断言失败。版本探针返回 `certbot 5.4.0`，运行始终 `--pull=never`。

续期 dry-run 的 Workbench 调用在 240 秒超时，但实际 Certbot 于北京时间 16:38:31 完成，受限日志明确记录全部模拟续期成功、no renewal failures。没有把传输超时当成续期失败，也没有加载 staging 证书。已安装并启用 `learnflow-ip-certificate.timer`，每日四次检查；首次生产检查于 16:42:18 返回 Result=success、ExecMainStatus=0。

个人 Key 有效期 30 天，明文只交付到本机 0700 目录中的 0600 文件，不进入 Git、聊天、模型上下文或学习数据。真实认证验收后已删除服务器两个临时交付副本，认证表仅保留摘要。

## 验证结果

- 新 Linux 镜像隔离验收：8 组通过；临时 SQLite、network none、无模型调用。覆盖签发、CSRF、摘要存储、拒绝 Cookie 回退、撤销、owner、管理员 Key 降权及委托签名。
- 桌面网络：可信 HTTPS/IP SAN/TLS 1.3 通过；无 Key、错误 Key、仅 Cookie 均 401；有效 Key `/api/auth/me` 200、verifier 204、项目接口 200。
- Tutor status 200 且 configured=true；真实认证 NDJSON 通道通过。流式探针使用 null 输入触发验证错误，不调用模型、不创建教学记录；不将此称为完整教学闭环验收。
- 无邮箱部署脚本 16 项 unittest 通过；此前双端回归与构建见 [实现验收](2026-09-09-desktop-ip-api-key.md)。
- 桌面安装包为 arm64 0.3.1，ad-hoc 签名验证通过，未公证。安装在用户 Applications，旧 0.3.0 完整保留为时间戳备份，不修改 Application Support。实际界面显示固定 IP 与个人 Key 连接页；用户首次输入 Key 后连接，未宣称已在桌面完成真实账号登录。

## 操作异常与边界

完整容器状态快照曾被自动审批拒绝，因为可能持久化环境密钥；改用非敏感元数据和校验摘要后获准，没有保存该秘密快照。管理传输两次出现超时/空输出，重建本任务 Workbench 会话并核对真实状态后继续。Docker 对裸 image ID 的 FROM 解析为远程仓库名，改为经 ID 验证的本地标签后构建成功；Compose 使用容器标签中的真实 env-file 后计划校验通过。安装时修正 macOS pgrep 正则，采用失败即停止的流程后完成。

Contract impact：发布已有 `learnflow.desktop-api-key.v1` 和新增认证表；本轮仅补充无邮箱证书操作选项。三类 Agent、五核、学习事件、评分和历史数据语义不变。不包含真实模型教学测试或已登录桌面项目闭环。

源码收尾时普通合并了远程 `8a41adf` 的独立桌面模型 KEK 修复，Rust release lib 3 项测试通过。该源码同步不改变上述固定发布制品；不宣称未重新打包的远程改动已进入本次已安装桌面。
