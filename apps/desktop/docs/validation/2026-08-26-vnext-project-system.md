# vNext 项目系统验收记录

日期：2026-08-26

## 变更范围

- 正式项目列表与项目工作台。
- 项目 Tutor、关卡对话和项目自由对话的 scope/状态分工。
- 项目路线、来源和受管学习文件的 Agent 感知/提案工具。
- 路线确认后生成正式 Roadmap、Checkpoint、Session 与 LearningTask。
- `project_created`、`roadmap_discussed`、`roadmap_applied` 的确定性五核边界。
- 项目删除与来源移除的确认/零掌握语义。

## 自动化结果

| 检查 | 结果 |
|---|---|
| `cd backend && venv/bin/python -m pytest -q` | 186 passed；仅既有弃用警告 |
| `cd backend && venv/bin/python -m pytest tests/test_vnext_projects.py tests/test_architecture_registry.py -q` | 15 passed |
| `cd vnext && npm test` | 65 passed（9 + 28 + 6 + 9 + 11 + 2） |
| `cd vnext && npm run build` | 通过，含 ProjectsPage 与 ProjectWorkspacePage 独立 chunk |
| `cd frontend && npm run build` | 通过；保留既有 Monaco 大 chunk 警告 |
| `GET /api/architecture/validate`（运行中后端） | `valid: true`，`errors: []` |
| `git diff --check` | 通过 |

## Agent 契约覆盖

- 路线工具锁定当前项目主题，不接受重复 key、未知前置或指向未来的前置边。
- 项目 Tutor 每轮先观察五核与项目工作台；项目源和学习文件按需读取。
- 模型只看得到 read/propose 工具，看不到 apply/write/commit/delete/confirm 工具。
- 路线提案不会改变项目；只有显式确认 API 才创建关卡、对话与学习任务。
- 工具输入失败返回可观察失败状态，不中断 ReAct 循环，也不伪装成功。
- 项目自由对话不会被通用 Session 恢复逻辑误选成项目 Tutor。

## 浏览器实测

在 `http://127.0.0.1:4174` 的正式 vNext 开发栈完成：

1. 重启服务后 `/api/vnext-projects` 返回 200，Vite `ProjectsPage` 导入错误层消失。
2. 项目列表恢复已有正式项目，并显示二次确认删除入口。
3. 新建“验收项目 · RAG Agent”，项目目标与真实产物持久化。
4. 新项目显示空关卡状态，明确不自动塞入假关卡。
5. 进入项目 Tutor 后显示固定“学习规划态”。
6. 新建项目自由对话后显示固定“自由态”，欢迎语明确共享项目 scope 但不推进关卡。
7. 正式五核连接状态恢复；浏览器控制台错误列表为空。

浏览器验收创建并保留一个名称明确的“验收项目 · RAG Agent”，没有替用户执行删除。路线物化、
关卡 Session/LearningTask、DAG 和五核 Mutation 由隔离测试数据库覆盖，避免在日常数据里写入伪学习证据。

## Contract impact

- 注册表版本：`2026-08-26.22`。
- 新增五个项目工具、一个项目编排 Skill、一个 vNext 项目列表工作台、一个会话管理 capability、
  两个零 kernel target 运行事件。
- `project_created` 可基于学习者明确输入更新 value；`roadmap_applied` 可更新 structure 的正式路线和
  返回锚点。没有 schema/table 破坏性变化；既有 `/api/projects/:id` 来源和删除接口保持兼容。
