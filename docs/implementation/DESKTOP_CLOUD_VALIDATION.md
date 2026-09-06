# 桌面 0.2.0 云账号连接验收（2026-09-06）

交付：Apple Silicon macOS LearnFlow 0.2.0，固定平台 `https://learn.learnflow.club`。主窗口直接使用云账号；不再依赖另开网页窗口才能使用共享身份。设计边界见[连接契约](../../apps/desktop/docs/implementation/DESKTOP_CLOUD_CONNECTION.md)。

## 已执行并通过

- 桌面后端全量 pytest：555 passed；含云 Cookie 隔离、CSRF、原生请求门禁、账号切换旧句柄失效、受限桌宠、云项目 ownership、文件冲突/幂等/路径边界、实验预览确认与重复确认不重跑。
- 桌面前端全部 npm test：378 passed；含云 API 转发地址、按云源站与账号隔离缓存、拒绝向任意 URL 发送原生认证信息。
- 共享契约检查：两端共用 6 Python 模块、22 API 模块、4 TS 源文件及 134 个共同事件合同，无漂移。
- 桌面前端 TypeScript/Vite 构建、PyInstaller sidecar、Tauri macOS app 构建成功；Rust 单元测试 1 passed。
- 新应用 `codesign --verify --deep --strict` 通过；属于本地 ad-hoc 签名，并非 Apple Developer ID 签名或公证。
- 真实服务器联调：同一临时账号经网页 API 与桌面连接层返回同一 learner；桌面创建项目后网页读取同一项目；云项目绑定本机临时目录、读取文件、预览并确认 C 语法检查成功；认证后的生态网关 catalogue 查询成功；退出后会话不可再用。
- 从新 `.app` 内实际启动打包 sidecar，以隔离数据库和随机 loopback 端口登录真实云端、读取该项目、完成 Tutor 流式回复并退出；收到完整 done 事件。
- 临时 QA 账号已停用，全部会话撤销；测试项目留在该停用账号下作为验收痕迹，不归入用户账号。测试目录使用系统临时目录并已清理。

ZIP SHA-256：`d1c084aa3849ec945fa3dd447e72ce1c03cc04551267d9d3b78ef23e73a9be6b`。

## 范围与未执行项

- 未替换用户当前已安装应用，未用用户密码进行 GUI 登录；上述线上验证通过临时账号和实际打包后端执行，不能声称已逐屏人工验收。
- 未执行 Intel/macOS 跨版本设备测试、Apple 公证、完整离线同步、旧数据库迁移；当前提供 arm64 包，应用重启后需要重新登录。
- 云端桌宠支持受限会话问答、选中文字与复习概览，任务变更在主窗口完成；图片/文档观察保留于旧本地模式。旧本地实践案例阶段工作流没有迁到云端。
- 未重跑 Web 后端全量回归与 seeded demo：本轮没有修改 Web 运行代码、共同学习核心或证据语义；执行了跨端漂移检查及真实云端接口联调。
- 首轮后端回归曾因新增 registry 合同的写入路径声明和测试版本/列表断言失败，修正后全量 555 项通过。最初根脚本的打包参数透传失败，改用桌面 npm 入口后成功。构建仍有既有大 chunk 提示，pytest 有既有弃用警告。

Contract impact：仅桌面 registry 升为 `2026-09-06.8-desktop`，新增连接适配合同、扩展文件和实验实现绑定；云 API、三类 Agent、五核与 EvidenceEvent 语义不变，无数据库迁移。旧模式仍可显式选择；回退应用包不删除本地数据。
