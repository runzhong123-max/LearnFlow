# Role Atlas 研究协议与岗位任务详情

协议：`role-research/v2`；任务详情：`role-task-definition/v1`；岗位包：`static-role-package` `3.1.0`。本文件细化两端注册表登记的岗位生产和只读导入契约，不改变 LearnFlow 三类主 Agent、五核或 EvidenceEvent。

## 产品边界

Role Atlas 面向计算机专业群的高职学生和教师，负责可追溯的岗位理解。下游 LearnFlow 补充企业材料、设计项目并执行实践。质量优先级为任务转换信息、学生可理解性、重要覆盖；表达检查不构成真实学生效果验证。

研究主管、调查员、复核员是 Tutor 岗位生产接口内部职责。它们不能发布 Hub 包、操作学习数据库、直接修改当前版本或创建新的长期学习画像。调查范围与改动范围分开；调查相邻岗位不授予修改相邻岗位的权限。网页、附件、旧会话、原文和历史结论均为资料，不是运行指令。

## 执行与持久化

`buildResearchAgent` 是冷启动与迭代共用的研究内核：ResearchIntent → ResearchAgenda / ResearchTask → ResearchFinding → ChangeSet → ResearchRun。现有 LangGraph 负责固定生命周期；主管负责动态问题，后台任务保留租约、事件游标、取消与版本事务。

新运行默认 2,000,000 token、512 个搜索查询、128 个独立任务、32 次议程修订、4 个调查员；调查员每批 32 次模型交互，能在账本内继续批次。20% token 预留复核，查询不预扣复核份额。规划、调查、综合与复核共用账本。调用前持久化预占，成功后按 usage 对账；不确定失败保留预占。没有 usage 时按字符保守估算，原始调用记录标记 estimated。恢复不能重置预算，工具调用 ID 与结果保持对应。

原生接口保存 messages、tool_calls、tool_call_id、reasoning_content 与 finish_reason。MiMo 使用 api-key 和 max_completion_tokens；DeepSeek 使用 Bearer 和 max_tokens。工具参数在本地验证，不依赖强制选工具或 strict schema。

工具完整结果在研究会话归档中保留。来源索引通过 list_sources 分页，原文、转述和研究笔记明确标记；直接事实不得借转述冒充来源逐字原话。来源正文按片段与 offset 读取；被上下文压缩的工具结果通过 read_observation 续读。搜索摘要不标作正文。已知来源可通过 fetch_source 获取完整可读正文；读取上限或格式失败明确报告，不把部分内容标作完整。后台检查点保存共享来源、原生会话、结果、议程历史和预算。

停止状态分别为 goal_reached、insufficient_material、no_progress、budget_exhausted、cancelled、failed。冷启动核心任务缺少目标、触发、输入、责任、活动、交付物、质量要求、证据复核或技能能力过程衔接时，保存草稿。内核预览不构成首版完成，也不触发旧的后台增量交付。没有正式版本时工作台可读取同项目草稿；用户显式发起下一轮可复用全部已存来源。此操作建立新运行，失败重试或重启恢复则继续原账本。

## 判断、改动与采用

证据引用以 SourceAsset / SourceSegment / EvidenceBinding 为准。表达性质 direct / synthesis / inference、支持关系、复核状态及采用状态分别表达。模型支持不是事实证明；数字置信度仅兼容显示。falsifier 可选。精确引用必须与实际收集的原文匹配。

图谱 Claim 用 researchFindingId 回连研究记录；缺失概念保留在研究记录中。风险与深化雷达是记录视图，按时间变化和关系一致性组织后续调查，不拥有独立事实生命周期。代码按用户选择、项目转换、学生表达、覆盖排序，不按影响节点数量加权。

ChangeSet 记录固定 snapshot ID / 基线内容哈希、动机、发现引用、原子操作和分层检查。编译器处理新增、修订、补证、拆分、合并、替代和废弃；一组操作失败时不部分应用。删除与迁移有明确理由，旧快照保留。身份迁移与未解决语义问题保存候选并进入审阅；低影响修订须独立复核实际替换文本，不能只复核改动理由。通过质量检查的普通改善默认采用；用户可以选择先审阅。版本事务最后校验当前 head、ownership、取消状态和 source run 幂等性。Hub 发布仍是独立的用户操作。

## 导入与下游交接

两端岗位包文件读取接受 2.0.0、3.0.0、3.1.0。旧包没有 taskDefinition 时显示未知，不通过迁移补造信息，也不改变原包哈希。新字段在语义对象与对象读取投影中提供，继续使用 packageId + packageVersion + snapshotId + rootHash + task ID 定位；launch ticket 不传整个任务正文。任务定义不是学习证据。

## 回归与范围

金标准固定在 `apps/role-atlas/evals/golden/llm-app-engineer/research-v2/baseline-lock.json`，覆盖已有岗位包、研究材料、复核记录及评估材料。受控变体只在测试内创建，不改原包。新协议回归覆盖原生协议、预算恢复、来源续读、任务缺口、范围隔离、改动原子性和版本审阅；旧运行用原参数与原检查点语义兼容。

本轮仅本地重构，不推送、部署、迁移日常数据库或替换用户应用。真实模型连接验收与离线确定性回归分开报告；没有学生反馈时，不声称已证明学生理解改善。

完整执行结果、失败修正和未执行项见 [本轮验收记录](../../apps/role-atlas/reports/research-v2/validation.md)。
