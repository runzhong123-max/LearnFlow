# 共享客户端逻辑

src/ 保存两个前端直接消费的密码规则、延迟预算和有 scope 的教学指导投影。原 frontend/src 路径仅 re-export，不是第二份实现。

包只含纯 TypeScript，不依赖 React，不共享身份 token、文件权限或数据库。修改后同时验证根 frontend 与 apps/desktop/frontend。
