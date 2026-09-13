# 教学对象与五核交互的源码证据

审计基线：`62fd197236c4852b93bdf4a835020f095f2e8bb1`。以下是只读实现审计，不是运行通过记录。新增实验的实际范围和结果分别保存在论文交互验证与长尾验证目录。所有路径以本仓根目录为基准；机器来源 hash 见同目录 `object-interaction-source-hashes.json`。

## 职责与存储

| 组件 | 已有实现 | 必须保留的边界 |
|---|---|---|
| 五核 | `packages/learning-core/src/learnflow_core/learning_runtime.py:235` 统一事件归约、Mutation、状态与事实形成 | 不是五个 Agent；零核目标操作不产生核变更 |
| 学习路径 | 同文件425行将确认路线写入 Structure.long_term.learning_path_plans，并同步 Value.confirmed_goals；`api/learner_state.py:165` 构造个人路径覆盖层 | 不是完全独立于五核的路径表；确认路径不自动创建 LearningTask |
| LearningTask | `backend/app/models/learning.py:409` 独立任务表；`backend/app/services/learning_tasks.py:259` 读取有作用域上下文；1134行核查学习、实践、验证与复习交接 | 完成返回 mastery_unchanged；生命周期事件零核目标 |
| ReviewSchedule | `backend/app/models/learning.py:369` 调度表；`backend/app/services/review.py:129` 按真实结果更新；617行从已有 Attempt 与纠错回填 | 可重建指当前回填算法，不承诺任意全事件重放；调度不直接写核或判定掌握 |
| 复习工作台 | `frontend/src/ReviewWorkbenchPage.tsx:201` 调队列、呈现题目、提交与延期；`backend/app/services/review.py:471` 重读复习 Tutor 上下文 | UI 不是掌握权威；复习上下文不等于所有五核均参与每次调度 |
| 三类 Agent | `packages/learning-core/src/learnflow_core/registry_core.py:299` 的共享责任接口 | 不是固定三个独立模型进程；评分和证据批准仍由确定性代码承担 |

## 实际交互链

路径：`frontend/src/main.tsx:2833 acceptLearningPathPlan` → `formal-runtime.ts:812 commitFormalLearningPathPlan` → `api/learner_state.py:683 commit_learning_path_plan` → `record_event` → Structure / Value 归约与来源记录 → `_path_overlay` → 页面刷新。离线分支仅存本机，前端明确提示尚未进入五核上下文。本文新增服务核验不覆盖该浏览器离线分支。

复习：`api/phase3.py:620 submit_concept` 产生正式 Attempt 和 concept_attempt_evaluated → Knowledge / Practice 归约 → 702行调用调度 → 工作台取得复习项 → `api/review.py:830` 产生复习 Attempt 和 review_attempt_evaluated → `learning_runtime.py:1533` 更新 retention_status / review_history → 调度器计算下一次 due_at。初次判题和复习判题均由真实入口执行才构成行为证据，不能用直接写表代替。

## 操作与证据分流

`backend/app/services/architecture_registry.py:1300–1324` 中 LearningTask 生命周期事件为零核目标；1373–1378行中复习评分指向 Knowledge / Practice，skip / defer / suspend / resume 为零核目标。事件被记录与状态被更新是两个命题。`test_learning_tasks.py:472` 的静态测试证据与实际本轮执行需要分别报告。

学习路径接口是学习者全局范围。LearningTask 可有 session，但 ReviewSchedule 与 LearningAttempt 不具有 session 列，正式复习事件只绑定 learner/project/checkpoint。不能将整条链描述为同粒度的会话隔离。`api/learner_state.py:286` 的快照读取还会回填任务并提交，因此“投影只读”也不意味着所有页面读取 API 完全没有业务副作用。

## 长尾读取机制与部署默认

当前 `registry_core.py:8` 为 `relevance-budget.v4`。`five_kernel_context.py:70` 的默认 policy 仍采用 legacy 候选，source_text=False、compact_episodes=False；可选能力存在不等于所有消费者默认启用。

- `memory_query.py:155`：Unicode NFKC、casefold、11组别名及有界错拼候选，不能保证任意同义词或错误拼写。
- `five_kernel_context.py:960`：legacy通道最多240项，最多12词各24项，时间候选最多48槽；词法排序不能恢复从未进入候选的记录。
- `five_kernel_context.py:1032`：可选来源/全池通道最多4096项；corpus BM25 / hybrid最多80排行项。启用source同时改变来源读取及扫描范围，不能作纯分段因素解释。
- `memory_source.py:162`：核验 Fact → Mutation → Event 与scope；`memory_excerpt.py:11` 保留正文hash与偏移，限定遗漏有诊断，不保证全部限定共同交付。
- `memory_paths.py:19`：最多两跳，第二跳限 BLOCKS/ENABLES，24根、32前沿、768边候选、每根最多4个第二跳分支；不是任意深度的课程或知识图推理。
- `five_kernel_context.py:1255`：控制、episode、事实与完整路径受装包预算约束；255行预算为序列化字符数/3.2估算，不是模型真实计费token。

这些机制为长尾任务提供可检验的组成部分，不构成真实长尾分布覆盖、跨课程迁移或教学效果证明。
