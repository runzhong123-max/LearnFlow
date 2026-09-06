# 原子学习 Skill Runtime v5

- 状态：已实现
- 运行时版本：`atomic-learning-skill-runtime-v5`
- 数据迁移：`v16-atomic-learning-skill-runtime`

## 1. 产品承诺

学习 Skill 不是一段提示词，也不是新的 Agent。它是 Tutor 在一项明确学习目标中采用的、
可恢复且有边界的教学策略。首批四种主 Skill 共用一个外层闭环：

```text
学生选择方法，或接受 Tutor 推荐
  -> LearningSkillRun + 同一 LearningTask
  -> 有界教学互动
  -> 无提示独立验证
  -> 必要时进入确定性纠错
  -> ReviewSchedule 复习转交
```

`LearningSkillRun` 只负责“当前怎样教”，`LearningTask` 负责“这项原子学习任务如何安排和
恢复”，`LearningAttempt / EvidenceEvent` 才负责“学生实际做得怎样”。三者不得互相替代。

Tutor 可以推荐方法，但推荐固定返回 `requires_confirmation=true`，不能静默切换。显式选择
后立即建立或复用一个学习者可见的原子任务；退出方法只暂停流程和任务，不删除历史。

## 2. 首批四种方法

| Skill | 适用情境 | 三轮教学骨架 | 不适用情境 |
|---|---|---|---|
| `guided_explanation` 清晰讲解 | 陌生概念、认知负荷高、先建立最小模型 | 核心模型和最小例子 → 新例子检查 → 用“条件—机制—结果”重述 | 学生明确要自行推导；主要目标是程序步骤 |
| `socratic_dialogue` 苏格拉底追问 | 因果、证明、不变量；已有部分直觉 | 建立可回答起点 → 在具体情境检验判断 → 连接理由与边界 | 完全没有先备知识；学生明确要求直接解释 |
| `feynman_dialogue` 费曼复述 | 已接触主题后的查漏、概念组织 | 最小起点/首次复述 → 定位一个候选缺口 → 围绕同一缺口修订 → 独立验证 | 初次接触时不能从空白强迫复述；只需先看程序步骤 |
| `worked_example_fading` 示例渐隐 | 代码、算法、配置和其他程序性技能 | 子目标标注的完整示例 → 隐去最后一步 → 只保留子目标与起始条件 | 单纯事实解释；已经能独立完成且只需迁移验证 |

清晰讲解、苏格拉底追问和示例渐隐的有效引导预算为三轮；费曼复述预算为五轮，其中额外两轮
只能用于修订同一个候选缺口。每轮最多推进一个状态；预算结束必须停止追加教学，把仍未解决的
候选缺口交给独立验证。学习者可随时要求直接解释、暂停、换方法或稍后继续。

费曼运行数据增加 `calibration` 与 `teach_back_diagnostic`。校准由受众层次、认知要求、支架
强度、表征方式组成，初值可由学习者明确教育阶段提供，但只用于表达适配。诊断只使用表面可观察
信号区分定义绕回、前提缺失、因果断裂、机制黑箱、边界不清和迁移缺口；它始终标记
`verification=unverified / mastery_inference=false`，模型只能据此组织追问，不能把它升级成结论。

运行时先把学习者输入确定性区分为 `attempt`、`no_prior_knowledge`、
`direct_explanation_requested`、`orientation_problem_choice / orientation_example_choice`、
`skip`、`acknowledgement` 和 `missing`。只有 `attempt`
可以消耗有效引导轮次并推进一步；“不会”、
“不知道”、跳过、只回复“好的”或请求直接解释都会停留在当前步骤，记录支架次数并生成更具体
的解释、例子或选择题。该分类只决定教学流程，不评分答案正确性，也不写五核。

苏格拉底和费曼若由“什么是、跟我讲、没学过”等陌生主题请求显式启动，进入 grounded entry：
Tutor 先提供足够回答当前问题的最小知识支架，再要求一个小动作，不得让学习者从空白猜关键
关系或完成整段复述。学习者后续出现可检查尝试后，才进入方法原本的推理或复述阶段。
选择“A 看问题/B 看例子”只决定支架内容，不视为知识作答，也不消耗有效轮次。

详细选型依据与产品研究见 `docs/ATOMIC_LEARNING_SKILLS.md`。

## 3. 运行与任务同步

SkillRun 启动时会创建或复用同 Session、同目标的非终态 `LearningTask`，并把 Skill 写入
任务计划的 `learn` 阶段。运行同步规则是确定性的：

| SkillRun 动作 | LearningTask 变化 |
|---|---|
| 启动 / 恢复 | `queued/paused -> active` |
| 暂停 / 切换方法 | `active -> paused` |
| 到达 `verification_ready` | 完成 `learn` 阶段；不产生掌握证据 |
| 开始独立验证 | 在同一任务上物化 `MicroLearningRun`，不创建第二个任务身份 |
| 验证完成 | 重投影任务阶段、证据引用和复习转交 |

这些变化使用现有 Learning Task 零 Kernel target 事件，只是运行协调。`LearningSkillRun` 新增
可空 `learning_task_id`；旧 SkillRun 若已有微学习附件，迁移会按 learner ownership 回填其
现有任务引用，无法匹配的旧记录保持可读。

状态迁移、轮次预算、暂停恢复、任务同步和验证准入由
`backend/app/services/learning_skill_runtime.py` 确定性控制。LLM 只能渲染当前步骤，不得改
状态、评分、纠错策略、复习间隔或掌握结论。无模型时使用同一状态机的确定性文案。
Tutor 交互模型默认共享 10 秒总预算；结构化或纯文本返回空内容也视为失败，必须在剩余预算内
尝试兼容调用或立即返回当前步骤的确定性文案，不能保存空白 Tutor 消息。
进行中的 Skill 已由 runtime 决定教学步骤，不需要项目建议或任务识别等结构化输出，因此直接
调用纯文本 Tutor；普通对话才尝试结构化输出。这避免供应商不支持结构化 schema 时耗尽整个
教学回复预算。若模型在“起步、不会、请求解释或选择支架入口”时失败，Tutor 可以只读复用
当前学习者已有、主题匹配的学习卡片来建立可靠起点；一旦学习者给出有效尝试，就只能返回
当前阶段的追问或修正，不能再次播放整段起步讲义。

## 4. 前端与 API

独立对话 `/agent/:sessionId` 仍是唯一主输入。Skill 卡显示四步流程、当前方法、目标、有效
引导轮次、支架说明、暂停/继续/验证动作，并明确“当前任务就在这段对话中”。SkillRun 已绑定的
LearningTask 不再产生指向任务详情页的竞争入口；完成教学引导后由“开始独立验证”在同一
任务上物化 `/learn/:runId` 文件附件，完成后回到原 Session。Chat 模式条显示此时为 `learn`，
其中仍可按需调用 `guided_explanation`，不要求学习者在讲解与任务之间切换页面。

| API | 用途 |
|---|---|
| `GET /api/agent/skills` | 返回四种可选方法及适用/避用元数据 |
| `GET /api/agent/modes` | 返回 free / explain / learn / plan 四种粗粒度 Chat 契约 |
| `POST /api/agent/sessions/{sessionId}/skill-runs` | 幂等启动任一运行型 Skill，并绑定任务 |
| `POST /api/agent/sessions/{sessionId}/skill-runs/{runId}/actions` | 暂停、恢复、校准费曼维度，或在同一任务上开始验证 |
| `GET /api/agent/sessions/{sessionId}` | 恢复 Session、最近 SkillRun、任务引用和推荐 |
| `POST /api/agent/sessions/{sessionId}/turns` | 在 runtime 已裁决的当前步骤内继续对话 |

查询和动作都校验 `learner_id + session_id + run_id` ownership；创建和动作使用
`client_request_id / client_action_id` 幂等，状态动作使用 `expected_version` 防止陈旧覆盖。

## 5. 事件与证据边界

以下 Skill 事件全部为零 Kernel target：`learning_skill_run_started`、
`learning_skill_run_advanced`、`learning_skill_run_paused`、
`learning_skill_run_resumed`、`learning_skill_calibration_updated`、
`learning_skill_teach_back_diagnostic_updated`、`learning_skill_verification_started`、
`learning_skill_run_completed`。任务同步继续复用已登记的 Learning Task 生命周期和阶段事件。
其中 `learning_skill_run_advanced` 的 payload 会明确携带 `response_signal` 与 `support_only`；
支架回合允许 `from_state == to_state`，且不会增加 `turn_count`。

讲解、追问、复述、阅读示例和有提示补全都不是掌握证据。真正的能力证据必须从验证附件进入
`LearningAttempt -> EvidenceEvent -> reducer -> KernelMutation -> Memory Graph`，答错后继续
使用既有 `RemediationCase`，验证结果再由 `ReviewSchedule` 转交复习。完成 SkillRun 只表示
本轮已有独立验证记录，稳定掌握仍要求跨时间、独立且含已校验变式的复习证据。

## 6. 工程评测与产品实验

`backend/evals/learning_skill_cases.json` 固定 32 条人工标注请求，四种方法各 8 条。运行：

```bash
cd backend
venv/bin/python scripts/evaluate_learning_skills.py
```

`atomic_learning_skill_runtime_v5_skill_spec_v2` 的冻结样例结果为：路由准确率、有界运行、验证交接和
证据边界均为 `1.000`；只会普通讲解的基线分别为 `0.250 / 0 / 0 / 0`，四项平均提升
`0.938`。这只证明工程契约可执行，不证明真实学习效果。

线上必须继续测量：推荐接受率、任务启动/完成率、验证启动/完成率、平均提示等级、纠错完成
率、暂停恢复率、24 小时和 7 天复习保持率，并结合访谈检查学生是否感到被流程绑架。

## 7. Contract impact

- 注册表版本提升为 `2026-08-27.4`，运行时提升为 v5。稳定 Skill ID 和四个主要状态 ID 不变；
  旧运行记录可继续恢复，缺失的校准字段使用注册表默认值。
- 费曼 turn budget 从 3 增至 5，仅允许在 `revising_explanation` 围绕同一缺口循环两次；其他
  Skill 的预算和状态图不变。
- API 回包向后兼容地增加 `calibration / calibration_axes / teach_back_diagnostic /
  gap_loop_count`，动作增加 `calibrate`。全部存放在现有 `run_data`，无需数据库迁移。
- 两个新增事件均为零 Kernel target；`teach_back_analyzed` 仍只属于正式微学习的已验证诊断链。
- 三类主 Agent、五核 schema、评分、纠错、复习和 reducer 均未改变。

- 注册表版本提升为 `2026-08-24.6`。苏格拉底契约新增“陌生主题先支架”和“非尝试不得推进”
  规则；没有新增主 Agent、Kernel 或直接写入路径。
- `LearningSkillRun.learning_task_id` 是可空、向后兼容字段；迁移 `v16` 只补链接，不删除旧
  Session、Attempt、纠错、复习或五核数据。
- v3 只在现有 `run_data` 中增加 `entry_mode / support_count / last_response_signal / flow_note`；
  无需数据库迁移，v2 运行记录可继续恢复，并在下一次互动使用新分支。
- API 回包向后兼容地增加 `support_count / last_response_signal / flow_note / stages`；旧前端可以忽略。
- Tutor 默认模型总预算从 25 秒收紧到 10 秒，并拒绝空白模型回复；环境变量仍可显式覆盖。
- Active Skill 改为纯文本优先调用；这只改变回复渲染路径，不改变状态机、Action 或证据语义。
- 模型失败时只在起步和求助信号下只读复用 learner-owned 学习卡片；有效作答后的回退仍由
  Skill 状态机当前步骤决定，不新增内容权威或写入路径。
- 评分、`RemediationStrategy`、复习策略和五核 reducer 均未改变。
