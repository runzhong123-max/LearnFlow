# 严格原文探针全零：来源链诊断

本文件是对 Formal03 已保存 raw/formation 的事后只读诊断，不是新实验，不更改任何代码、算法、预算、标签、计分或分母。

## 全体口径与结论

逐 case 读取 source/3200 已保存的 raw_statement probe，每个目标事件只计一次，共 864 个案例中的 1152 个探针；18 个配置×预算组的正式 0/1152 保持不变。1152/1152 原始 Event.payload.text 与完整 probe term 逐字相同，长度 13–81 字符；1152 个目标源事件绑定的 MemoryFact 和 MemoryNode 均为零。430 个目标事件只产生教学控制 mutation，722 个未产生 mutation。

因此，端到端严格原文交付失败是真实记录，但本矩阵中全部目标未进入可读取 Fact 集合，这个指标不能区分新旧原文 reader 的能力。不能据此把全零归因于 220 字截断、查询窗口、装包裁剪或 source reader 拒绝了已经存在的目标原文。也不能把 430 个明确的控制分流都称为解析失败；对 722 个无 mutation 事件，准确表述是本次教学控制输入路径没有生成所需语义事实，不据此声称整个系统没有其他合法记录能力。

## 权威链与计分契约

- driver 将学习者原话和部分支持/暂停观察统一提交为 vnext_teaching_input_received；gold references 的完整原话成为 terms[0]。见 education.py:208–212、234–242、297–306。
- reducer 对此事件只执行教学控制归约，然后立即 return。见 learning_runtime.py:294–308。
- teaching_directives / teaching_preferences 明确列为 NON_MEMORY_PATCH_KEYS，_fact_pairs 跳过它们；这是避免旧指令反复注入、绕过期限/替代规则的设计。见 memory_graph.py:51–56、198–209。
- resolver 接收 MemoryNode，以原生 Fact 查 Event/Mutation 和指定 object_value 路径；不接受任意 Event 原文。目标没有 Node/Fact，因此 target source_kind 和 fallback_reason 都是不适用，而不是虚构一个 no_native_fact 回退。见 memory_source.py:92–158、212–219。
- verifier 先要求真实 Fact 的源事件等于 probe 的 source_event_id，再要求一个有效原文片段包含完整 term；并不从教学控制或任意 Event 正文计分。目标 Fact 为空时，在来源关联筛选处已无候选。见 education_verifier.py:282–320、361–378。

## 按预定顺序抽取的三个案例

抽样规则：按 case_id 排序，先取首个 raw probe 失败案例，再取两个不同 pattern 的首个案例；均检查 legacy/source 两配置、1800/3200 两预算，共12个条件。

### clp-000a55bcd66febf59cf1（long_history_return）

来源分片：`education-02/raw.jsonl.gz`。

- 目标 Event 4，原话 56 字符，完整保存在 Event 的 [0,56)；Fact.object_value 不存在，目标 Fact/Node 均为0。mutation IDs=[6]；机制 `control_only_excluded_from_fact_projection`；控制来源 span：[12, 56]。
- 目标 Event 69，原话 43 字符，完整保存在 Event 的 [0,43)；Fact.object_value 不存在，目标 Fact/Node 均为0。mutation IDs=[]；机制 `no_mutation_from_control_only_input_route`；控制来源 span：无控制 span。

source/3200 的实际 items[0] 是 Node 4、Fact 绑定 Event 3（不是上述目标事件），object_value 类型为 dict。其 source_kind=node_text，source_path=/text，fallback_reason=unsupported_source_shape，ranges=[[0, 243]]，source_chars=243；legacy 对同一节点保存原 /text 片段，未声明新版 kind/path。此 fallback 是另一个评估 Fact 的字典值不在允许扩源形态内，不能用来解释不存在的目标 Fact。

四个条件的目标 Fact 路径均为空，原保存 raw probe 的 delivered=False、valid_expectation=True。source/3200 预算估计 3119，legacy/3200 3059；不是预算违规。
### clp-008550112f95230b41f3（gap_unresolved）

来源分片：`education-01/raw.jsonl.gz`。

- 目标 Event 6，原话 41 字符，完整保存在 Event 的 [0,41)；Fact.object_value 不存在，目标 Fact/Node 均为0。mutation IDs=[]；机制 `no_mutation_from_control_only_input_route`；控制来源 span：无控制 span。

source/3200 的实际 items[0] 是 Node 4、Fact 绑定 Event 3（不是上述目标事件），object_value 类型为 dict。其 source_kind=node_text，source_path=/text，fallback_reason=unsupported_source_shape，ranges=[[0, 243]]，source_chars=243；legacy 对同一节点保存原 /text 片段，未声明新版 kind/path。此 fallback 是另一个评估 Fact 的字典值不在允许扩源形态内，不能用来解释不存在的目标 Fact。

四个条件的目标 Fact 路径均为空，原保存 raw probe 的 delivered=False、valid_expectation=True。source/3200 预算估计 3125，legacy/3200 3064；不是预算违规。
### clp-00eb7c59481d7a20f18e（goal_superseded）

来源分片：`education-00/raw.jsonl.gz`。

- 目标 Event 1，原话 19 字符，完整保存在 Event 的 [0,19)；Fact.object_value 不存在，目标 Fact/Node 均为0。mutation IDs=[1]；机制 `control_only_excluded_from_fact_projection`；控制来源 span：[0, 19]。
- 目标 Event 4，原话 25 字符，完整保存在 Event 的 [0,25)；Fact.object_value 不存在，目标 Fact/Node 均为0。mutation IDs=[6]；机制 `control_only_excluded_from_fact_projection`；控制来源 span：[0, 10], [11, 25]。

source/3200 的实际 items[0] 是 Node 4、Fact 绑定 Event 3（不是上述目标事件），object_value 类型为 dict。其 source_kind=node_text，source_path=/text，fallback_reason=unsupported_source_shape，ranges=[[0, 243]]，source_chars=243；legacy 对同一节点保存原 /text 片段，未声明新版 kind/path。此 fallback 是另一个评估 Fact 的字典值不在允许扩源形态内，不能用来解释不存在的目标 Fact。

四个条件的目标 Fact 路径均为空，原保存 raw probe 的 delivered=False、valid_expectation=True。source/3200 预算估计 3189，legacy/3200 3035；不是预算违规。

## 独立复核与解释边界

用保存的 formation sidecar 重建 _source_nodes/_source_events/_source_mutations/_source_facts，调用独立 verifier 的来源选择、范围/hash 与事件关联核验；12 个条件中可见片段的独立 excerpt/association 错误为0。已保存的预算、scope、来源及原文范围检查没有失败；无可见对象时的 NA 仍按0对象报告，不能写作“测过且通过”。
本次所核四类门槛计数：{'passed': 45, 'not_applicable_zero_objects': 3}。

当前结论：这是输入适配/受控分流与严格 Fact 交付口径之间的断点诊断；不能报告为新 reader 的负向因果效果。现有全零不改，不事后删除控制类分母。后续应另行预注册：保留端到端原话任务，同时增加经合法已登记语义事件形成、object_value 原文已存在的 reader 对照，并分别验证历史控制回顾与当前控制应用。不能直接把 LLM 推断或任意 Event.payload.text 写成 Fact。

## 可复核制品

- 案例逐字段证据：/tmp/learnflow-memory-v4-raw-probe-case-diagnostic.json
- 1152 条总体逐探针分类：/tmp/learnflow-memory-v4-raw-probe-population-diagnostic.json
- raw 与诊断文件 SHA-256、冻结源码 hash：/tmp/learnflow-memory-v4-raw-probe-diagnostic-manifest.json
- 注意：formation 的 facts[].id 保存的是 MemoryNode.id，facts[].event_id 对应原生 MemoryFact.source_event_id；不能把 Node ID 与 Event ID 混比。见 education.py:353–356。
