# 共享客户端逻辑

src/ 保存两个前端直接消费的密码规则、延迟预算和有 scope 的教学指导投影。原 frontend/src 路径仅 re-export，不是第二份实现。

包只含纯 TypeScript，不依赖 React，不共享身份 token、文件权限或数据库。修改后同时验证根 frontend 与 apps/desktop/frontend。

runtime-surface.ts 统一区分本地 Tauri 页面与远程在线平台页面，后者始终使用 Web 身份，不启用本地 IPC。
