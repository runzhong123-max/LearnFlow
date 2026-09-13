# 五核能力与论文主张的源码证据矩阵

审计日期：2026-09-13。基准 HEAD：`917b8a04e88c4f2afa7f72b477a127c3ef2249b7`。本次为只读源码/已有产物审查，未修改仓库、未运行测试或新实验。工作树有其他任务的未提交改动，详细状态和被引用文件的当前/HEAD SHA256 见同名 JSON 收据。这里的“回归证据”表示已存在、已检查的测试断言；本审计不重新认证其通过状态。新原生能力契约实验由另一任务执行，不计入本文件已有结果。

## 可直接用于论文的核心表述

LearnFlow 的五核是同一学习者状态的五个语义维度，并非五个 Agent。它们分别回答“走到哪里”“理解到哪里”“当前怎样教”“为什么投入”“能否独立做出”。实现特点是将这些问题交给不同的确定性证据规则，并由共同来源链、作用域与读出机制连接到规划和教学。三个主 Agent 是 Tutor、学习设计、实践验证；核与 Agent 不是一一对应关系。[核契约](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/registry_core.py:358)、[Agent 契约](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/registry_core.py:310)。

论文可以主张“已实现面向教育证据的类型、资格、时效和消费约束”，不能仅凭代码或分组实验主张“五核划分不可替代”“比所有传统或先进记忆更强”。本研究的 flat 对照仍保留 kernel 标签，并有共同的来源与范围过滤；它不是不含教育语义的传统 RAG 系统。

## 共同机制：不是每条证据都必须合成为一段长期摘要

1. `record_event()` 验证 learner/project/checkpoint/session ownership，保存实际来源、事件时间和学习者顺序；提供 client_event_id 时支持学习者范围内重放幂等，随后进入 reducer。[写入口](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:110)，ownership 在 131–184，幂等在 186–196，落事件与归约在 200–221。
2. `_apply_patch()` 在同一事务中更新确定性 State、记录带 before/after version 和 short_term/long_term patch 的 Mutation，再生成事实、刷新读出 head。[实现](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:235)。`MemoryFact` 保留 source_event_id、source_mutation_id、predicate、object_value、evidence_grade 和 scope；图边保存 SAME_EVENT、SAME_SUBJECT、NEXT_IN_KERNEL 关系。[事实来源](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:372)、[边](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:387)。
3. **即时教学控制不等于长期知识事实。** `vnext_teaching_input_received` 可形成教学指令的 Mutation/State；`teaching_directives`、`teaching_preferences` 刻意排除 Fact 化，避免过期安排经摘要重新生效。长期 Module/Claim 是满足条件才产生的派生层；当轮时间或支持请求无需等待后台摘要。[即时分支](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:294)、[排除规则](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:51)、[Fact 展开](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:198)。因此“某控制事件没有 Fact”不能直接记为记忆丢失。
4. Module 的候选、触发、预留和版本基础位于共享 `memory_graph.py`；生成器、draft 验证和最终版本化提交仍在两个宿主的 `memory_worker.py`，**不能写成所有合成逻辑已经共享**。每个 claim 必须引用候选白名单中的 Fact，生成文本无权越过证据门槛；版本化 Module 标记 immutable。[验证](/Users/a1-6/LearnFlow/backend/app/services/memory_worker.py:202)、[Module 版本](/Users/a1-6/LearnFlow/backend/app/services/memory_worker.py:585)。
5. 更正/撤回使源 Fact 以及依赖它的活动 Module/Claim 失效，旧事件和文本保留；重建的是 `long_term.memory_graph_claims` 缓存，不是任意全事件到全部 State 的通用重放引擎。[失效传播](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:255)、[缓存重建](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:813)。

## 五核能力矩阵

| 核 | 原生输入 → 确定性状态 | Fact / Module / Claim 的实际角色 | 实际消费者与可做能力 | 当前限制 |
|---|---|---|---|---|
| **structure：学习位置、依赖与返回** | `checkpoint_entered` 读取所属项目/检查点及先修关系，形成 path_position、resume_anchor、path_dependencies；学习者确认或修改路线形成带 revision/evidence_id 的 long-term path；明确概念关系写 concept_relation，和知识掌握分离。[S1][S2] | 导航/边界/关系 patch 可形成有来源 Fact；结构模块按≥3个事件或≥2个事件且边界事件触发；可有稀疏锚点 Claim，但禁止掌握语句。[S3] | learner-state snapshot 的 learning_path 和 personal_concept_graph 展示路线/关系；当前 return_anchor 进入真实 planner 的未完成 learn 阶段，要求先核对暂停位置。[S4] | 这是学习者自己的路线、位置和关系记录，不能等同于课程知识库、文档 RAG 图或完整知识图谱推理。返回控制当前主要生成下一阶段准备语，不代表已自动跳转 UI、执行路径导航或求解最优课程路线。 |
| **knowledge：理解状态及其证据等级** | 自述概念观察、正式 concept attempt、讲义 exposure、teachback 诊断、review、transfer 和纠错分别处理。普通概念结果严格区分 verified_once / correct_with_support / correct_assistance_unknown / needs_review，不能写普通长期 mastery。[K1] | 事实记录概念状态、错误和来源级别；两次同概念自述最多触发 exposure-only 模块；正式验证可触发评估模块，Claim 受来源白名单/证据类型约束。[K2] | learner-state 概念图展示知识时间线、最新观察、证据级别和冲突； planner 消费同源 gap Fact，产生解释一个卡点并做小检查的准备；自述“解决”触发小检查而非宣告掌握。[K3] | 不是完整自动知识追踪模型；开放文本卡点解析是保守规则，不保证识别全部计算机误解。普通测评、spaced review、transfer 与 Claim 的 stable 语义门槛尚不完全统一，详见后文。 |
| **human：当前教学适配** | 显式 profile 偏好可长期保留；显式慢一点/换形式/需要支持形成带 scope、来源和默认8h期限的状态；用户拒绝讲法记录当前无效讲法。[H1] | 显式偏好可 Fact 化并触发偏好模块；瞬态敏感状态通常标 transient、excluded，避免普通长期摘要化；typed teaching control 本身刻意不 Fact 化。human Claim 禁止人格、医学、固定学习风格等越界标签。[H2] | planner 根据有效分钟控制截短本次安排；support 进入“小步推进”并 cap20分钟；新指导不重写已完成阶段。Tutor 接收当前指导，优先于历史偏好。[H3] | “偏好代码示例”不是“固定学习风格”；一次错误/不会不能推断情绪或人格。当前支持策略是有限、确定性的教学动作集合，代码存在不证明真实缓解负荷或提升成绩。 |
| **value：目标、优先级与确认状态** | `career_goal_confirmed`、显式 profile 更新、`vnext_value_claim_proposal_accepted` 区分目标候选/确认；确认路线同时写 confirmed_goals 并保留 evidence_quote；当前优先项可更新、取消或过期。[V1] | 可替换目标/priority Fact 会让旧同主题同key Fact及派生摘要失效；确认目标可触发模块；长期目标类 Claim 需确认来源。[V2] | learner-state 展示确认目标和路线；任务 planner 消费当轮 current_priority 改摘要前缀；长期路径可进入 learning_plan 上下文。[V3] | 不是只记“爱好”：它保存目标依据、承诺与短期投入顺序。但是当前优先项写入准备/摘要，不等于已经实现跨任务全局效用优化、自动课程重排或长期目标达成。 |
| **practice：做过什么、在何种帮助下做成** | 正式 concept/exercise Attempt、纠错重试、变式、复习与迁移记录进入证据链。概念题已看过答案/解释或重做原题时服务端强制 guided，不能靠客户端重新声明 none 变成独立表现。[P1] | Fact 保存结果和帮助级别；学习 episode 按同源事件/Attempt打包任务、条件与结果；独立 exercise 可形成独立成功 proof_chain，迁移有另一路证据门；能力 Claim 限已验证情境。[P2] | planner 对 assisted success 安排撤除提示后独立小变式；independent success 安排变式/理由检查；帮助未知先澄清；错误先定位，未完成先区分未答/不会/跳过。纠错端执行解释—原题重试—变式链。[P3] | 一次独立成功、原题重做和迁移不是同义。768实验辅助等级来自合成情境声明，非人类提示干预；闭合选择题也不是实际学生代码执行能力评估。 |

### 矩阵来源索引

- **S1**：[checkpoint 与先修位置](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:1197)；[已确认路线状态](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:425)。
- **S2**：[concept relation](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:916)；[正式路线提交 API](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/api/learner_state.py:683)。
- **S3**：[结构模块触发](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:494)；[结构 Claim 不得主张掌握](/Users/a1-6/LearnFlow/backend/app/services/memory_worker.py:243)。
- **S4**：[产品 snapshot 消费](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/api/learner_state.py:301)；[知识/结构图投影分工](/Users/a1-6/LearnFlow/backend/app/services/personal_concept_graph.py:451)；[恢复锚点准备语](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:266)。
- **K1**：[自述观察](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:895)；[exposure 与 teachback](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:1278)；[正式概念结果且不升级长期掌握](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:1626)；[复习的留存状态](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:1533)。
- **K2**：[证据分级](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:172)；[knowledge 模块触发](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:499)。
- **K3**：[真实 planner 取 scoped Fact 与 episode](/Users/a1-6/LearnFlow/backend/app/services/learning_tasks.py:259)；[卡点源绑定](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:113)；[卡点/自述解决的不同准备语](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:246)。
- **H1**：[显式适配](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:321)；[profile 更新](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:947)；[拒绝讲法](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:1390)。
- **H2**：[瞬态 Fact 与排除](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:365)；[偏好合成触发](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:528)；[越界词约束](/Users/a1-6/LearnFlow/backend/app/services/memory_worker.py:245)。
- **H3**：[分钟与支持控制](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:102)；[单步会话限制](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:210)；[保留已完成阶段](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:223)；[Tutor 接入](/Users/a1-6/LearnFlow/backend/app/services/tutor_service.py:2208)。
- **V1**：[学习者确认目标](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:399)；[路线目标联动](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:484)。
- **V2**：[可替换 Fact 失效传播](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:315)；[目标合成触发](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:538)；[Claim 需要确认](/Users/a1-6/LearnFlow/backend/app/services/memory_worker.py:249)。
- **V3**：[planner priority 编译](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:148)；[实际作用于 summary](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:306)；[长期路径进入 planning context 的测试](/Users/a1-6/LearnFlow/backend/tests/test_learner_state.py:344)。
- **P1**：[真实提交依据历史校准 assistance/role](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/api/phase3.py:55)；[正式概念提交](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/api/phase3.py:572)。
- **P2**：[独立 exercise 与 transfer proof chain](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:1707)；[practice 模块触发](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/memory_graph.py:549)；[能力 Claim 规范文字](/Users/a1-6/LearnFlow/backend/app/services/memory_worker.py:477)。
- **P3**：[动作映射](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:179)；[作用到待执行练习](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:269)；[真实纠错 API 链回归](/Users/a1-6/LearnFlow/backend/tests/test_remediation.py:98)。

## 实现、已有回归、768 次模型读出：证据不能混用

| 核/横切能力 | 本次确认的已有回归断言（本审计未重跑） | 上一轮 768 次真正覆盖 | 仍未被该模型实验覆盖 |
|---|---|---|---|
| structure | `test_learner_state.py:75` 自述路径不升级知识；249 关系与知识历史分离；306 非法边/循环；344 路线确认、幂等、归档及 planning context；`test_teaching_guidance_v2.py:144` return_anchor/替换/取消 | 每条轨迹有相同的 **已过期** return_anchor 背景；独立判定返回字段 | 无有效/过期锚点的结构核成对干预；无长程路线执行、先修规划和导航成功率实验 |
| knowledge | `test_memory_graph.py:193` 自述 exposure-only；`test_education_memory_policy.py:129` 正式概念证据等级；`test_review.py:456` 72h变式稳定门（用 registered event 注入做规则回归，非两次真实学生复习） | 自述/正式封闭选择测评、最新正确/错误顺序；一次结果不应认定稳定掌握 | 无开放概念诊断、延迟保持、知识追踪精度或掌握正例；未检验知识模块巩固质量 |
| human | `test_learner_state.py:479` 显式限时适配且无答案；612 普通不确定性不产生 human；`test_memory_graph.py:603` 禁固定学习风格；`test_teaching_guidance_v2.py:195` 原生入口期限/来源/scope；`test_education_planning_lifecycle.py:59` 新指导到未完成阶段 | 8/25分钟、support在-1h/-9h有效/过期的读出；support默认cap20 | 无真实负荷/挫败测量、个体教学偏好效用或换讲法真实收益 |
| value | `test_learner_state.py:94` 确认 value proposal 走reducer；397显式profile；`test_memory_graph.py:603` 未确认目标被拒；`test_episode_planning.py:109` 目标前缀替换 | 本轮优先事项两次更新顺序 | 无长期目标确认/撤销的模型对照；无长期投入、动机变化或跨任务目标优化 |
| practice | `test_remediation.py:98` 错题—换讲法—重试—变式链；`test_episode_planning.py:37,62` 帮助未知/重试/新旧事件；`test_education_memory_policy.py:221,245` 提示撤除与最新独立证据 | 合成声明guided/none、正式概念接口结果、最新结果读取和对应下一步 | 无正式迁移正例、真实编程产物、完整纠错episode干预、人类辅助因果效果 |
| 来源/纠正/巩固 | `test_memory_graph.py:41,418,545,650,754` 来源边、模块版本、白名单、跨核拒绝与纠正隔离；需要分别核对调用层 | 四组都过滤异项目/未来证据；共同输入与引用独立核验 | 未消融 ownership/filter；未在768中运行后台Module/Claim合成或更正传播 |

正式实验协议明确规定 96 条轨迹、48 对、8 个计算机主题簇，四表示 × 两预算 = 768 条响应。它不是 768 名学生或独立主题，也不是五次逐核移除消融。[协议样本](/Users/a1-6/LearnFlow/evals/education_memory_counterfactual/PROTOCOL.md:15)、[四组定义](/Users/a1-6/LearnFlow/evals/education_memory_counterfactual/PROTOCOL.md:11)。辅助等级为合成情境声明，原生题目为执行 Python/SQL oracle 得出答案的封闭选择题；概念API实际 session_id 为空，保存并披露此范围精度限制。[原生形成器](/Users/a1-6/LearnFlow/evals/education_memory_counterfactual/formation.py:133)、[限制记录](/Users/a1-6/LearnFlow/evals/education_memory_counterfactual/formation.py:177)。

已保存正式报告实际显示 768/768 条响应记录，不能写成 768 条有效模型回答全成功。完整输出正确如下（每格分母96，错误保留）：

| 预算代理单位 | five_kernel_gated | flat_gated | five_kernel_source | flat_source |
|---|---:|---:|---:|---:|
| 2200 | 86/96 | 88/96 | 66/96 | 11/96 |
| 8000 | 81/96 | 84/96 | 65/96 | 18/96 |

来源：[/tmp 正式 REPORT](/tmp/learnflow-memory-cf-formal-01/REPORT.md)、[完整 aggregate](/tmp/learnflow-memory-cf-formal-01/aggregate.json)。在 gated 条件下五核分组未优于平面分组，不能选择性只报 source 两列而宣布五核普遍更好。预算为 cl100k_base 的序列化消息代理；8000档规范记录全入包，2200档未全入包，但协议开发检查提示关键来源全保留，不能将其直接解释为成功恢复缺失关键证据。[预算与限定](/Users/a1-6/LearnFlow/evals/education_memory_counterfactual/PROTOCOL.md:25)。正式输入是否同样保留全部关键来源须采用独立输入审计，不由本只读矩阵额外承诺。

## 需要论文准确处理的三个工程边界

1. **掌握术语需要按路径描述，不能合写一个全局统一阈值。** 普通概念 reducer 不升级长期 mastery；review 要最新失败后的≥2次独立合格成功、跨度≥72h且含validated_variant；显式 transfer reducer 可由一次passed、无辅助、confidence≥0.9事件写 stable/high_confidence_transfer；宿主 stable_mastery Claim 验证目前仅要求≥2个verified event，并规范化文字为“至少两次独立验证记录，迁移另须变式”。这是现有类型命名和资格复用的一致性限制，本审计没有复现运行时错误或观察到错误学习者掌握结论。建议后续统一资格结果类型，让三个消费位置引用同一证据资格接口。[review gate](/Users/a1-6/LearnFlow/backend/app/services/review.py:199)、[transfer gate](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/learning_runtime.py:1729)、[Claim gate](/Users/a1-6/LearnFlow/backend/app/services/memory_worker.py:225)、[Claim 限定文案](/Users/a1-6/LearnFlow/backend/app/services/memory_worker.py:488)。
2. **当前控制的可执行程度不同。** 时间预算会真正限制当轮估计，小步/锚点/priority 主要改变受控阶段的准备语或摘要；原有验收条件和评分保留。后续若主张自动导航或目标重排，需要独立登记且验证实际工作台动作或排队效果，而非只看prompt含有关键词。[确定性执行边界](/Users/a1-6/LearnFlow/packages/learning-core/src/learnflow_core/planning_guidance.py:190)。
3. **知识质量和教育效果仍缺实证。** 现有规则证明（或以回归检查）证据资格、来源、时效与动作约定，不能证明误解诊断准确、保持更久或学习效率提高。未来无需人类的新工作可先采用原生API契约probe、真实可执行编程/SQL任务和留出主题跨模型读出；这些仍属于机制研究。外部先进记忆是否也提供时序、graph、reflection、profile、revision等能力应逐论文核对，不能把它们整体描述为只有无结构事实检索。

## 与既有记忆能力比较时，能够核查的差异轴

下表是论文比较维度，不是对所有既有系统的否定。若相关工作已经支持对应能力，应标“已有/部分具备”，再比较教育规则、来源链或实际消费者的覆盖，不把改名分核当新算法。

| 核 | 通用记忆中可有的相近能力 | 本系统可核查的教育约束 | 本轮 flat 基线是否仍有对应信息 |
|---|---|---|---|
| structure | 时序记录、关系图、任务位置或流程状态 | 学习者自己的路径/依赖/返回锚点与知识掌握分权；确认路线可修订 | 是。结构类型和过期锚点保留；未消融该核 |
| knowledge | 事实/反思/概念关系、历史矛盾处理 | 自述、接触、正式测评、辅助答对、独立答对与复习/迁移资格分开 | 是。正式结果和证据类型保留；gated另加资格注释 |
| human | 用户偏好、情境化个性化 | 明确当前教学请求的scope和期限；不把短期请求升级为固定风格或诊断 | 是。时间和support原始条件保留 |
| value | 用户目标、兴趣、任务优先级 | 候选目标与学习者确认目标区别、原话依据、当前优先项更新 | 是。priority来源与顺序保留 |
| practice | 情节/工具执行/任务成功失败记忆 | 学习者作答与Agent生成分开；辅助、原题重试、独立验证、变式迁移区别 | 是。Attempt结果和assistance保留 |

因此论文最稳妥的贡献是**教育领域的证据语义和可审计运行约束的系统整合**，并用对照实验揭示“显式资格注释”与“核分组呈现”的不同效果；目前结果不足以证明只需增加五个标签就获得普遍性能优势。

## 一个可说明产品作用的计算机教育例子（说明性情境，非新增结果）

学生上次停在递归终止条件（structure），自述仍不懂边界，并曾在提示下答对（knowledge + practice）；今天只有8分钟并要求小步（human），当前优先理解调用栈而非继续做整套算法题（value）。系统可以把这几条证据以各自来源、范围和期限读出，限制本次只推进一个小目标，核对暂停位置，针对当前卡点解释，再安排撤除提示后的独立小检查。它不会仅凭“上次答对”宣称已稳定掌握，也不会把“小步请求”变成固定学习风格。这里的五核价值在于区别证据角色并落实不同约束；该例本身不是实测学习增益。
