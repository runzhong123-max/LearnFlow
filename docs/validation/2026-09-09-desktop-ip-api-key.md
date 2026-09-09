# 桌面公网 IP + API Key 验收（2026-09-09）

## 改动与边界

默认 API 为 `https://8.148.28.98`，个人 Key 绑定已有云账号，校验证书与 IP SAN。桌面进程内保存 Key，界面仅保留随机句柄，退出清理身份；旧本地工作区和网页 Cookie 登录兼容。服务端支持签发、过期、撤销、密码变更失效、owner 隔离；个人 Key 不获得管理员权限。Node Tutor、工具和流式代理传递同一身份，凭据不进入模型上下文。

Contract impact：新增 AuthApiKey 表、身份认证字段和 `learnflow.desktop-api-key.v1` 登记（两端 registry 2026-09-09.2）。不修改三类主 Agent、五核、评分或 EvidenceEvent 语义。API Key 原文仅签发时输出一次；运行配置、真实凭据、数据库、依赖与构建产物均不提交。

## 已执行

- 桌面后端全量：1,073 passed；最后连接竞态补丁后定向云连接/设备/导入测试 46 passed。
- 桌面前端全量：448 passed，构建通过；账号切换期间响应体读取和桌宠异步操作均有回归。
- 网页后端首次全量：1,048 passed、1 failed、1 existing skip；失败是测试遗漏新契约 owner 预期，补齐后 registry 27 passed，未删除断言。
- 网页前端全量：525 passed，生产构建通过。最初因沙箱不允许 127.0.0.1 监听而失败，允许本机测试服务后重跑通过。
- 桌面 registry 26 passed；跨端共享契约检查通过（148 common events）。
- Rust IP/HTTPS 来源测试通过；PyInstaller sidecar 与 Tauri 0.3.1 构建通过，ad-hoc 签名和严格签名验证通过。打包后的程序实际导入 registry/shared core、核对默认 IP，并经 ASGI 验证无效 Key 返回 422。最初 smoke 将通配路由误写成具体注册路由，修正检查方式后通过；未改动产品代码。
- 部署脚本 12 项离线测试通过；现有 Caddy 2.9.1 仅通过 stdin adapt 候选配置，真实适配 JSON 的 gate 顺序与路由校验通过。未加载到生产。
- 浏览器使用实际 AuthGate 与隔离响应夹具检查：IP 可见、Key 掩码、提交立即清空、错误显示、连接成功、断网退出、展开旧本地工作区；控制台无错误或警告。无真实账号或凭据参与。
- 独立安全复核确认管理员 Key 在 /auth/me 和岗位委托中降为 user，未发现其他可证实的阻断问题。

## 最新远程合并

源实现提交 `1081d24`，与远程 `9ef3d4c` 普通合并为 `b6e531f`，保留资料规划工作台。只有架构文档顶部的两条新增说明发生冲突，已同时保留。合并后网页后端全量 1,049 passed、1 existing skip（140.27 秒）；相交的 Tutor/资料规划测试 62 passed，网页构建通过；桌面和共享包内容与候选打包时一致。

## 尚未执行

未申请 IP 证书、未上传部署文件、未更新/recreate/reload 线上容器、未签发真实个人 Key、未安装替换桌面应用。没有生产 IP HTTPS 与真实 Key 的端到端验收；当前 IP TLS 仍不可用，单独安装候选桌面不会使服务可连接。

证书申请等待管理员联系邮箱。正式发布需更新 Web 后端、Node 和 Caddy；首次添加证书挂载会短暂影响经过 Caddy 的公网入口，须获明确授权后执行。先验证服务端 IP TLS + 无 Key 拒绝 + 有效 Key + Tutor 流式，再安装桌面。

详细契约：[实现说明](../implementation/DESKTOP_IP_API_KEY.md)。服务端步骤：[部署说明](../../deploy/ip-api/README.md)。
