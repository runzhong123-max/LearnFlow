# 冷启动 Agent 编排与候选图谱设计 v0.5

状态：`workflow v4.3 已实现；任务屏障后立即返回岗位内核，知识 Lane 覆盖全部任务并核对知识／技能两类支撑`\
目标：把模糊岗位输入和可选工作区转化为可发布的 Static Role Package\
运行时方向：LangGraph 阶段图 + Durable Runner + 领域事件日志
关联研究：`cold-start-graph-algorithms.md`、`work-process-event-graph-research.md`

v4.3 的上下文预算、逐任务补齐、质量事件与兼容性见 [知识技能覆盖修复](knowledge-learning-repair.md)。以下 v4.2 编排为基础设计记录；后台持久化与恢复的现状以 [JOB_RECOVERY.md](JOB_RECOVERY.md) 为准。

## 0. v4.2 的用户关键路径

```text
岗位边界假设
  → 检索规划、来源资格与一次性分片
  → 来源内 Claim / Mention / Relation Proposition / Work Event 原子抽取
  → 任务全局归并
  → TASK BARRIER
  → 岗位内核：5—8 个代表任务 + 岗位/产业上下文 + 完整证据层
  → 提交不可变 kernel 快照并立即进入岗位图谱工作台
  → 后台并行：
       A. 跨任务归纳能力
       B. 按任务补全细粒度知识技能 + 全局技能依赖
       C. 按代表任务展开事理场景、事件、分支、交付物与返工
  → 提交 semantic_enrichment 子版本
  → 提交 full_enrichment 子版本并执行非阻断结构检查
```

岗位内核不是“版本化基线”或另一种岗位包。它是同一 Static Role Package 协议下的第一个不可变静态快照版本；后续两个版本只是增加信息。来源资产、分段、Mention 与关系命题在内核中完整保存，默认雷达只降低可见信息熵，不删除事实。

### 0.1 多分辨率投影

- 默认雷达只展示 `defaultVisibility = true` 的内核节点；搜索、卡片总览和 Agent 精确读取仍能访问细节节点；
- 被折叠的任务带 `parentKernelId` 与 `facets`，因此“减少第一眼节点数”不是丢任务；
- 每个代表任务先拥有证据绑定的 `ProcessCapsule`，后台事理完成后再把胶囊链接到正式 Scenario；
- 知识技能节点携带可稳定寻址的 expansion handle，为以后按节点深研、软硬前置和共生图谱预留接口。
- 后台知识层只提升最多 5 个技能簇代表和最多 3 个能力入口；同技术近义细项通过 `parentKernelId/facets` 折叠，不从事实层删除。

### 0.2 角色归属纪律

每条任务或工作事件 Mention 都要求显式给出 `actor` 与 `actorRelation`：`target_role | target_team | external_user | adjacent_role | unknown`。任务 Barrier 只允许岗位本人或明确属于目标团队的行动成为典型任务；客户、产品用户、学生和相邻岗位的行动继续保留在来源 Mention 与事理参与者中，但不能冒充目标岗位任务。该约束由 prompt 与确定性规范化双层执行。

### 0.3 当前后台语义

- 浏览器离开冷启动页后，工作台自动发起增量运行；
- Cloudflare 请求上下文用 `waitUntil` 托管运行，断开事件流不会取消版本构建；
- 同一增量 run ID 会去重，刷新页面只重新接入项目版本进度；
- 当前仍不是完整 Durable Runner：worker isolate 非正常终止后的 step checkpoint、跨机恢复与可人工重试要由 Cloudflare Workflows 或等价运行器补齐。

## 1. 架构边界

系统分为四个相互隔离的平面：

```text
交互平面       项目/对话/运行 UI、NDJSON 或 SSE 事件
领域平面       Project、BuildRun、Candidate Graph、Version、Tag
执行平面       Durable Runner、LangGraph 阶段图、工具与并发控制
发布平面       Package Compiler、Validator、Static Role Package Registry
```

### 1.1 唯一事实源

- 构建中：项目数据库中的候选图谱、来源、决策和构建事件是工作事实源；
- 发布后：Static Role Package 的 `snapshot.yaml` 是岗位语义事实源；
- `graph.json`、`object-index.jsonl`、`retrieval.jsonl` 始终是可重建投影；
- LangGraph State 是一次执行的运行状态，不是长期业务事实源；
- 前端本地状态只是 materialized view，不得成为恢复依据。

### 1.2 为什么不直接在 snapshot.yaml 中生长

生成期间会发生重命名、聚类合并、越界移除、证据补充和多次修订。把这些中间状态写入静态包会导致：

- 候选内容冒充发布事实；
- 图谱动画与最终文件强耦合；
- 失败恢复困难；
- 无法准确记录合并和拒绝历史；
- 已发布包可能被原地改写。

因此必须先写候选沙箱，再由 Package Compiler 生成不可变版本。

## 2. 运行时选择

冷启动需要动态 fan-out、阶段性 fan-in、循环修订、暂停恢复和持久化。LangGraph 适合表达阶段内的控制流和 `Send` 并行分发，但不独占产品的持久化模型。

建议定义 `DurableBuildRunner` 接口：

```text
start(runId)
resume(runId, input)
pause(runId)
cancel(runId)
retry(runId, fromStep)
inspect(runId)
```

实现策略：

- 本地开发：持久化项目库 + 可重放事件；LangGraph 使用开发 checkpointer；
- Cloudflare 部署：Cloudflare Workflows 承担长任务、step retry 和等待外部事件；D1 保存领域记录，R2 保存原始资料和制品；
- Node/Postgres 部署：LangGraph `PostgresSaver` 承担 checkpoint，领域记录仍单独保存；
- 所有实现输出同一 Build Event Protocol，前端不感知执行后端。

官方资料指出 LangGraph checkpoint 按 super-step 保存状态，并支持 pending writes 恢复；Cloudflare Workflows 适合长时间后台步骤、重试和等待事件。设计不假设 D1 是 LangGraph 原生 checkpointer。

参考：

- https://docs.langchain.com/oss/javascript/langgraph/checkpointers
- https://docs.langchain.com/oss/javascript/langgraph/workflows-agents
- https://developers.cloudflare.com/agents/concepts/workflows/

## 3. 领域数据模型

### 3.1 Project

```text
id
title
slug
owner_id
status                 draft | active | archived
primary_role_id?       发布前可空
created_at
updated_at
current_version_id?
default_session_id?
```

### 3.2 ProjectBrief

保存用户输入与 Agent 的当前理解：

```text
id
project_id
revision
raw_intent
audiences[]
purpose[]
scope
role_target_hypothesis
workspace_refs[]
source_policy
assumptions[]
unknowns[]
status                 hypothesis | usable | superseded
created_by             user | agent
created_at
```

### 3.3 Workspace

```text
id
project_id
kind                   local_folder | upload_set | linked_workspace
label
access_scope
privacy_classification
scan_status
manifest_hash
created_at
```

工作区只保存授权范围和文件 manifest；文件内容进入 Source Asset / Blob Store，不把任意本地路径写入发布包。

### 3.4 BuildRun

```text
id
project_id
base_version_id?
brief_revision
kind                   cold_start | rebuild | repair | deepen
status                 queued | running | waiting_user | paused |
                       cancelling | cancelled | failed | ready | completed
phase
runner_backend
thread_id
idempotency_key
started_at?
completed_at?
last_event_seq
failure_code?
```

`thread_id` 使用稳定 UUID，不把长项目名拼入 ID。

### 3.5 BuildWorkItem

表示可以独立执行、重试和统计的工作单元：

```text
id
run_id
phase
lane
parent_id?
input_refs[]
status
attempt
priority
estimated_input_tokens
max_output_tokens
cache_key
cache_hit?
started_at?
completed_at?
output_refs[]
error?
```

`status` 除 queued/running/completed/failed 外允许 `recovered`：父工作项失败后，其输入被局部二分，所有子工作项成功时，父项记为已恢复。它不再计入未解决失败，但原始失败事件仍保留用于诊断。

### 3.6 SourceAsset 与 SourceSegment

```text
SourceAsset:
  id, project_id, origin, source_type, title, locator
  visibility, capture_status, claim_use, temporal_status
  content_hash, blob_ref, captured_at, as_of

SourceSegment:
  id, source_id, locator, text_hash, blob_offset
  semantic_kind, temporal_scope, extraction_status
```

`origin` 至少区分：

- `public_web`
- `official_standard`
- `job_market`
- `private_workspace`
- `user_upload`
- `agent_derived`

### 3.7 ConceptMention

并行抽取器首先写入来源绑定的“提及”，而不是直接创造规范节点：

```text
id
run_id
dimension_hint
surface_form
normalized_form
definition_hint
attributes
source_segment_id
text_span?
extractor
confidence
created_by_work_item
```

同一概念在十份 JD 中出现十次，应保留十条 `ConceptMention`，但最终只物化为一个规范节点。提及是证据定位与重跑的输入，默认不显示在岗位雷达。

### 3.8 RelationProposition

抽取器在局部上下文中同时记录尚未规范化的关系命题：

```text
id
run_id
subject_mention_id
predicate_hint
object_mention_id
qualifiers
source_segment_id
evidence_span?
assertion_mode              explicit | inferred
confidence
materialization_status      pending | materialized | rejected
```

它解决“先聚类再抽关系会丢失原文上下文”的问题。命题端点必须先重写到 canonical candidate，才允许形成工作图谱关系。

### 3.9 CandidateObject

```text
id                        稳定候选 ID
run_id
project_id
dimension                 role | boundary | task | capability |
                          capability_unit | knowledge_skill
entity_type               目标岗位包实体类型
canonical_label
aliases[]
summary
payload
lifecycle                 emerging | candidate | stable | rejected
cluster_id?
merged_into_id?
distinction_notes[]
source_refs[]
binding_drafts[]
confidence
revision
created_by_work_item
created_at
updated_at
```

这里的 `emerging/candidate/stable/rejected` 是工作图谱生命周期。`stable` 只表示本次构建内已经完成全局归并，不等于岗位包中的 `accepted`，也不表示永真。Package Compiler 会根据证据、认识状态和发布策略，把稳定候选分别映射为岗位包的 `accepted` 或 `candidate`。

### 3.10 CandidateRelation

```text
id
run_id
type
source_candidate_id
target_candidate_id
attributes
lifecycle
source_refs[]
proposition_refs[]
confidence
revision
```

`CandidateRelation` 是关系命题规范化、聚合与校验后的物化边，不是单个抽取器的自由生成结果。关系在节点合并后通过 alias map 重定向，不能留下指向被合并节点的悬挂边；多条来源命题可以支持同一条边，一对实体也可以存在不同类型的合规边。

### 3.11 SemanticDecision

记录机器聚类、审计或人工输入造成的语义变化：

```text
id
run_id
kind                      merge | split | rename | retype | reject |
                          accept | boundary_change
subject_ids[]
result_ids[]
reason
evidence_refs[]
decided_by                deterministic | model | user
created_at
```

### 3.12 ProjectVersion 与 Tag

见 `versioning-and-publication.md`。

## 4. BuildRun 状态机

```text
draft
  ↓ create run
queued
  ↓ runner accepted
running:clarify
  ↓ brief usable
running:plan
  ↓ plan accepted by policy（默认自动，不要求人工审批）
running:research
  ↓ minimum source coverage
running:boundary
  ↓ target hypothesis usable
running:tasks
  ↓ task barrier passed
running:capabilities_and_skills
  ↓ semantic layers produced
running:converge
  ↓ global clustering passed
running:audit
  ├─ repairable → running:repair → running:audit
  ├─ ambiguous  → waiting_user → running:boundary|converge|audit
  └─ pass       → ready
ready
  ↓ compile
completed
```

任意运行态可以进入：

- `paused`：用户主动暂停；
- `cancelling → cancelled`：协作式取消；
- `failed`：不可自动恢复的系统或数据错误。

### 4.1 Waiting User

进入 `waiting_user` 必须同时满足：

- 问题会显著改变研究对象或发布合法性；
- 当前来源和工具无法自行解决；
- 已记录 Agent 尝试过的解决路径；
- Interrupt payload 是可序列化的；
- Interrupt 前的副作用已经幂等或放在独立步骤中。

用户回复后必须使用同一个 run/thread 恢复，不新建运行。

## 5. 冷启动 DAG（workflow v3）

```text
岗位边界假设
  ↓
检索规划 + 来源资格判定
  ↓
按单一来源、token 有界的小分片抽取（仅当前工作证据进入任务关键路径）
ConceptMention + RelationProposition + 工作事件提及 + EvidenceSpan
  ↓
任务候选聚类、规范化与分层归并
  ↓
TASK BARRIER：稳定任务 ID + 可交互快速任务骨架
  ↓
┌───────────────────┬──────────────────┬──────────────────┐
│ 按任务派生知识技能 │ 跨任务归纳能力/单元 │ 按任务展开事理场景 │
│ 可触发定点联网补研 │ 只读压缩任务骨架     │ 事件/对象/产物/分支 │
└───────────────────┴──────────────────┴──────────────────┘
  ↓
关系命题端点重写到稳定 ID，编译 SemanticClaim 与两类图谱关系
  ↓
结构、证据、重复、时效、任务—技能—事理跨产物一致性检查
  ↓
针对缺口补研；缓存命中不重算，只重跑受影响分片或任务子组
  ↓
编译完整组合岗位包 → 形成新的不可变静态岗位快照版本
```

`ConceptMention` 是来源中的一次出现，`RelationProposition` 是来源局部关系；二者都不是正式图谱事实。只有端点解析到稳定节点并完成证据绑定后，编译器才生成 `SemanticClaim`。工作事件提及进入事理分支，但必须桥接回稳定任务，避免语义图和事理森林各说各话。

### 5.1 为什么任务是 Barrier

任务定义岗位实际承担和交付什么。能力必须从多个任务的共同表现要求归纳，知识技能也必须说明服务哪个任务。如果在任务集合尚不稳定时同时自由生成能力和知识技能，会产生：

- 每个任务一套近义能力；
- 工具名冒充能力；
- 无使用场景的知识点；
- 任务、能力和流程步骤互相污染。

因此可以并行抽取任务提及和局部关系命题，但必须先经过任务规范化与聚类归并，再 fan-out 后续分支。这里的 Barrier 约束“正式节点与边何时物化”，不阻止抽取器提前保存有证据的局部命题。

## 6. 并行策略

### 6.0 当前实现：任务屏障后的三路有界派生

当前执行协议不是让一个模型从全部资料一次生成整包，而是：

```text
来源内分片抽取（并发 3；正文目标约 1200、硬上限约 2200 估算 token）
        ↓
任务规范化与分层 reduce（输入按 token 和 mention 数双限界）
        ↓ TASK BARRIER + build.semantic.patch
┌────────────────────┬────────────────────┬────────────────────┐
│ KS：任务组有界       │ 能力：压缩全局任务骨架 │ 事理：最多 3 个任务/组 │
│ 并发 2、按需补研    │ 与另两路同时启动       │ 并发 2、桥接稳定任务   │
└────────────────────┴────────────────────┴────────────────────┘
        ↓
关系端点解析、双图编译、诊断式结构检查
```

关键语义：

- 来源分片从不混合两个来源，因此证据污染和失败范围都可定位；
- 技术、教学和未来信号仍完整进入证据层，但不进入任务原子抽取关键路径；
- 抽取与结构化编译默认关闭供应商深思考，复杂性由显式 DAG、schema 与确定性 reducer 承担；
- 任务屏障完成后立即发出可交互任务骨架，并以独立 run identity 提交不可变快速候选快照；它是真实版本，不是 loading 文案；
- 任务规范化携带来源资格和通用证据优先级：工作区观察、正式标准、真实实践和招聘市场依次约束任务骨架；低优先级资料只能补独立交付边界，不能把主题或趋势扩写成任务；
- 知识技能只处理与任务组相关的片段，并在缺少一手技术资料或技能覆盖不足时选择性触发定点联网搜索；补研资料直接进入知识 Lane，不再重复走任务原子抽取；
- 能力归纳只读取稳定任务的压缩表示和最多 24 条相关能力信号，避免把全文重新塞给模型；
- 事理分支每组不超过 3 个任务，只读取相关事件证据，输出必须桥接稳定任务 ID；观察模式必须给出连续原文片段，编译器再依据来源真实性确定认识状态；
- 来源分片或任务派生组失败时局部二分；单段来源无法二分时改用更小对象配额紧凑重试。成功恢复的父项标记 `recovered`，不清空其他产物；
- 任务 Barrier 后，知识技能、跨任务能力和事理森林使用 `Promise.all` 同时启动，各自保留独立并发上限和局部恢复；
- 事理编译按稳定 ID 合并并行分组产生的同名场景、事件、边、桥和证据绑定，不允许调度顺序制造重复对象；
- 同一 prompt 版本、模型配置与来源内容形成确定性 cache key，重跑只计算 cache miss；
- 检查结果用于发现、补研和局部修复，只有协议不变量才硬阻断，不以“质量门”把整包清空。

当前模式解决了单次 BuildRun 内的首个有用结果延迟、巨型 prompt、全有全无失败和无效重算。任务屏障形成的快速任务快照先提交为候选版本；完整展开完成后再以它为 parent 提交第二个不可变版本。完整展开失败或被取消时，已经提交的快速版本不回滚。浏览器关闭后的后台继续运行仍属于 Durable Runner 阶段。

### 6.0.1 三轮真实评估与版本演进

三轮均通过产品页面调用同一 MiMo 配置和 Tavily 联网通道；测试岗位、资料和关注点不同，没有岗位专用提示词或岗位专用阈值。总耗时来自浏览器端运行观察，取近似值。

| 轮次 | 岗位 / workflow | 快速任务快照 | 总耗时 | 估算输入 token | 未恢复工作项 | 任务 / 技能 / 场景 |
|---|---|---:|---:|---:|---:|---:|
| 1 | 后端开发工程师 / v3.0 | 382.7s | 约 633s | 141,853 | 20 | 14 / 19 / 13 |
| 2 | 站点可靠性工程师 / v3.1 | 127.2s | 约 277s | 53,713 | 6 | 10 / 10 / 10 |
| 3 | 大模型算法工程师 / v3.2 | 99.8s | 约 244s | 43,253 | 0 | 10 / 11 / 9 |

从第一轮到第三轮：快速快照等待下降约 74%，总耗时下降约 61%，估算输入下降约 70%，结构化输出失败从 20 个降为 0。有效变化来自通用协议：按证据角色路由、小分片紧凑输出、任务 Barrier、定点知识补研不重复抽取，以及来源优先级；不是对测试岗位写规则。

三轮也揭示了单看“成功率”看不到的问题：

- v3.0 把趋势和团队观点生成为当前任务，说明来源角色必须先于生成；
- v3.1 的单段 JSON 截断无法通过二分恢复，说明恢复策略必须覆盖不可再分的工作项；
- v3.2 虽然 0 失败，但派生 Lane 实际串行，且并行事理分组产生同名场景、模型可能滥引工作区片段；
- v3.3 因此加入真正三路并行、稳定 ID 去重、连续证据片段要求和基于证据绑定的认识状态编译。v3.3 完成 89 项静态回归；未将静态回归冒充第四轮真实性能数据。

### 6.0.2 当前版本事务与下一阶段 Durable Enrichment

当前同一轮已经拆成两个不可变版本事务：

1. `fast_snapshot` 在岗位边界、稳定任务骨架和初始证据索引可用后提交快速候选快照；
2. 前端立即切换到这个版本继续展示，节点引用固定到快速快照 ID；
3. `enrichment` 以该版本为 parent，继续知识技能深化、能力归纳、事理展开、关系链接和结构检查；
4. 完整结果作为第二个不可变版本提交，不原地修改快速快照；
5. 任一后续失败只影响 enrichment，已有快速快照仍可浏览、对话、Diff 和继续迭代。

下一阶段要把 enrichment 从当前 HTTP 流迁入 Durable Runner，并允许它按信息增量形成多批候选版本，而不是要求浏览器连接持续存活。

慢展开的调度优先级不按节点生成顺序，而按预期信息增量：用户正在查看或引用的节点最高，其次是核心任务的事理/知识缺口，再其次是高中心性节点，最后才是长尾覆盖。这样既保持快速体验，也避免后台做大量用户永远不会查看的工作。

### 6.1 并行单位

- 来源通道并行；
- 文件或页面分片并行；
- 不同行业/资历样本并行；
- 任务提及与局部关系命题抽取并行；
- 已稳定任务上的知识技能提及与关系命题抽取并行；
- 独立确定性审计并行。

### 6.2 不允许无界并行

每次运行维护：

```text
global_concurrency
provider_concurrency
network_concurrency
workspace_parse_concurrency
per_host_concurrency
token_budget
source_budget
deadline
```

Planner 只产生逻辑工作项；Scheduler 根据供应商限流、优先级和预算决定实际并发。不能把 100 个候选直接变成 100 个模型请求。

### 6.3 推荐调度顺序

1. 能快速缩小岗位边界的来源；
2. 职业标准和高价值公开来源；
3. 能形成第一批任务簇的样本；
4. 扩展市场覆盖的来源；
5. 深化低覆盖节点的定向研究。

第一批结果不等待所有低优先级来源完成。后续来源以 patch 方式补充工作图谱。

### 6.4 Fan-in 确定性

并行结果到达顺序不稳定，任何 reducer 不得依赖完成时间。每项输出携带：

- `work_item_id`
- `lane`
- `source_priority`
- `stable_sort_key`
- `content_hash`

归并前按稳定键排序；同一内容使用 idempotency key 去重。

### 6.5 工作项尺寸与调用经济性

工作项不能按“一个节点一次调用”切分，也不能按“整个维度一次调用”合并。调度器同时约束：

```text
source_isolation          不跨来源抽取
semantic_cohesion         同一调用内对象应围绕同一任务组
estimated_input_tokens    包含 schema、任务摘要、mention 与正文，不只计算原文
max_output_tokens         按产物上限反推，而不是给模型无限写作空间
item_count_limit          防止大量短对象把 JSON 撑爆
cache_reuse_probability   让稳定分片在后续补研中可直接复用
failure_blast_radius      单次失败最多影响 2—4 个任务
```

推荐不是一个固定 token 数，而是三段式策略：目标尺寸用于常规吞吐，硬上限用于拆分，失败后局部二分用于恢复。过细会重复系统提示、schema 和推理启动成本；过粗会导致截断、超时和整组丢失。当前数值是默认调度参数，必须通过跨岗位冻结集按首屏延迟、输入/输出 token、任务覆盖、证据跨度、重复率和局部失败恢复率共同校准，禁止为单一岗位单独调参。

## 7. 分维度队列、候选池与关系物化

### 7.1 维度先于节点

任何提及必须先被路由到一个语义维度，再进入对应队列。未知维度进入隔离区，不能直接显示在默认岗位雷达。

每个维度至少维护：

```text
raw_mention_queue
normalized_mention_queue
match_candidate_queue
unresolved_queue
canonical_entity_pool
relation_proposition_queue
materialized_relation_pool
```

队列是调度与背压机制，不等于每个维度必须串行执行；任务、能力和知识技能可以在各自 Barrier 允许后分片并行。

### 7.2 节点最低信息

所有候选节点至少具有：

- 规范名称；
- 一句话定义；
- 纳入理由；
- 不包含什么；
- 至少一个使用或关联场景；
- 来源或输入引用；
- 生命周期和认识状态。

特定维度增加判定字段：

| 维度 | 最低判定信息 |
|---|---|
| 任务 | 独立交付物、触发情境、完成标准 |
| 能力 | 情境、行为、标准、跨任务证据 |
| 能力单元 | 可观察表现、所属能力 |
| 知识技能 | 学习目标、实践/测评方式、服务任务 |
| 产业链 | 价值链位置，不得是岗位或技能 |
| 相邻岗位 | 共同点和结构化责任边界差异 |

### 7.3 四段式实体规范化

第一段，确定性规范化：

- Unicode、大小写和标点规范化；
- 术语别名映射；
- 类型和 domain/range 过滤；
- 精确 hash 和已有 alias 命中。

第二段，同维度候选阻塞与近邻召回：

- 只与同维度候选比较；
- 使用词法与向量混合召回 Top-K；
- 带上定义、交付物/行为/学习成果，不只比较标题。

第三段，语义裁决：

- `duplicate`：合并为一个规范节点；
- `contains`：保留更合理粒度，另一项转为别名或子信息；
- `adjacent`：都保留，并写 `distinction_note`；
- `different`：独立保留；
- `uncertain`：进入注意队列，由后续来源或全局 reducer 解决。

第四段，约束聚类：

- 高置信 `duplicate` 形成 must-link；明确 `different/adjacent` 形成 cannot-link；
- 使用带约束并查集或增量聚类产生稳定簇；
- 合并不得跨维度，且必须通过维度专属判定测试；
- 不确定提及宁可暂时分离，不因“标题相似”过早合并；
- 周期性全局 reducer 使用关系邻域、来源分布和区别说明修复局部碎片化或误合并。

### 7.4 局部聚类与全局归并

每个 Lane 内先局部聚类，以减少上下文和请求量；阶段结束后全局 reducer 跨 Lane 归并。只有全局 reducer 可以把候选提升为 `stable`。

### 7.5 合并规则

合并是 append-only decision，不物理删除历史：

1. 选定 canonical candidate；
2. 合并 alias、来源、证据绑定和区别备注；
3. 写 `SemanticDecision(kind=merge)`；
4. 被合并节点标记 `rejected` 和 `merged_into_id`；
5. 重定向关系；
6. 发送一个原子 `graph.patch`；
7. 发布时只编译 canonical candidate。

### 7.6 关系物化

节点归并后才执行：

1. 通过 mention-to-canonical map 重写命题端点；
2. 规范谓词并执行 domain/range、维度和认识状态检查；
3. 对相同端点、谓词和限定条件的命题聚合证据，不把多次出现误当作多条边；
4. 保留真实多对多结构，例如一个任务需要多个知识技能、一个知识技能服务多个任务；
5. 为冲突命题建立张力或审计项，不通过简单投票抹平；
6. 以单个原子 patch 创建、更新或重定向物化边。

禁止让“每任务知识技能生成器”直接把最终节点和边写入工作图谱。详细算法、复杂度和实验矩阵见 `cold-start-graph-algorithms.md`。

## 8. 边界收敛

岗位边界至少在三个节点被重新评估：

1. 意图解析后；
2. 多来源研究 fan-in 后；
3. 任务聚类完成后。

每次修订输出：

```text
previous_revision
new_revision
changed_inclusions
changed_exclusions
adjacent_roles
reason
input_refs
confidence_delta
```

如果任务簇明显分成两个核心岗位，系统优先：

1. 查相邻岗位和岗位群证据；
2. 将越界任务移动到相邻岗位差异；
3. 根据用户受众和用途选择更有解释价值的核心岗位；
4. 仍无法解决时才中断用户。

## 9. 证据与认识状态

候选图谱继承 Static Role Package 的证据纪律，但采用 draft binding：

- `observed`
- `normative`
- `synthesized`
- `inferred`

公开资料与私域工作区不能共享同一个 source identity。聚类合并只合并语义节点，不合并来源身份。

工作区观察可以：

- 支撑企业岗位实例；
- 发现隐含职责和真实交付物；
- 对公开岗位共性形成候选补充或张力；

但不能在没有跨来源支撑时自动升级为市场岗位共性。

## 10. 审计与修复

发布前并行执行：

### 10.1 确定性审计

- schema；
- ID 唯一性；
- 关系 domain/range；
- `has_unit`、`prerequisite_of` 无环；
- 悬挂边；
- 孤立核心节点；
- source/binding 引用完整性；
- payload hash；
- lifecycle 合法性。

### 10.2 语义审计

- 同维度重合；
- 维度污染；
- 任务是否可独立交付和验收；
- 能力是否是跨情境表现；
- 知识技能是否可学习、实践或测评；
- 粒度是否极端不一致；
- 相邻岗位区别是否有结构化说明；
- 节点简介是否完整且重点突出。

### 10.3 证据与时间审计

- 无来源重要节点；
- 仅 lead 来源支撑高置信断言；
- 私域实例被错误泛化；
- 来源晚于快照时点；
- 来源覆盖集中于单一行业或资历；
- 高价值 claim 缺少 segment 级证据。

### 10.4 有界修复

自动修复最多两轮。每轮必须减少明确的 issue 集，不能以“继续优化”为理由无限循环。

无法解决的问题进入：

- `known_gap`；
- `research_question`；
- `human_input_required`；
- 或阻止发布的 validation error。

## 11. 可靠性

### 11.1 幂等

所有可见副作用使用：

```text
idempotency_key = run_id + phase + work_item_id + operation + input_hash
```

写节点、关系、来源和事件使用 upsert 或唯一约束。中断前不执行不可幂等 append。

### 11.2 重试

| 错误 | 策略 |
|---|---|
| 网络、429、暂时 5xx | 指数退避，自动重试 |
| 单一来源解析失败 | 记录失败，其他分支继续 |
| 模型结构化输出失败 | 同输入修复一次，再降级为待审候选 |
| 用户可解决的范围问题 | `waiting_user` |
| schema/程序错误 | 运行失败，保留全部已完成产物 |

### 11.3 取消

取消是协作式的：

- Scheduler 停止派发新工作项；
- AbortSignal 传给正在运行的模型和网络工具；
- 已经完成的工作项与事件不删除；
- 运行进入 `cancelled`；
- 用户可以基于当前候选图谱新建运行，而不是恢复已取消运行。

### 11.4 恢复

恢复以持久化 BuildRun、WorkItem、候选图谱和事件为准。LangGraph checkpoint 用于减少重算，不承担领域数据恢复的唯一责任。

## 12. 可观察性与评测

每个 Lane、工具和阶段记录：

- 排队、开始、首结果和结束时间；
- 模型、prompt 版本和 token 使用；
- 来源数量和去重数量；
- 产生、合并、拒绝和稳定节点数量；
- 重试、错误和等待原因；
- 输入和输出 hash；
- 对最终版本的贡献引用。

首期离线指标：

- time to first hypothesis；
- time to first source；
- time to first graph patch；
- time to first task cluster；
- 同维度重复率；
- 维度污染率；
- 孤立节点率；
- 核心节点证据覆盖率；
- 自动修复收敛率；
- 运行恢复成功率；
- 人工提问率与提问有效率；
- 用户首次产生有效追问的时间。
