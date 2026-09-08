教育消融正式运行只读审计（四分片已完成）

审计来源为 `/Users/a1-6/LearnFlow/evals/joint_memory/runs/2026-09-08-formal-01/education-00` 至 `education-03` 的完整 JSON 行及 raw 压缩记录。本轮未修改生产、数据、driver、verifier、评分或运行文件，也未重跑实验。角色图谱应用现有修改完整保留。四个manifest现均为completed，各396个形成记录；后文总体分母已在运行关闭后核对。完整raw压缩记录均已读至EOF。

**临时 10 分钟：识别成功，历史期限和会话语义不受支持。**

- Case `clp-ae089b2ffe6d83fbab9c`，family `algorithms_bfs_reachability`，pattern `temporary_constraint_active`。
- `education-00/formation.jsonl` 第 7 行。真实 event 4 的原文确实是“这段时间我只有10分钟，请拆成小步；这一临时安排只到2026-03-23T11:00:00+00:00有效。”，并非期限只存在于隐藏标注。
- event 4 实际时间为 2026-03-22 09:00 UTC，session 3。Human `teaching_directives` 已形成 `minutes=10`、`source_event_id=4`，但原生 `expires_at=2026-03-22T17:00:00+00:00`、`lifetime=session`、scope session 3。
- 当前 event 5 为 2026-03-23 09:00 UTC，session 5。full/budget1800 包 `snapshot_id=33461760d7640d9780fc`、guidance=[]；计划为45分钟。对应 trials 第75行，raw解压后第157行。
- 生产原因：`packages/learning-core/src/learnflow_core/teaching_guidance.py:213` 解析分钟；`:114` 默认会话生命周期；`:124` 保留原scope；`:136` 固定8小时期限；`:322` 排除scope不一致、`:326` 排除过期。这里两项都不满足，源码先scope后expiry，不能声称仅其中一项单独导致结果。`api/learner_state.py:522–533` 的真实教学输入入口只保留text，不接受另一个可直接注入的有效期字段。
- 正确归类是“自然语言中的显式ISO期限与跨会话临时约束没有进入现有控制契约”，不是“没有识别10分钟”，也不是检索器单独漏召回。冻结评分不变。

对照 case `clp-43c9bc00add99e4234a5`，pattern `current_input_override`：当前 event 5 本轮说出10分钟，形成截至当天17:00、session 5的有效条目，full包携带该来源，计划为10分钟。no_memory 也保留相同本轮原生控制。这证明当前控制公平边界确实生效，但不等于历史时间语义已经支持。

**当前10分钟全量只有19/72成功：canary相同不等于理解正确。**

最终每个variant/budget的current_input_override只有19/72计划为10分钟，其余53/72为45分钟。前文BFS是成功样例，不能外推所有当前输入成功。

- 追加句固定为“但这一次只有10分钟……”。`teaching_guidance.py:213` 前导只接受“今天|现在|这次|我”，未覆盖“这一次”。19个成功原文恰好前文以“……先问我。”结尾，正则的任意字符窗口跨句从“我”匹配到“只有10分钟”。51个不触发全句guard的失败原文没有这个近邻“我”，分钟模式不匹配。该分类来自对冻结生产正则和原始输入的只读分析，不是更改输入重测。
- 具体失败：`education-00/formation.jsonl:43`，case `clp-a754996deacf296defc6`，family `algorithms_linear_probing_tombstones`。当前event5原文明确“但这一次只有10分钟”，Human short_term={}；raw解压第1063行，full1800 snapshot `c384c13b779c6dd5b66a`、guidance=[]、plan45。
- 另2个case在`:164`全句guard就被拒：`education-03/formation.jsonl:263`，`clp-8e030216f4f62ac2e12f / programming_unicode_boundaries` 的技术说明含“不是字素簇”；`education-00/formation.jsonl:175`，`clp-1de62ce5c2953d1a80a4 / frontend_event_loop_order` 的技术说明含“封闭调度假设”。guard先行，且两例分钟模式本来也未匹配，不能把guard说成它们唯一的独立反事实原因。
- 六组current-controls canary全通过说明控制保持相同，包括相同的空控制；它不验证自然语言请求被正确提取。

历史guidance全量确实没有进入读取包：3168个full包（1584case×2预算）仅38个包有guidance，恰好是上述19个成功当前输入×2预算，全部为当前event的human/time_budget；来自历史event的guidance条目为0、其他slot条目也为0。因此full与no_guidance相同，说明本次映射没有激活历史指导通道，不能推导“guidance无用”。

**历史原文缺口：先区分没有投影、没有Fact、已有Fact正文是否仍保留原话。**

- `goal_superseded`，case `clp-a435aa2e3300c813ae29`：formation第10行，原目标event1和新优先目标event4均存在；raw形成记录第226行两事件的mutations=[]、facts=[]，Value short_term={}。不是新目标已经被持久化后又被检索丢弃。
- `long_history_return`，case `clp-718bf764ea2588a1815f`：formation第12行，raw形成记录第276行。“我先去补队列，之后请带我回到：dependency_view.py::fewest_hops，起点入队之后。”的event4与稍后返回请求event69都没有mutation/Fact。该case真实模拟了65次UI接触事件，实际形成195条接触Fact；共201 Fact。大量节点确实存在，但返回锚点从未进入Fact，所以不能把失败写成“201条历史中最初锚点被挤掉”。
- `gap_unresolved`，case `clp-e25259c8cdf3e464ea85`：formation第5行、raw第101行。event6的错误推理原文存在，但没有mutation/Fact。
- `unjustified_correct_result`，case `clp-0c13b8f6a8786f181d76`：formation第22行、raw第526行。event5“我是这样猜的……还不能解释”没有mutation/Fact；真实评分条目仍只有`verified_once`、`mastery_inference=false`，没有稳定升级。题名交付成功不能证明系统保留了“猜对但解释不清”的教学含义。
- 源码：`learning_runtime.py:294–308` 对该输入仅运行确定性teaching-guidance归约后返回；`teaching_guidance.py:235–241` 的返回/优先规则只覆盖窄语法。上述原句不匹配时不会凭语义常识补写投影。
- 同时，时间控制的“没有Fact”有设计原因：`memory_graph.py:51–56`、`:198–206` 明确排除teaching_directives/preferences，防止旧控制被长记忆反复复述。它可以有合法KernelMutation而没有Fact。因此formation_delivery_gap是观测分类，不能一律解释为产品bug。
- raw_statement衡量完整原话交付；assessment_topic仅衡量来源+题名交付，强度不同。formed_source_fact分母只排除“未形成Fact”，不保证Fact正文保存原话；不能改称纯检索召回率或教学准确率。

**辅助与安全边界。**

独立子审计核对的典型真实实体如下；全量安全计数见末段：

- BFS `repeated_original`，case `clp-bffbec225444891af742`，formation第3行：Attempt 1 / Event 3为请求none、实际none；Attempt 2 / Event 4为请求none、实际guided / retry / independent=false。Fact 10 → Mutation 6 → Event 4，均属knowledge，Fact grade=observed。assistance_adapter_fidelity=false说明合成观察与产品记录不完全等价；assistance_not_promoted=true表示没有把有帮助成功升级为独立成功。
- BFS `assisted_success`，case `clp-e7c700979390f7ad1206`：Attempt 1 / Event 3均guided；状态correct_with_support、mastery_inference=false。
- BFS `unknown_assistance_success`，case `clp-403b4ce327118cfa61e8`：没有创建评分Attempt，明确adapter gap；oracle_response_grade和assistance_adapter_fidelity为null，不计为成功。
- 对应源码 `packages/learning-core/src/learnflow_core/api/phase3.py:55–80` 校验辅助枚举，并在概念题已有作答/已暴露解释时使用guided、retry。`:627–662` 由真实判题同时创建Attempt结果与事件correct/independent/assistance字段。`learning_runtime.py:1638–1640` 区分verified_once、correct_with_support、correct_assistance_unknown。这些不是评分脚本自行指定的状态。

四分片结束后已逐条只读核对全部raw形成实体，未重新运行产品、修改或重算评分。

开放作答改闭集选项、原会话不能注入概念评分事件、未知辅助被拒、没有真实运行的环境错误/团队产物、原始attempt来源撤回缺少入口等，均须保持adapter_gap，不得把合成outcome直接写成评分证据。语义教学质量、稳定学习效果和教师审核仍未评分/未完成。


**最终完整性与安全数量。**

- 四分片各396个唯一case、4752个唯一trial；合计1584 case、19008 trial，无重复键。所有manifest的changed_sources=[]、blocked_network_attempts=0，runtime_failures=0，errors.jsonl均为空。
- 真实调用共1584次setup控制选择检索、15840次条件检索、19008次离线规划；no_memory条件确实不调用历史检索。读取了39600条raw记录，其中1584条形成快照。
- raw包含12441个事件、1794个评分Attempt/对应concept_attempt_evaluated、30789条Fact。逐条核验Fact→Mutation→Event的kernel和来源，0不一致；Attempt.correct/item_id/assistance对对应Event，0不一致；结构化status/level的stable/spaced_stable或stable=true，0处。1794个概念评分事件的session_id均为None，原始历史会话不能被完整表达，已逐条记录适配缺口。
- 按case计，no_stable_mastery和fact_chain均1584/1584；oracle_response_grade、attempt_event_link与assistance_not_promoted均1311通过、273 N/A。assistance_adapter_fidelity为1242通过、69失败、273 N/A；69个失败来自可评分原题重做被原生降为guided。不是错误升级。
- 实际评分事件为guided且正确138个、none且正确1449个、none且错误207个。闭集选项的正确性不能外推原代码执行/自由回答评分或真实掌握。
- 时间检查：temporary_constraint_active每组/预算0/72通过，均45分钟；current_input_override每组/预算19/72通过（10分钟）、53/72失败（45分钟）。两类合看是19/144，但不能合成教学总分。
- 除交付探针外，trial布尔失败只有actual_plan_minutes，共1500条（72历史临时+53当前失败case，乘12条件）。其余预算、摘录来源、scope、验证阶段、未提前完成、当前控制一致性检查未见失败。这些只证明所定义的边界，不代表所有教育语义正确。
- 形成交付gap共1152个参考事件，全部raw_statement。它们没有Fact；每组每预算完整原话交付0/1152。formed_source_fact分母1794全部来自assessment_topic，不能以它排除形成失败后再宣称系统实现全文教学记忆。

下面仅为来源+题名交付计数（attributed_evidence_delivered_assessment_topic），不是教学质量：

| 条件 | 1800预算 | 3200预算 |
| --- | ---: | ---: |
| full | 1649/1794 | 1794/1794 |
| facts_only | 1645/1794 | 1794/1794 |
| recent_facts | 1538/1794 | 1656/1794 |
| no_relations | 1649/1794 | 1794/1794 |
| no_guidance | 1649/1794 | 1794/1794 |
| no_memory | 0/1794 | 0/1794 |

recent_facts在3200预算的138个缺交付中，69来自long_history_return（0/69）；另69来自gap_followup_success（138/207）。这可说明最近24Fact截断丢失部分早期评分题名来源；不能说它丢失了从未形成Fact的返回锚点原话。

已登记适配缺口出现次数：历史assessment session不保真1794；support_feedback仅原文入口144；显式valid_until不支持144；缺答/跳过/不会缺少正式review呈现207；task_paused仅原文入口72；原Attempt来源撤回入口缺失72；unknown assistance被拒69；未实际执行的环境结果72；未实际提交的团队产物72；reasoned_draft无可执行评分oracle90。计数单位是观察/缺口，不是互斥case。
