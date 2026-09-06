# Agent 学习闭环验收记录（2026-08-26）

## 范围与结论

本轮收紧了对话背后的正式学习对象：复习统一提交、确定性纠错与变式、学习任务阶段门、Knowledge/Practice 五核投影、个人概念学习图和 vNext 学习任务工作台。架构注册版本提升为 `2026-08-26.18`。

结论：自动化回归、隔离 seeded demo、vNext 真实浏览器闭环和架构漂移校验均通过。学习结果仍严格经过：

```text
用户/UI 动作 -> LearningAttempt / EvidenceEvent
  -> five_kernel_reducer -> KernelMutation -> KernelState
  -> MemoryFact -> MemoryModule -> MemoryClaim
```

LLM、页面和工具都没有直接写 `KernelState`；任务完成、内容曝光和用户自述都不会自动升级掌握。

## 关键行为证据

### 复习、纠错与五核

在重置后的离线比赛账号中完成以下真实浏览器流程：

1. 打开 vNext 复习工作台中的 `修复 safe_average 的空列表错误`。
2. 无提示提交带空列表守卫分支的代码；确定性判题通过后，统一 `/api/review/items/{id}/submit` 自动切到迁移变式。
3. 对新输入 `[10, 20, 30, 40]` 提交 `25.0`；纠错案例从 `variant_ready` 进入 `completed`。
4. 熟练度从脆弱状态升级为 `73 / 可迁移`；`变式迁移` 为 `75`，下一条证据要求变为“按期完成下一次无提示检索，形成跨时证据”。
5. 误解由 `ACTIVE` 变为 `CORRECTED`；保留“运行时行为与预期不一致”、有效执行追踪、原题独立重做和迁移结果。
6. 写入一条用户启发。页面与事件均明确标为“用户自输入 / 待验证”，不形成掌握推断。
7. Knowledge 个人概念节点 `修复空集合边界条件` 展示 6 条认识历程和 1 条 verified 证据，包括误解、主动检索、原题重做、迁移变式、闭环和用户启发。

该流程同时验证了变式提交的幂等重放不会泄露 `expected`、`answer_indexes`、测试答案等私有判题数据。

### 学习任务对象

同一 seeded 学习任务在正式队列中呈现：

- 任务目标、预计时长、阶段进度、当前阶段和正式状态；
- `回到学习现场` 指向原项目关卡；
- 队列状态下只开放 `start/cancel`；
- 启动后只开放当前阶段 `complete_phase`、`pause/cancel`，不会提前出现 `complete_task`；
- 正式练习、变式和复习交接已由证据完成 3 个阶段；学习阶段确认后由确定性规则从 `3/4` 自动闭合为 `4/4`，待完成数由 1 变为 0。

任务完成仍只表示流程闭合；稳定掌握继续由跨时复习证据判断。

### 多页面与本地 SQLite

并发打开 legacy demo 和 vNext 时，曾复现只读请求因认证依赖隐式更新 `last_seen_at` 而产生 `database is locked`。修复后：

- SQLite 连接设置 30 秒 busy timeout，并启用外键检查；
- 认证观察不再让每个 GET 隐式取得写锁；
- 同时刷新两个页面后，review、projects、tasks、profile 等请求全部返回 200，服务日志无 500。

## 自动化验证

以下命令均在本轮修改完成后实际执行：

| 检查 | 结果 |
| --- | --- |
| `cd backend && venv/bin/python -m pytest -q` | 180 passed |
| `cd backend && venv/bin/python -m pytest tests/test_architecture_registry.py -q` | 12 passed，registry 无漂移 |
| `cd backend && venv/bin/python -m pytest tests/test_remediation.py -q` | 3 passed |
| `cd vnext && npm test -- --runInBand` | 60 passed（9 + 23 + 6 + 9 + 11 + 2） |
| `cd vnext && npm run build` | 通过，330 modules |
| `cd frontend && npm run build` | 通过，3399 modules |
| `bash start.sh demo` | 隔离数据库重建成功，offline demo 启动成功 |
| `GET /api/demo/status` | `enabled=true, offline=true` |
| `GET /api/architecture/validate` | `valid=true, errors=[]` |
| `GET http://localhost:5174/demo` | HTTP 200 |
| `git diff --check` | 通过 |

已知非阻塞警告：Python 3.14 下现有 `datetime.utcnow()`、Pydantic class config 与 TestClient 兼容性弃用警告；legacy 前端仍有 Monaco 大分块警告；vNext 测试命令向 npm 透传 `--runInBand` 会产生未知配置警告，但 Node 测试全部通过。

## Contract impact

- Registry：`2026-08-26.17 -> 2026-08-26.18`。
- `review_workbench` 明确登记 `evaluate_transfer_variant`，与统一 review ACI 一致。
- 既有 `remediation_variant_evaluated` 事件现在按注册表声明同时投影到 Knowledge 与 Practice；无提示正确变式在 Memory Graph 中定级为 `verified`。
- 没有新增第四类主 Agent，没有新增第二套画像权威，没有破坏现有 API 路径。
- 旧的直接 remediation variant 端点继续可用；统一 review 提交为兼容增强。
