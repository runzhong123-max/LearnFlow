# 岗位项目结果卡崩溃修复

根因：冷启动草稿把停止原因字符串存入 `result.outcome`；ProjectToolPane 误将其视为 IterationOutcome 并访问 `work.completed`，导致整个项目页进入错误边界。TypeScript 类型声明无法校验历史 JSON。

修复：新草稿使用 `stopReason`；API 读取时兼容旧草稿并去除非法 outcome，保留原始存储记录。渲染入口校验迭代结果的对象、数组与计数，缺字段时展示摘要不完整，不补造零计数。草稿单独显示首版未完成、停止原因和已有缺口。结果展示组件有实际 React SSR 回归，覆盖旧字符串、新草稿、部分对象、原型名称、完整迭代与 API 兼容投影。

Contract impact：Role Atlas 内部任务结果的向后兼容读取修复，无岗位包 schema、三类 Agent、五核或 LearnFlow 共享契约变化。无数据库迁移，未重新执行研究。

已通过：Role Atlas 631 项测试、类型检查、构建及 git diff --check。新镜像切换前另外复跑结果展示与历史结果回归。本轮不涉及 LearnFlow Web/桌面实现，未重复执行其全量回归。
