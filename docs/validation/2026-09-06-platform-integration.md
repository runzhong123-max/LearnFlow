# 共享学习平台首发整合验收

日期：2026-09-06。代码整合与本机验证，不表示已部署生产服务器。

## 变更与兼容性

- 21 个重复业务 API 模块迁入 learning-core；两端旧导入保留同一模块身份。19 个模块与原文件逐字节一致；health 增加就绪检查，settings 改为读取宿主的配置路径。auth、agent、vnext_projects 的宿主差异继续保留。
- 新增只读 `/api/platform` 与 `/ready`；桌面新增固定 HTTPS 地址的在线窗口，不赋予远程页面 native capability。本地与云端历史不合并。
- 现有记忆合成队列可由独立 Worker 消费；API 在 external 模式下不启动它，共享数据卷的文件锁限制单 Worker。
- cohost 增加健康依赖、Worker 和生态网关配置；部署脚本新建私密配置且拒绝覆盖既有密钥。CI 加入配置生成与静态 Compose 检查。

Contract impact：共享核心 0.2.0；Web registry 2026-09-06.7，Desktop 2026-09-06.7-desktop。新增 learning_platform_v1 只读契约，Desktop manifest 增加向后兼容的 data_contracts 字段，并登记在线入口实现绑定。旧 URL/schema、134 个共同事件契约、确定性证据语义和数据库结构不变，无用户数据迁移。

## 已执行且通过

- Web 后端全量：566 passed，1 skipped；新增契约登记测试后的 platform + registry：27 passed。
- Desktop 后端全量：547 passed。
- Web 前端：453 项测试与生产构建；Desktop 前端：377 项测试与生产构建。
- Role Atlas：145 项测试、typecheck、生产构建。
- Rust：1 项在线地址约束测试；Tauri release 编译与 macOS app 打包。
- 共享模块身份、契约漂移、目录权威、API 清单生成/检查；配置生成 2 项测试、shell 语法与 Compose 配置解析。
- 独立 Worker 使用临时数据库实际启动，第二进程因独占锁被拒绝，SIGTERM 后正常退出。
- 打包 sidecar 在独立临时 cwd 和数据库运行，health、ready、platform 与 registry 均通过，核心版本为 0.2.0。
- 隔离 seeded demo 启动，双端 `/demo` 与 `/review` HTTP 入口正常，demo/status 启用、architecture/validate 有效。为保留用户现有 demo 进程，本轮未执行会重置该进程的 `start.sh demo`，使用同一 seed 脚本和随机端口启动隔离实例，检查后已关闭。

## 执行失败与修复记录

- 首次 Web 全量回归有 1 个注册表测试失败：既有测试的 owner 预期未包含新增只读契约；补齐后全量与专项回归通过。
- Role Atlas 首次在沙箱中因 tsx 无法创建本地 IPC socket 失败；以允许本机 IPC 的方式重跑后测试和构建通过。
- Tauri 生成包的初始资源签名校验失败；本地产物重做 ad-hoc 签名后 strict/deep 校验通过。这不是公开发行签名或公证。

## 环境限制与上线前必验

- 本机 Docker 守护进程未运行：未执行镜像构建、容器运行、真实 DNS/TLS 或服务器部署。Compose 解析通过不能替代镜像与线上验收。
- Mac 锁屏使浏览器控制无法启动：本轮未完成 UI 目视操作和原生在线窗口交互验证；HTTP、单元测试和打包检查不能替代它们。
- 未安装或启动新 app 替换用户当前运行的应用；未测试真实云账号的跨设备数据、Atlas/Hub 交接、模型调用与服务重启后的卷持久性。按 LAUNCH_PLAN.md 第 3 步验收后才能发行。
- 完整离线同步、云项目与本地工作区绑定、通用长任务队列、选择性文件同步和课程/班级权限仍未实现。

回退代码使用普通 revert，保留原数据卷与加密/签名密钥；不要用旧桌面库覆盖云库。本次无 schema 迁移。
