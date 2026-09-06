# LearnFlow Claw 与 Learning Task Runtime

> 状态：v3 已实现（Chat Mode + 原对话主现场）
> 运行时版本：`learning-task-runtime-v2`
> 计划 schema：`learning-task-plan.v1`

## 1. 产品形态

LearnFlow 的主界面只有两类学习空间：

1. **对话**：Tutor 与学生讨论问题、澄清目标、规划路径，也可以在识别到原子学习目标后提出一个学习任务。普通问答仍然可以自由结束，不强迫进入流程。
2. **项目**：以真实产物或持续能力为目标的学徒旅程。项目包含来源、动态路线、关卡、项目 Tutor 与本地工作区；每个正式关卡对应一个固定 Session 和一个 Learning Task。

两条全局队列覆盖在这两类空间之上，而不是第三种教学模式：

- `/tasks`：待确认、待开始、进行中和暂停的学习任务。
- `/review`：由正式评估证据产生的复习任务。

`/learn/:runId` 继续存在，但语义收敛为 **Learning Task 的学习文件工作台**：当任务需要保存讲义、题目和正式验证时，Tutor 可以按需物化该附件；它不是任务主页面。

讲义还有独立的内容质量门槛：模型结果或受审核离线模板可以进入复述与验证；未知主题在模型失败时产生的通用占位内容只能用于诊断生成失败，不能推进学习流程或写入能力证据。学习者应重试生成、检查模型设置，或回到原 Chat 补充可靠来源。

### 1.1 页面与导航契约

同一个 Learning Task 只拥有一个当前学习现场，前端不再把任务控制台、内部文件容器和真实
学习过程混成三个入口。任务回包提供三种向后兼容的导航：

| 字段 | 语义 | 典型路径 |
|---|---|---|
| `navigation` | 继续任务，返回唯一主学习现场 | 原对话或项目关卡；仅无来源的旧任务回退到 `/learn/:runId` |
| `origin_navigation` | 返回任务被提出的位置 | 原对话或原项目关卡 |
| `management_navigation` | 管理优先级、暂停、恢复和移除 | `/tasks?task=:id` |

由对话建立且已物化文件的任务，`navigation` 和 `origin_navigation` 都仍指向原对话；文件
路径只存在于 `artifact_refs` 与 `runtime.next_action.path`。由项目关卡建立的任务以关卡本身为
学习现场。`/tasks` 明确为纯管理队列，不再展示计划编辑器、材料生成器或教学流程。

## 2. 为什么要有 Learning Task

Session、项目、后台作业和复习解决的是不同问题：

| 对象 | 回答的问题 | 生命周期 | 是否是学习证据 |
|---|---|---|---|
| `AgentSession` | 在哪里继续这段对话？ | 多轮对话 | 否 |
| `LearningTask` | 学生当前承诺完成哪个原子学习闭环？ | 可排队、暂停、续跑、重规划 | 否 |
| `Project / Checkpoint` | 长期学徒旅程和正式关卡是什么？ | 长期、版本化 | 否 |
| 旧 `Task` | 哪个后台程序正在运行？ | queued → running → terminal | 否 |
| `LearningAttempt / EvidenceEvent` | 学生实际做了什么，结果怎样？ | 追加、可审计 | 是 |
| `ReviewSchedule` | 哪个正式评估项何时应再次检索？ | 可重建调度投影 | 只有复习提交后产生证据 |

因此，Learning Task 不能复用旧后台 `Task`，也不能变成第六个 Kernel 或第二套掌握状态。

## 3. Claw 运行关系

```mermaid
flowchart TD
    U[学生输入或点击] --> S[对话 Session]
    S --> T[确定性 Chat Mode 协调]
    T -->|free| R[自由探索]
    T -->|explain| X[简单讲解后返回 free]
    T -->|learn| LT[Learning Task queued/active]
    T -->|plan| PJ[项目规划与提案]
    T --> Q{任务是否由 Tutor 推荐}
    Q -->|Tutor 主动建议| P[Learning Task proposed]
    P -->|学生接受| LT
    P -->|学生拒绝| C[canceled]

    LT --> PLAN[Learning Design 生成候选计划]
    PLAN --> RUN[Tutor 管理暂停、续跑、重排与交互]
    RUN --> METHODS[按需组装 Skills / 可视化 / 来源讲义]
    RUN --> ART[讲义与习题受管文件]
    RUN --> PRACTICE[Practice 正式练习与纠错]
    PRACTICE --> E[LearningAttempt + EvidenceEvent]
    E --> REVIEW[ReviewSchedule]
    E --> MEMORY[五核 reducer 与 Memory Graph]
    REVIEW --> RW[/review 独立复习台]
```

Tutor 始终保持用户控制权。Learning Design 和 Practice 是 Tutor 背后的能力接口，不新增第四个主 Agent。
每个 Tutor 回合都会装配当前 Session 内任务的目标、状态、当前阶段、可用 Skill 与完成规则；
这是 answer-free 的只读协调上下文，使对话可以持续推进同一个闭环，也避免每回合重复建任务。

## 4. 原子学习任务触发

### 4.1 显式触发

学生明确提出边界清楚的学习目标，例如：

- “用 15 分钟弄懂事件循环。”
- “我拿着这道指针题来问，带我完成理解和验证。”
- “把理解闭包加入我的待学任务。”

参数充分且本轮措辞已明确授权开始学习时，建立 `active` 任务；结构化输出以
`consent_basis=explicit_user_request` 保留授权依据，并由服务端对原始用户措辞再次校验，
不能只凭模型字段造成入队。明确的 15 分钟/微学习请求继续直接物化 `/learn/:runId`，同时
自动创建并关联 Learning Task。

服务端会在调用 Tutor 模型前，对“带我弄懂……”“教我理解……”等边界明确的请求执行保守
的确定性识别并进入 `learn`；任务身份和粗计划不依赖模型，但首轮 Tutor 仍必须给出有教学
价值的起步动作，不能只回复流程公告。识别器只覆盖明确的原子目标；简单的“什么是 X”进入
`explain` 且不建任务，“系统学习 X/规划路线”进入 `plan`。由对话创建的任务始终保留原
Session 作为来源、执行现场与返回锚点，即使随后物化出文件工作台也不会把任务移走。

### 4.2 Tutor 建议

Tutor 在普通聊天中发现一个适合形成闭环的原子目标时，只能返回 `learning_task_opportunity`。服务端创建 `proposed` 任务；学生点击“加入学习任务”后才进入队列。

以下情况不应创建任务：

- 单次事实问答或寒暄。
- 目标仍然模糊、需要先探索方向。
- 已经更适合形成多周项目、多个来源或真实产物。
- Tutor 只是想追加一个可选追问。

### 4.3 项目关卡

路线一旦正式写入，每个 Checkpoint 会获得：

- 唯一的 checkpoint Session；
- 唯一的 checkpoint Learning Task；
- 关卡目标、退出条件和来源引用；
- 已存在或后续生成的 `.lflecture` / `.lfexercise` 受管文件。

关卡被路线重排时，任务保持稳定 ID；关卡完成时任务同步为流程完成。项目仍然是长期学徒旅程，任务只是可执行队列单元。

## 5. 自适应任务计划

计划由 Learning Design 生成候选结构，由服务端校验并保存不可变版本。计划只包含 2–4 个粗粒度阶段，避免把教学拆成机械清单：

规划器把上下文分成两个通道：当前任务的 objective、source_refs、讲义/题目和正式 Attempt
组成任务内容通道；五核权威投影只提供可跨任务复用的 pace、format、support 明确偏好。
learner 级 `knowledge_gap`、`current_priority`、`assistance_level`、`path_position` 等易变字段不会
自动流入新任务，以免把上一个闭环的内容状态误用于当前闭环。重规划同样以当前任务证据为准。
计划保存 `personalization_basis` 说明实际使用了哪些可移植字段，但不复制原始记忆、答案或
新的画像结论；模型不可据此改变评分、掌握、纠错与复习策略。

| Phase | 目的 | 可组合能力 |
|---|---|---|
| `learn` | 建立可解释理解 | 清晰讲解、苏格拉底追问、费曼复述、示例渐隐、来源讲义、可视化 |
| `practice` | 主动尝试并暴露缺口 | 概念题、代码练习、产物任务、纠错闭环 |
| `verify` | 形成独立正式证据 | 无提示作答、测试、变式迁移 |
| `consolidate` | 转交复习队列 | `ReviewSchedule` 创建与 `/review` 导航 |

每个阶段保存：

- `id / kind / title / purpose`
- `methods`：只能引用注册表中的产品 Skill
- `required / status`
- `completion_rule`
- `artifact_outputs`

模型可以提出阶段和方法，但不能决定正式判题、掌握升级、纠错策略或复习间隔。服务端会拒绝没有正式 Attempt 的 `verify` 完成，也会拒绝没有 ReviewSchedule 的 `consolidate` 完成。

在线规划是限时增强，而不是任务创建的可用性前提。默认 wall-clock budget 为 120 秒，部署方
可通过 `LEARNING_TASK_PLAN_MODEL_BUDGET_SECONDS` 调整；超时、供应商错误或输出校验失败时
立即使用同一 `learning-task-plan.v1` 契约的确定性计划。Tutor 结构化调用与纯文本兼容调用
则共享一个总预算，避免一次回合因两次串行尝试而成倍等待。

### 5.1 确定性运行投影

`LearningTask` 的计划是意图，运行投影才回答“现在做什么”。每次读取或动作后，服务端按
同一 learner/project/checkpoint/session scope 重建：

- `materials`：讲义、题目集和练习是否已经生成及其打开路径；
- `current_phase`：第一个尚未满足证据条件的粗阶段；
- `next_action`：接受、开始、生成材料、继续学习、进入验证、进入复习或查看总结；
- `evidence`：接触事件、练习 Attempt、成功验证和 ReviewSchedule 的 answer-free 计数。

阶段推进规则固定为：

| 阶段 | 可以推进的依据 | 不能作为依据 |
|---|---|---|
| `learn` | 已完成对话 Skill、查看受管讲义/学习卡，或学习者明确确认本阶段互动结束 | 仅生成了讲义；Tutor 自行说“讲完了” |
| `practice` | 同任务范围内真实提交的练习或复述诊断 Attempt | 手工勾选；只阅读示例 |
| `verify` | 同任务范围内独立且判定成功的原始题或已校验变式 Attempt | 错题、缺失输入、有提示成功、诊断复述、原题纠错重做、复习重放或任意引用 ID |
| `consolidate` | 正式验证已完成且已有 ReviewSchedule | 模型给出的复习建议或任务完成文案 |

因此任务计划可以灵活组合方法，但核心进度不能由 LLM 或浏览器自行声称。任务全部 required
阶段满足后才写入流程完成；若任务已经物化专注附件，还必须完成该附件中的整组题目与纠错，
不能在第一道正确题产生 ReviewSchedule 后提前结束其余验证。“任务完成”仍不等于“长期稳定掌握”。

全局 `/tasks` 队列显示同一运行投影的当前阶段和完成比例，并只渲染 `available_actions`。学习者可从任务卡返回原 Session/项目学习现场；“完成当前阶段”仍调用正式 action gateway，`practice / verify / consolidate` 的证据门不会因前端按钮而放宽。所有必做阶段满足后 runtime 可自动完成任务，且完成事件继续保持零 Kernel target。

重规划使用乐观版本：

1. 学生说明调整原因或新方向。
2. Learning Design 只重组剩余计划。
3. 已完成阶段和正式证据引用被保留。
4. 追加 `LearningTaskPlanRevision(Vn)`，旧版本不可修改。
5. 重复 `client_request_id` 幂等重放，陈旧 `expected_version` 返回 409。

## 6. 文件与产物

Learning Task 不建立第二套讲义/习题存储。正式学习文件继续使用现有领域对象：

- `Lecture` 对外表现为 `.lflecture`；
- `Exercise` 与概念题集对外表现为 `.lfexercise`；
- 数据库对象、版本、答案保护和判题规则仍是权威；
- Task 只保存 `artifact_refs` 并提供打开路径。

前端不再把这些引用表现成与流程脱节的“任务文件夹”，而是投影成一个按顺序使用的学习包：

| 学习包环节 | 使用的对象 | 任务/证据语义 |
|---|---|---|
| 讲义学习 | `Lecture` / learning card | 建立理解；查看只形成低强度接触证据 |
| 引导练习 | 费曼复述、SkillRun 或关卡练习 | 暴露缺口；诊断 Attempt 不直接升级稳定掌握 |
| 独立验证 | `ConceptQuestion` / `Exercise` | 无提示有效提交才可推进验证阶段 |
| 错题纠正 | `RemediationCase`、原题重做、已校验变式 | 按错误触发；带提示成功与原题重做不冒充独立验证 |
| 间隔复习 | `ReviewSchedule` | 验证通过后转交独立复习工作台 |

学习包上的数量、锁定状态和已完成状态全部由现有 `runtime.materials`、计划阶段、Attempt 与
ReviewSchedule 派生，不保存第二套前端进度。讲义在流程推进后仍可只读回看；回看不回退
MicroLearningRun 状态，也不重复写接触或掌握证据。

普通对话任务始终在原 Session 中学习。需要保存材料和正式验证时，调用 `materialize`：系统创建内部 `task_artifact` 空间、Lecture、ConceptQuestion 和 checkpoint scope，并返回 `/learn/:runId` 文件工作台。该内部空间从真实项目列表隐藏，旧链接仍可恢复，文件页 Tutor 则复用原 Session。

任务中的 `.lflecture`、`.lfexercise` 和概念题引用在已有专注附件时统一打开
`/learn/:runId`，不会暴露内部 `task_artifact` 项目或把学生带到没有来源说明的隐藏关卡。
旧的内部关卡链接仍可恢复，但页面会明确提示该任务的实际学习现场，并提供进入专注学习的
主操作。

物化时材料来源按以下顺序确定：本次显式粘贴的来源文本、任务 `source_refs` 指向的原始对话
消息与选中文本、最后才是纯主题生成。生成成功后，Lecture、ConceptQuestion 和 Exercise 的
稳定引用会持久写入任务，而不是只在页面打开时临时拼接。讲义负责学习输入，题目负责检索与
验证；两者共享同一 LearningTask 和 scope，但生成本身均不构成能力证据。

学习包的在线增强默认最多等待 180 秒，可通过
`MICRO_LEARNING_ARTIFACT_MODEL_BUDGET_SECONDS` 调整。超时后会保存确定性讲义与验证题，
并在学习卡中记录 `generation_mode / generation_reason` 以供诊断；该标记不进入五核证据。

LearningTask 与其文件附件共享暂停语义：从 `/tasks` 暂停或恢复会同步
`MicroLearningRun`，从 `/learn/:runId` 暂停或恢复也会同步任务队列。同步事件全部是零
Kernel target；手工暂停任务不会被普通的运行读取误恢复。

## 7. 两条队列

### 学习任务队列

状态机：

```text
proposed -> queued -> active <-> paused -> completed
    |          |         |          |
    +----------+---------+----------+-> canceled -> queued(reopen)
```

学生可以：

- 接受或拒绝 Tutor 建议；
- 自行新增任务；
- 重排、设置优先级和时间预算；
- 暂停、恢复、移除或重新加入；
- 要求 AI 重组剩余计划；
- 打开原对话、项目关卡或专注附件。

### 复习任务队列

复习仍使用 `/review` 和 `ReviewSchedule`。学习任务只做 `review_handoff`，不复制复习状态，不自行计算掌握，也不把“任务完成”当作“复习完成”。

## 8. Agent 与权限

| 责任 | 允许 | 禁止 |
|---|---|---|
| Tutor | 识别任务、提出建议、管理队列、组装 Skill、控制 handoff | 未经同意接受建议；直接判定掌握 |
| Learning Design | 生成和调整候选计划、讲义、题目规格、视觉产物 | 直接完成阶段；决定评分或五核写入 |
| Practice | 执行确定性判题、纠错呈现、验证产物 | 选择任务优先级；直接写 KernelState |
| Learning Task Runtime | 持久化状态、计划版本、关联和零目标事件 | 充当证据权威或长期画像 |

Learning Task 生命周期事件全部是零 Kernel target。任务中的正式作答仍走：

```text
LearningAttempt -> EvidenceEvent -> reducer -> KernelMutation -> Memory Graph
```

五核对“任务”和“对话行为”分开处理，但共用一条事件入口：

| 行为 | 事件/对象 | 五核语义 |
|---|---|---|
| 创建、接受、开始、暂停、重规划、物化、完成任务 | `learning_task_*` | 全部零 target，只更新运行基础设施 |
| 在对话中表达目标、困难或偏好 | `user_message`，可附 `learning_task_id` | reducer 只按文本证据更新相应的 value/knowledge/human 等核；任务 ID 只做 scope 链接 |
| 生成讲义或题目 | `learning_card_generated` / 内容对象 | 零 target，生成内容不是学生证据 |
| 查看讲义/学习卡 | `micro_learning_card_viewed` | knowledge 的低强度接触证据，不代表掌握 |
| 费曼复述或诊断练习 | `teach_back_analyzed` + Attempt | knowledge/practice 的诊断证据，固定不升级稳定掌握 |
| 正式练习与验证 | graded Attempt + `*_attempt_evaluated` | knowledge/practice，区分错误、辅助、独立成功与变式 |
| 跨时复习提交 | `review_attempt_evaluated` | knowledge/practice 的保持与稳定性证据 |

这样五核保存“学生做了什么且证据说明什么”，LearningTask 保存“闭环进行到哪里”，Session
保存“对话如何继续”，三者不会互相冒充。

对话产生的知识缺口仍会进入 learner 级五核，供画像、总结和后续检索使用；但跨任务复用前
必须有 scope/provenance 证明它与当前任务相关。当前 v2 在尚无字段级 provenance 投影时采取
保守边界：任务内容从当前 source_refs 和本任务 EvidenceEvent 重建，不直接消费易变全局字段。

## 9. API

主要接口：

- `GET /api/learning-tasks/summary`
- `GET /api/learning-tasks`
- `POST /api/learning-tasks`
- `PATCH /api/learning-tasks/{id}`
- `POST /api/learning-tasks/reorder`
- `POST /api/learning-tasks/{id}/actions`
- `POST /api/learning-tasks/{id}/replan`
- `POST /api/learning-tasks/{id}/materialize`
- `POST /api/micro-learning/runs/{id}/regenerate`

所有写入必须校验 learner/session/project/checkpoint ownership，并使用版本或幂等 ID。

## 10. 兼容与迁移

`v15-learning-task-runtime` 是增量迁移：

- 新增 `learning_tasks` 与 `learning_task_plan_revisions`。
- 为现有 Checkpoint 回填唯一 Learning Task 和 checkpoint Session。
- 把现有 MicroLearningRun 关联到对应任务。
- 把微学习产生的单关卡 Project 标记为 `task_artifact/internal`，不再出现在真实项目列表。
- 保留旧 `/learn/:runId`、项目关卡、Attempt、ReviewSchedule 和所有证据 ID。
- 旧后台 `tasks` 表和 `/api/tasks/{id}` 保持原语义，不做重命名。

`v16-atomic-learning-skill-runtime` 在此基础上增加 SkillRun 到 LearningTask 的可空引用：

- 四种运行型 Skill 启动时即创建或复用同 Session、同目标的原子任务；
- Skill 暂停、恢复和完成教学阶段会同步任务的运行投影，但全部保持零 Kernel target；
- 开始验证时在同一任务上物化 MicroLearningRun，不再产生第二个任务身份；
- 旧 SkillRun 若已经关联 MicroLearningRun，会按 learner ownership 回填现有任务引用。

`learning-task-runtime-v2` 不新增数据库列，是对已有 JSON 状态和读取投影的向后兼容升级：

- 任务持久保存已有 Lecture/Exercise/ConceptQuestion 引用，并新增 answer-free `runtime` 回包；
- 对话响应持续返回当前 Session 的非终态任务，不再只返回一次性推荐卡；
- `practice` 和 `verify` 不再允许手工伪完成，旧客户端收到 `practice_required` 或
  `verification_required` 后应打开相应学习现场；
- 生命周期事件 ID、计划 schema、旧 `/learn/:runId` 和全部学习证据保持不变；无需数据迁移。
- `runtime.learning_flow` 向后兼容地提供专注附件的 `state / active_state` 和 answer-free 题目
  计数，供学习包准确显示当前环节；它是只读投影，不新增事件、不改变阶段推进或掌握规则。

## 11. 实际对话验收

本次 v2 升级在真实浏览器、真实本地 API 和当前配置模型下重复执行了四组对话，不只依赖单元测试：

| 对话目标 | 实际经过 | 验收结果 |
|---|---|---|
| Python 闭包 | 显式请求 → 任务卡 → 生成讲义/3 道题 → 查看卡片 → 费曼复述 → 独立答题 → 一次答错 → 确定性纠错 → 原题重做 → 变式验证 → 复习调度 | 完整闭环完成；任务进入历史，复习项可见 |
| 事件循环微任务/宏任务 | 显式请求 → 建立任务 → 从任务页暂停、恢复 | 队列状态可恢复，不依赖原聊天回合 |
| C 指针解引用 | 显式请求 → 生成并保存 `.lflecture` / `.lfexercise` → 进入专注学习 → 从专注页暂停 → 返回任务 | 文件引用持久存在；MicroLearningRun 与 LearningTask 暂停双向同步 |
| SQL LEFT/INNER JOIN | 在闭包、指针任务之后建立新任务 → 检查任务计划 | 约 1 秒出现任务卡；计划只引用 SQL 当前目标，未混入旧任务知识缺口或优先级 |

闭包对话还暴露过一道依赖 Python 私有运行时细节的低质量变式题。v2 已在生成提示和服务端
题目校验两层拒绝私有属性、解释器版本特例、未定义或非标准行为；被拒绝题由稳定的概念题补位。

重复验收时至少检查：显式任务不等待模型规划、生成文件不改变掌握、错误进入纠错、带提示
成功不算独立验证、完成后出现复习项、跨任务计划不携带上一任务易变五核内容。

## 12. 外部架构参考

本设计吸收了以下架构原则，但保持 LearnFlow 自己的教学证据边界：

- [OpenClaw Agent Loop](https://docs.openclaw.ai/concepts/agent-loop)：Session 内运行串行化、生命周期事件和持久化。
- [OpenClaw Queue](https://docs.openclaw.ai/concepts/queue)：按 Session 隔离并允许跨 Session 并行。
- [OpenClaw Background Tasks](https://docs.openclaw.ai/automation/tasks)：明确区分 Session、后台运行记录和更高层流程。
- [OpenAI Agents SDK Sessions](https://openai.github.io/openai-agents-python/sessions/)：Session 是连续对话上下文，不应替代应用领域状态。
- [OpenAI Agents SDK Handoffs](https://openai.github.io/openai-agents-python/handoffs/)：专业能力通过受约束 handoff 或工具被协调。
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)：短期线程状态与跨线程长期数据分离。
- [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)：暂停、恢复和副作用幂等是长流程的基础能力。
