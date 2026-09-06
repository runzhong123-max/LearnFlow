# 五核可检查记忆图谱

Contract impact（`2026-09-05.3`）：即时教学指导与长期记忆合成解耦。新增原始教学输入事件，确定性归约至五核短期 `teaching_directives` 与明确持续 Human `teaching_preferences`；一次明确请求即可生效，保留来源、范围、到期与取消。控制投影不重复送入 Module/Claim，长期能力门槛保持独立。Tutor 每次生成前自动获得有界指导，规划复用同一投影。无数据库迁移；完整合同见 `docs/IMMEDIATE_TEACHING_GUIDANCE.md`。

Contract impact（`2026-09-05.2`）：五核升级修复语义来源、目标/偏好更新、撤回与长期候选窗口。新增 `semantic_observation_proposed` 事件，仅保留有原事件引用的短期候选；Module policy v2按独立事件与类型化能力证据门更新。检索先作用域过滤，关联路径统一答案/人因/有效状态边界，SUPERSEDES作为已解决更新。Tutor保留时间与范围并支持真实重检索；学习任务消费有scope的证据，重做失败不代表明确拒绝讲法，无变式不显示可迁移。画像面向当前重点/基础/进展/支持方式。无需数据库结构迁移，旧事件保留；真实学习收益仍待试点。实施与兼容边界见 `docs/MEMORY_UPGRADE_IMPLEMENTATION.md`。

## 五核的结构语义

五核是学习者状态的五个互补维度，不是五个 Agent，也不是五份可以互相覆盖的画像。它们分别承载不同对象和决策：`structure` 负责学习路径中的位置、依赖和返回；`knowledge` 负责概念理解、缺口、错误与掌握证据；`human` 负责当前负荷、注意、情绪反应和交互适配；`value` 负责目标、优先级、动机和相关性；`practice` 负责尝试、辅助、产物、反馈和迁移表现。

记忆图谱中的事实必须保留所属核、主题和证据等级。跨核关系用于表达“同一事件关联”或“一个事实支持另一个事实”，不表示核之间可以互相写入或互相替代。比如一次实践答错首先是 `practice` 事实；只有答案或理由足以定位概念问题时，才可以另外形成 `knowledge` 事实；它不会自动形成 `human` 或 `value` 事实。

短期状态用于当前教学决策，长期模块和声明只在对应核的证据门槛满足后形成。尤其是 `human` 的情绪/负荷默认短期有效，`knowledge` 的掌握需要评分证据，`practice` 的独立能力优先需要无辅助和变式证据。同一概念下至少两条由学习者明确提交、经结构化复核的自述可以形成“接触范围” Module/Claim，但验证状态必须保持 `self_reported`，不得出现掌握、独立完成或迁移结论。合成器可以明确写“缺乏掌握证据”或“不代表掌握”作为边界；这种否定句不得被掌握关键词检查误拒绝。

会话内 Human 适配只接受学习者的明确表达。`vnext_human_adaptation_requested` 把当前节奏、表征、负荷、挫败或支持请求写成 8 小时有效的短期状态；`transient_expires_at` 与 provenance 辅助字段不生成事实，其他临时 Human Fact 固定 `consumption_status=excluded`，不会进入 Module/Claim。ContextPacket 进一步丢弃 Human 原文与深层节点，只输出诸如“放慢节奏，每次推进一个步骤”的类型化指令。普通“不懂”“不会”、答错和停顿仍只按 Knowledge/Practice 证据处理。

## 分核内容模型

五个核共用可追溯的数据骨架，但不共用同一种内容模板。注册表为每个核声明
`fact_role / module_role / claim_role / claim_mode / shared_subjects / hard_boundaries`，合成器和
读取器都以该策略为准：

| Kernel | Fact 记录什么 | Module 怎样组织 | Claim 怎样表达 |
|---|---|---|---|
| `structure` | 当前位置、依赖、转向、阻塞、返回锚点、个人路径变更 | 按项目、路径节点或目标维护稀疏导航片段 | 可恢复的当前位置与下一跳，不出现掌握判断 |
| `knowledge` | 概念答案、误解、缺口、检索表现与证据等级 | 按稳定 concept key 聚合相互支持或冲突的理解证据 | 带评分依据的理解/误解声明；自报只标记接触 |
| `human` | 明确偏好、当前负荷、节奏、挫败与讲法反馈 | 按适配主题形成短小、敏感信息优先的交互指令 | “如何支持”而不是人格标签；易变状态默认不长期化 |
| `value` | 目标候选、兴趣、优先级、原话依据与确认决定 | 按方向或目标主题保存候选、确认和撤回链 | 只有明确确认的长期目标可成为 active Claim |
| `practice` | 尝试、辅助等级、测试、rubric、产物与迁移表现 | 按任务/项目产物和能力维度组织证据链 | 明确约束下的独立表现；必须能回到验证或迁移证据 |

Structure 与 Knowledge 可以共享 `concept_key / path_node_id / checkpoint_id` 作为主题坐标，但不能
共享结论：前者回答“现在在哪里”，后者回答“理解证据是什么”。Practice 可以引用同一 concept，
却只表达“在什么约束下做出来”。Human 和 Value 默认不从答题结果旁推；敏感 Human 信息只在能
改善交互时进入有界 ContextPacket。

### 个人概念学习图

Knowledge 与 Structure 共同维护一个可从事件账本重建的个人概念学习图，但不建立第六个核或第二套
掌握权威。`ConceptAnchor` 只是共享身份坐标：`concept_key`、名称、别名、来源和可选的官方课程节点
引用。两核都可以使用 `concept:<concept_key>` 作为 `MemoryNode.subject_key`，但各自只生成本核事实：

```text
ConceptAnchor(backpropagation)
├─ KnowledgeProjection：首次接触、定义理解、例子/反例、题目、错误、纠正、回忆、变式与迁移
└─ StructureProjection：硬/软前置、阻碍、推动、联想、类比、易混淆、共生、应用、返回锚点与迁移边
```

知识历程由 `learner_concept_observation_recorded` 或既有评分/学习事件形成；题目通过
`question_ref` 挂在概念下，但一道题的熟悉不能替代概念理解。概念关系由
`learner_concept_relation_recorded` 形成，关系事实不得替任一端生成掌握结论。原始自述先以零 target
的 `learner_concept_statement_recorded` 保留全文，再拆成可纠正的 Knowledge/Structure 子事件。
这些事件固定带 `source_tag`、`verification=unverified` 和 `mastery_inference=false`；后续评分、复习和
实践事件只能追加验证或冲突证据，不能改写原文。

官方课程学习路径图和个人概念学习图保持分离：前者描述一般培养路径，后者描述该学习者实际怎样
理解、联想、受阻和迁移。规划工具可以用 `official_node_id` 叠加两张图，但不能合并二者权威。

worker 对候选 Claim 执行确定性内容边界检查。它会拒绝 Structure 的掌握声明、Human 的人格/医学/
固定学习风格标签、没有学生明确确认的 Value 长期目标，以及没有验证产物或独立迁移证据的
Practice 能力声明。Module/Claim 可以因纠正形成 `SUPERSEDES` 版本，也可以被学习者归档或撤回；
这些操作改变当前 active 投影，但不会删除原始 Event、Fact 或历史版本。

## 原子事件与产品接入

Chat、学习任务、学习路径和规划态只通过 allow-list 事件网关接入：

- `chat_mode_entered`：记录模式边界，零 Kernel target。
- `learning_action_segment_completed`：记录一次自由/讲解/带领学习/规划段落；讲解只形成 exposure，明确 learn/plan 目标可形成短期 Value，均不升级掌握。
- `vnext_planning_profile_self_reported`：把规划对话中明确给出的学段、接触/缺口、每周投入、方向候选和实践经历拆成五核短期事实；固定为 `self_reported`，不把整段原文当任务，不形成 Knowledge 掌握或 Practice 独立表现，Human 的当前投入/负荷限同 scope 使用且 8 小时过期。
- LearningTask 生命周期事件：创建、开始、暂停、恢复、取消、重开、流程完成；零 Kernel target，任务完成不等于掌握。
- `vnext_learning_path_node_status_set`：更新 Structure 的路径状态；“学过/掌握”只在 Knowledge 留 self-reported exposure，`mastery_unchanged=true`。
- `vnext_personal_path_node_added/removed`：更新 Structure 个人覆盖层，并在 Value 留短期候选或 tombstone，不产生长期目标。
- `learner_concept_statement_recorded`：保留学习者原文，零 Kernel target。
- `learner_concept_observation_recorded`：只写 Knowledge 概念历程，自述保持待验证且不推断掌握。
- `learner_concept_relation_recorded`：只写 Structure 概念关系，不替 Knowledge 下结论。
- 讲义/练习/来源的生成、打开、附着纸张和普通阅读：零 Kernel target。纸张父子图是浏览器工作空间，
  不是个人概念图、Memory Graph 或第六个 Kernel；来源文本即使被阅读也只构成带 provenance 的上下文。
- 正式练习文件中的提交：先建立 learner-owned `LearningAttempt` 并确定性判题，再由已登记事件写入
  Knowledge / Practice。未提交草稿、显示答案、打开题目和模型生成题目均不进入掌握证据。
- 已接受的 Value proposal：学生查看依据并确认后，由正式 capability 追加确认事件；拒绝、未确认和纯模型建议不能写长期 Value。
- 记忆归档/恢复、Claim 确认/纠正/撤回：全部追加新事件或新版本，保留原始历史。

vNext 通过 `/api/learner-state/snapshot` 获取五核、任务队列和路径覆盖层，通过
`/api/learner-state/context` 为 Tutor 获取 answer-free ContextPacket。所有写请求由后端从当前会话
解析 learner 身份，客户端不能指定其他 learner。

## 数据分层

1. `EvidenceEvent` 是不可变动作账本，`occurred_at` 表示动作发生时间，`created_at` 表示系统记录时间，`learner_seq` 是学习者内单调序号。
2. `MemoryFact` 是由一次 `KernelMutation` 展开的原子事实。唯一键 `(source_mutation_id, fact_ordinal)` 保证重放幂等。
3. `MemoryModule` 只合成同一学习者、同一核、同一主题的事实。模块内容不可变；后续新事实以 delta 与当前版本的证据闭包生成下一版本。
4. `MemoryClaim` 是模块内可单独检查的声明。非历史导入声明必须由 `SUPPORTS` 边直接回到事实。
5. `MemoryEdge` 只保存高价值稀疏关系。跨核关系可以存在，但 `CONSOLIDATED_INTO` 两端必须同核。

## Module 版本链

`memory-module-version-v1` 将 Module 定义为带时间范围的不可变认知快照，而不是持续
原地修改的摘要：

```text
F1 + F2 + F3 -> Module V1 -> Claim V1
Module V1 evidence + F4 + F5 -> Module V2 -> Claim V2
Module V2 --REFINES--> Module V1
KernelHead -> 当前 active 的 V2
```

- `evidence_fact_ids`：当前版本实际分析的证据闭包，包含继承证据与新证据，最多 64 条。
- `delta_fact_ids`：相对父版本新增的事实。
- `parent_module_node_id`：直接父版本；版本号在同一 learner/kernel/subject 内递增。
- `revision_kind`：`initial`、`refinement`、`confirmation` 或 `correction`。
- 普通证据更新形成 `REFINES`；学习者纠正形成 `SUPERSEDES`。
- 父版本和父 Claim 保留为 `refined`/`superseded` 历史节点；读取投影只采用一个 active 版本。
- 继承事实仍保留首次消费归属，并通过 `SUPPORTS`、`CONSOLIDATED_INTO` 图边支持新版本。

初始 Module 继续执行五核各自的确定性门槛。已有 Module 后，一个 verified、corrected
或 self-reported 增量可以触发新版本；普通 Knowledge/Practice/Structure 增量至少覆盖
两个独立事件，Human/Value 普通增量还需跨两个 session。合成任务使用
`memory-synthesis-v2`，并在运行记录中保存 base module、目标版本、delta 与完整证据集合。

`KernelState` 继续作为兼容投影。其短期区会附加 `memory_graph_recent_facts`，长期区会附加 `memory_graph_claims`。

五核 v2 另有 `KernelHead` 作为低延迟热投影。每个学习者、每个核只有一行，且固定限制
为 focus 3、alert 5、working 8、stable 5。头部只保存摘要、facet 与 MemoryNode ID；
超出窗口的事实仍完整保留在图谱中。`KernelHead.source_kernel_version` 使读取方可以发现
陈旧头部并确定性重建。

`MemoryNode` 统一补充 `memory_kind`、`subject_type/subject_id`、project/checkpoint/session
scope、`salience` 与 `schema_version`。Fact、Module、Claim 的原有表和证据关系不变，
因此旧 API 与历史审计保持兼容。

Agent 使用记忆时必须经过 `ContextPolicy -> FiveKernelRetriever -> ContextPacket`，不能
直接转储完整 `KernelState`。检索先做精确 scope 和 subject，再做本地混合排序，最后只
展开一跳高价值边。复习策略只深读 Knowledge/Practice；关卡 Tutor 深读本关五核；
Global Tutor 只把项目记忆当作 portfolio reference。ContextPacket 默认最多 12 个项目、
6 条关系路径，并声明证据 ID、预算、冲突和省略原因。

## 复习如何维护长短期记忆

复习台不直接读取或修改一份独立的“错题画像”。它从原始题目、`LearningAttempt`、`RemediationCase` 和有作用域的五核投影构造当前题目状态，再由确定性调度器决定何时重现题目。

- 本轮答错或明确“不会”：Knowledge 短期 `retention_status` 标记检索缺口，Practice 短期 `review_history` 保留尝试；进入纠错和立即到期，但不凭一次失败形成固定误解。
- 辅助答对：记录 `retrieved_with_support` 与辅助等级，只形成过程证据。
- 独立答对：记录一次检索成功；原题成功不是迁移证明。
- 已校验变式独立答对：记录题目形式和迁移证据，但单次仍不等于长期稳定。
- 至少两次相隔 72 小时的独立成功，且包含已校验变式：Knowledge 长期区可形成 `spaced_stable` mastery，Practice 长期区形成 `spaced_independent_transfer` proof chain。
- 稳定后再次答错：短期状态回到 `needs_review`，调度阶梯重置并保留 lapse；既有事实、模块和声明不删除，以新事实表达风险并支持后续纠正。

`ReviewSchedule` 保存到期时间、阶梯、成功数、遗忘数和并发版本，但它是可从 Attempt 与纠错事件回填的运行投影。暂停、恢复、延期和跳过不会升级掌握，也不会生成 `MemoryFact`，因为对应事件的 kernel targets 为空。

## 写入与合成

事件写入请求不调用 LLM。归约器写入 `KernelMutation` 后同步生成事实和确定性边，并按五核规则创建 `MemorySynthesisRun`。

worker 的状态顺序为：

```text
queued -> running/reserved -> completed/consumed
                           -> failed/eligible
```

合成器只能引用运行记录中的版本证据集合。越界引用、跨核候选和证据不足的知识掌握声明会整批拒绝。进程中断时，启动恢复会释放 delta reservation 并把运行重新排队。

worker 启动时还会扫描 `eligible` Fact 的 `(learner, kernel, subject)` 分组，重新执行本核
确定性门槛并补齐历史遗漏队列。该过程可重复执行，合成指纹保证不会重复生成同一版本。
在线模型调用失败时自动回退到确定性合成器，仍经过相同的事实白名单和声明校验。

旧库通过带备份的 `v12-memory-module-versioning` 迁移回填版本号、父版本、证据闭包和
历史状态。回填不修改 EvidenceEvent、KernelMutation 或 Fact 的事实内容。

自动合成默认开启：

```env
MEMORY_AUTO_SYNTHESIS_ENABLED=true
```

只有需要专门检查未消费队列时才临时关闭。未配置 LLM key 或模型供应商不可用时，worker
使用确定性合成器；Module/Claim 的形成不依赖网络，且不会改变 reducer 的证据判断。

## API

- `GET /api/learner-state/snapshot`：读取当前学习者的五核、记忆、路径覆盖层和正式任务队列。
- `GET /api/learner-state/context`：按问题和用途读取有预算、answer-free 的 ContextPacket。
- `GET /api/learner-state/concept-graph`：读取共享锚点、Knowledge 历程和 Structure 关系的个人图投影。
- `POST /api/learner-state/concept-graph/statements`：显式提交原文和可选结构化条目，经注册事件写入。
- `POST /api/learner-state/events`：写入 allow-list 的原子产品事件。
- `POST /api/learner-state/path/*`：写入路径状态和个人节点事件。
- `POST /api/learner-state/value-claims/*/confirm`：由学习者明确确认长期 Value 候选。
- `GET /api/memory/graph`：按时间、核、节点类型、状态、项目和主题过滤，最多 300 节点。
- `GET /api/memory/timeline`：按发生时间分页读取节点。
- `GET /api/memory/nodes/{id}`：读取节点、邻居、原始动作、证据事实和合成审计。
- `GET /api/memory/consolidations`：读取持久化合成运行。
- `POST /api/memory/claims/{id}/feedback`：追加确认、纠正或撤回事件。

所有查询和反馈都使用当前登录学习者的 `learner_id`，不会接受客户端传入的学习者身份。

## 迁移与评测

v5 启动迁移会先创建 SQLite 一致性备份，然后回填双时间字段、mutation facts 和 `legacy_import` 模块。历史值无法精确定位事实时保持 `legacy/unverified`。

运行结构评测：

```bash
cd backend
./venv/bin/python scripts/evaluate_memory_graph.py
```

脚本对照字段覆盖、单体摘要和五核事实图，并检查声明证据覆盖、同核同主题的版本证据复用、单一 active 版本、父版本完整性、模块不可变、纠错历史、幂等键、序号唯一性及 300 节点查询 p95。
