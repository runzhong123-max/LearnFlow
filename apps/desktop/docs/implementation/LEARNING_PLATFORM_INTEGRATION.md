# 共享学习平台整合 v1

协议：`learnflow-platform/v1`；共享内核 0.2.0。两个宿主保留自己的身份、数据库和本地权限；21 份相同业务 API 迁入 packages/learning-core/src/learnflow_core/api，另增加共同平台发现接口。旧 app.api.* 仍指向同一模块对象，不复制处理逻辑。

`GET /api/platform` 只返回当前宿主、API 前缀、共享版本、worker 部署方式和同步能力声明；`GET /ready` 检查数据库连接，失败返回 503 且不泄露错误详情。二者不接受写操作，不是 Agent tool，不产生学习证据。

桌面首发接入在线学习空间：主窗口或托盘打开构建时固定的 HTTPS 平台地址（LEARNFLOW_PLATFORM_URL，默认 https://learn.learnflow.club）。在线窗口使用 Web 账号、平台 API 和服务端五核，不转发本地 token、文件、数据库或模型密钥。在线窗口没有 native capability；其地址只允许同 origin 导航。网页检测到远程 HTTPS 页面时不启用本地 IPC，即使运行在 Tauri WebView 中。

本地项目、桌宠与实验仍在原桌面主窗口；它们不自动关联云端项目或升级为服务端正式证据。在线学习空间是在桌面内嵌入同一 Web 产品的首发接入，不是将全部本地工作台改成云 API，也不是完整的离线同步实现。离线事件上报、统一项目 ID 映射、文件选择性同步和本地执行结果回传仍是后续交付，不能用目录或账号名称合并替代。

部署使用模块化 Web 后端、Node Tutor、Role Atlas/Graph Hub 和独立 memory worker。MEMORY_WORKER_EMBEDDED=false 时 API 不启动记忆 worker；独立 worker 使用相同数据库与现有队列，并用共享数据卷上的 OS 文件锁限制为一个进程。默认本地开发仍使用内嵌 worker。长任务生成仍使用现有 Task 机制，本次没有宣称所有任务已经进入持久化通用队列。

Contract impact：registry Web 2026-09-06.7、Desktop 2026-09-06.7-desktop；新增只读 learning_platform_v1 数据契约与实现绑定，旧 API/schema、事件 ID、证据链、评分与数据库结构不变。新增平台入口是 UI 导航，不是第四类主 Agent，也不是新 Kernel writer。

验收：两端全量后端回归、两端前端测试/构建、共享 API 模块身份检查、runtime surface 测试、worker 独占与启停测试、registry 漂移、compose config、桌面编译及打包。线上账户互通必须在实际服务器部署后通过同账号检查项目和复习数据；本地启动检查不能替代这一验收。
