# 教学包、知识输入与原子任务契约验证记录

日期：2026-08-28
注册表：`2026-08-28.1`

## 验收范围

- Knowledge 只作为可选、answer-free、scoped 的 Learning Design 输入，不成为教学包状态或 Kernel writer。
- Lecture 规划和正文生成只消费通过 answer-free 校验的 Knowledge 摘要、规范 facet 与有界观察；校验失败时使用通用输入。
- `package_readiness` 不依赖 LearningTask，只从既有教学资产确定性重建。
- `task_readiness` 区分未绑定、等待接受、可降级启动、可练习、可验证和终态。
- 缺少知识上下文或教学资产时允许通用包与最小讲解继续；缺少正式练习/评估时不开放对应阶段。
- 旧 `delivery_readiness` 顶层字段保持兼容，且所有新投影明确不表示掌握。

## 关键断言

- 同一份完整教学包在没有 LearningTask 时仍为 `package_readiness.verification_ready`，任务投影为 `unbound`。
- queued/active LearningTask 即使教学包仅有大纲，也可通过 Teaching Contract fallback 获得 `learn` 阶段，状态为 `runnable_with_fallback`。
- 只有存在正式练习时才开放 `practice`；只有确定性答案契约、Blueprint 和 Rubric 齐全时才开放 `verify`。
- proposed 任务必须等待学习者接受；completed 只表示运行完成，固定 `operational_completion_is_mastery=false`。
- 新结构不新增数据库表、EvidenceEvent、Agent、Skill 或五核写入路径。

## 执行结果

| 检查 | 结果 |
|---|---|
| `backend/venv/bin/python -m pytest -q` | 208 passed；仅现有弃用警告 |
| `frontend/npm test` | 134 passed |
| `frontend/npm run build` | 通过，TypeScript 与 Vite production build 成功 |
| `git diff --check` | 通过 |

未执行 seeded demo：本次没有修改 demo 数据、启动链、UI 路由或离线运行契约；完整后端回归已包含 architecture registry、LearningTask、五核、纠错、用户隔离与 vNext 项目测试。
