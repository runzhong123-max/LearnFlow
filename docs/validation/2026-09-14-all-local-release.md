# 本地全部更新推送与部署

用户明确要求“将目前本地所有更新推送并部署”。最终应用版本为 `12bb721296fa373ce76d195a1da48dd5d9357602`，已同步 `origin/main`。包含记忆证据与当前复习资格、资源推荐工具结果、岗位任务转换身份修复、典型任务页、桌面项目对话与代码纸、账号浮层移除。最后一项在发布准备期间完成，已纳入最终镜像后统一切换。

## 云端

2026-09-14 部署至既有 ECS `i-n4a084s5nh57syfytgfe`，发布目录 `/opt/ceg/releases/publish-12bb721-20260914`，`success` 和 `verification.json` 确认完成。

| 服务 | 镜像 SHA-256 |
| --- | --- |
| Web 后端、Memory Worker | `8611681007e06877b6ad11433c5fe326c8f04b8ac4f157bea4a93136e4069945` |
| Web 前端 | `598a55b31ac6c99db992498cbb7e611d503ce3db6ecef52481ebb495cf494420` |
| Role Atlas | `273f1cb52580b6da0e34e94d4522bad3b0381209c13cfddf8d5d3a609438066a` |

复用现有镜像依赖，离线构建并校验运行源码哈希；依赖文件保持一致。Compose 逐项比较，只有 image 改变，环境、入口命令、数据挂载、网络策略以及 Caddy、交接代理配置均保持。岗位 Job Worker 暂停后恢复。两个生产主数据库在暂停写入期间完成备份和 integrity_check，切换后 quick_check 通过。

`build_runs` 中存在一条昨晚遗留 running 记录 `f6913bfb-f778-4bba-8406-14012f87adf7`；同 ID 的 role_jobs 已于 `2026-09-13T15:31:22.202Z` failed，租约为空。发布脚本仅对该精确终态组合做只读识别，预检与切换时均重新验证，没有修改运行记录或取消研究。其他在途执行仍阻止部署。

本次备份保留为发布目录下 `backup-*.sqlite.gz`，压缩后逐字节校验解压内容哈希，`backups.json` 记录压缩与原始哈希。磁盘可用空间从备份后的约 395MB 恢复到约 1.5GB；仍需后续容量管理，未删除历史发布、旧镜像或生产数据。

公开验证：LearnFlow 登录页和 auth/status 200；Role Atlas、Graph Hub 匿名访问按预期跳转统一登录并返回 200；本机 Role Atlas HTTPS 返回 302。`/site-session.js` 200，SHA-256 与本地一致：`2441725653839af55ae5fd0b9b5cb336244b52a04c7e8504bbd5280da78c9c87`。七个相关服务 running，后端 healthy；部署脚本验证 ready 与 architecture/validate。

## 桌面

使用 `LEARNFLOW_PLATFORM_URL=https://learn.learnflow.club` 构建 macOS ARM64 应用，已安装到 `/Users/a1-6/Applications/LearnFlow.app`。旧应用完整保留为 `/Users/a1-6/Applications/LearnFlow.app.backup-20260914-12bb721`，未迁移或删除日常数据库。

Tauri 初始产物只有链接器签名，完整包校验失败；对本地应用补全 ad-hoc 签名后，`codesign --verify --deep --strict` 通过，安装后再次通过。最终分发包为 `apps/desktop/desktop/src-tauri/target/release/bundle/dmg/LearnFlow_0.3.1_12bb721_aarch64.dmg`，SHA-256 `c0f946c8a378557dc4659d6921db599ed0cc7b4d6344efc7a47572e3117a02fd`。这不是 Apple Developer ID 公证包，未发布 Windows 安装包或 GitHub Release。

## 验证边界

- 本轮重新执行：Web 后端 1155 passed、2 skipped；Web 前端全部 npm test 共 559 passed，追加账号脚本测试 1 passed；Web 生产构建、共享契约检查、diff 检查、桌面 sidecar 与应用打包通过。
- 复用同一源文件版本的既有验收：Role Atlas 657 项、类型检查、构建和本地浏览器交互；桌面前端 581 项、桌面后端 1170 passed/5 skipped，见项目对话工作台文档。本轮服务器另行构建最终 Web 与 Role Atlas 镜像并逐文件核验。
- 首次账号脚本探针错误地要求源码完全不含旧元素 ID，命中了仍保留的去重检测，探针失败；改为精确源码哈希核验后通过，没有为检查修改业务代码。
- 未重新运行 seeded demo、生产真实账号学习/研究、付费模型调用或桌面真人登录流程；没有创建生产测试项目。构建存在既有大 chunk 提示，后端存在既有弃用警告。

Contract impact：发布已有共享记忆证据契约和桌面展示登记，不新增部署层契约或数据库迁移；Agent、五核和事件写入边界沿源码既有实现。

回退：发布目录保留每个服务的 `*.rollback.json` 和旧镜像标签。在核对当前 Compose 链与任务空闲后，沿各服务配置链追加对应 rollback 配置定向重建；不自动恢复数据库、不执行全栈重建。桌面可恢复上面的旧应用备份。未触发自动回退。
