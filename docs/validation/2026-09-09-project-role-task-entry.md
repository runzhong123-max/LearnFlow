# 桌面项目与个人岗位任务入口验收

功能提交：`f4d152a43d3a45ba519fac5912b07d90ca8735eb`。桌面 `/projects` 增加个人岗位包和任务转换入口；Role Atlas `/registry` 复用完整个人中心，保留未发布项目。范围与兼容性见 [工作任务转换](../implementation/WORK_TASK_CONVERSION.md)。

## 已执行且通过

- Desktop 完整前端测试：443 passed。
- Role Atlas 完整测试：351 passed；typecheck、build 均通过。
- Desktop 架构注册检查：25 passed。
- Desktop TypeScript/Vite build、PyInstaller sidecar、Tauri macOS app 最终构建通过；本地 ad-hoc 签名与 strict 校验通过。
- 打包后端使用内存数据库验证 `2026-09-08.9-desktop`、255 条路由及共享核心确实来自打包目录。
- 实际浏览器隔离检查：项目三种模式、主次导航、手填折叠、跨模式草稿保留、600px 无横向溢出、项目加载失败在折叠外显示。正常路径无 console error/warn；503 失败场景为明确注入的测试。
- Role Atlas 实际浏览器隔离检查：完整个人中心显示无 Release 草稿与已有成果两张项目卡，两个 tab 和项目链接正确。模拟 API 与日常数据库隔离。
- diff 检查通过；独立审查发现的隐藏错误提示已修复并在浏览器复核。

首次预览绑定端口与部分沙箱检查受环境限制，获准后通过；本地 app bundle 初始未封装资源签名，补本地 ad-hoc 签名后 strict 校验通过。没有删除断言或降低权限验证。

## 尚未执行

- Git push：两次自动审批拒绝，认为根 AGENTS 的历史本地重构禁推条款仍适用；第二次提供用户既有“允许推送”及条款时间范围后仍拒绝。等待用户对当前提交推送 main 重新授权。
- 线上 Role Atlas 发布：只完成只读基线核对和本地发布准备。未上传源码、未构建线上候选镜像、未切换服务。服务重启确认待用户授权。
- 本轮桌面安装：自动审批同样因历史禁装条款拒绝，未替换现有应用。已重新打开原安装版本。最终构建包保留，可在得到授权后安装。
- 未用真实账号创建、转换或导入测试任务；未运行付费模型、比赛 demo 或完整后端业务回归。本轮没有后端实现、共同 schema 或证据写入变化。

## 继续操作的本地定位

隔离工作区为 `/private/tmp/lf-project-entry-desktop-20260909`，安装脚本是其中 `apps/desktop/desktop/scripts/install_macos_app.sh`。其 Tauri target 复用 `/private/tmp/learnflow-guidance-integrated/apps/desktop/desktop/src-tauri/target`，安装前需再次确认 bundle 的主程序与 sidecar 未被后续构建替换。

发布准备在 `/private/tmp/lf-role-entry-release-20260909-pi/README.md`：只更新三个 Role Atlas 页面文件，保留现有 Compose 链并仅替换该服务镜像。正式切换前必须重新核对服务与并发发布，不能使用过时基线覆盖后续修改。

Contract impact：仅复用既有导航和交接，无新 API、事件、五核规则或数据库迁移。
