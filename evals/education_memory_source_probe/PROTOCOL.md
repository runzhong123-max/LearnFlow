# 原生 Fact 原文读取机制补充探针 v1（明确事后设计）

设计日期：2026-09-13。本补充是在观察 Formal03 教育轨之后提出：原主实验 1152 个 raw targets 来自未 Fact 化的控制投影，无法检验 native Fact 原文读取。因此另构造读机制的正、负控制。不是事前独立验证，不改变 Formal03 数据、代码、gold、评分、排名或其失败记录。

## 冻结设计

固定 8 个计算机教育主题：二分查找、LRU缓存、事务隔离、Dijkstra、TCP重传、容器端口、Python协程、训练验证划分；每主题 early / tail / split_qualifier 三模式，24例。每条460字符；early把完整观察和限定均放220字符前，tail把两者放310字符后，split把观察放前部、限定放330字符后。正文是作者编写的学习者自述，不是实际通过评测的掌握证据。合成位置探针并不代表自然语言分布。

每例先建立隔离内存数据库中的身份、项目、关卡、会话；知识状态只由正式 record_event(user_message) → reducer → KernelMutation → KernelState → MemoryFact 生成。每例目标自述、同scope无关自述、同learner异project强匹配自述、异learner强匹配自述各一个正式事件。目标Fact必须保留完整原文并可追溯。不手写Fact、Mutation、KernelState，不运行巩固，不调用模型。

只比较 legacy 与 source，字符估算预算1800/3200，共24×2×2=96条件。共同策略由checkpoint_tutor复制，head/deep kernel均为knowledge，max_items=4、max_paths=0、enable_episodes=false，其余现有读取开关一致；source唯一配置差异是enable_source_text=true。条件顺序固定随机种子20260913，所有条件读取同一形成快照并回滚读侧事务。固定读取时间2026-09-01T12:00:00。

本策略刻意聚焦原生字符串读取，不测试完整五核、教学策略、评估episode或规划质量。原生user_message reducer会产生pending_question与knowledge_gap，二者均视为同一事件来源候选，不当作独立样本。

## 候选与干预边界

每组实际候选ID集合必须与独立DB快照中同scope有效knowledge Fact集合一致，且少于240；逐次保存_product node metadata_的只读输入ID追踪，并核对两配置相同。候选计数与集合不是用最终返回items猜测。这样排除扩大SQL扫描使新增目标进入候选池这一混杂；source仍附带不同的来源元数据和诊断开销，这些保留在相同预算中，不能称绝对纯文本因果效应。

Reader只接收learner/project/checkpoint/session、主题问题、同一ContextPolicy（与source开关差别），从不接收target_term、qualifier、位置标签或评分结果。预标注只在只读独立verifier使用。

## 固定评分与安全检查

评分器只用标准库，不导入产品resolver、reducer、excerpt或tokenizer。独立检查数据库导出的Event→Mutation→Fact/Node链接、真实身份和scope、applied状态、before/after版本、KernelState事件引用和action_chain；目标Fact.object_value须与原事件.text和冻结输入全文相同。

每个实际item必须scope合法。source_kind=node_text的SHA、chars、ranges必须逐字重建真实MemoryNode.text；fact_object_value仅允许真实pending_question/knowledge_gap的/object_value，且source Event/Mutation ID与实际链一致。不得用当前宣称的hash选择任意原文。所有范围必须是实际非空且有序不重叠的Unicode字符区间；断续窗口以“ … ”连接。

固定主指标：在同一个来源正确、excerpt有效的目标Fact item中，同时完整包含target_term与qualifier的比例。另报term交付、qualifier交付、任何目标Fact交付。没召回、预算省略或任一条件缺失均为0，不能因source缺失改分母。目标形成失败、运行失败、来源/范围/scope错误或超预算全部保留，并使正式补充验收失败；不删除错误条件。预算按公开body JSON字符估算/3.2向上取整验证，不称真实LLM tokens。

每个预算/模式单独给出实测分子/分母，以及同case配对差。每个主题是三种位置的相关簇；本探针只作有限集合的描述性计数，不做显著性检验、泛化排名或bootstrap扩样。

## 制品与停止规则

先生成data/cases.jsonl，再prepare保存本协议、数据、驱动/verifier和实际宿主/共享实现全部Python文件hash；execute前后复核。新目录排除于Formal03冻结roots，不触碰既有冻结文件。执行关闭网络与模型key，数据库仅:memory:；所有条件原packet、source快照、候选ID、checks、metric、异常写入/tmp输出。仅安全的合成JSON/JSONL/Markdown/hash可汇入该新目录results；不得提交数据库、模型权重、虚拟环境或原始LoCoMo内容。

不以得分调整数据或评分；修正执行错误必须保存失败运行并另开目录，披露修订。报告明确“事后合成原生Fact读取机制探针”，不并入主排名，不声称未见任务验证、教师评价、学生学习收益或自然教学场景准确率。完整96条件未完成时如实报告实际矩阵。
