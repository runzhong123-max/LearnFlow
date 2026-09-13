# 学习依据卡片、反向关联与复习当前资格

版本：共享核心 0.2.7；`learnflow.memory-evidence.v1`；`review-qualification.v2`。

## 产品行为与边界

Web 与桌面的画像页（`/learner-profile`）、画像声明及复习工作台（`/review`）使用同一来源卡片组件。卡片按需读取原子事实，显示来源事件、确定性变更、正文 SHA-256、字符范围、证据等级、辅助程度、题目形式与结果。原文片段有长度上限；未完整展示的限制条件明确计数，不把摘要冒充原始证据。

卡片展示实际登记的 SUPPORTS、CONSOLIDATED_INTO、SUPERSEDES、REFINES、CONTRADICTS 双向关系。可点击回溯、返回与翻页。每卡至多 20 个来源、40 条关联；截断与无法核对来源单独显示。这里只说明已记录的依赖，不声称已经追踪所有学习路径或所有 Agent 对记忆的消费。学习路径仍是教学安排，复习工作台仍管理调度与尝试，五核仍是共享的学习者状态维度。

复习达到现有间隔规则后，后续失败会撤销 knowledge.mastery 与 practice.proof_chain 的当前资格：旧成功事件、Attempt 与事实正文保留，旧事实及依赖其证据集合的 Module/Claim 停止用于当前判断。SUPERSEDES 关联指向旧版本。再达到失败后至少两次独立、可计入稳定性的成功、跨度至少 72 小时且包含已校验变式后，恢复当前资格。题目难度与迁移有效性仍受原有规则限制，不能据此宣称长期学习收益。

## Contract impact

现有契约把历史成功与当前 stable 混在同一字段，导致复习失败后长期 stable 仍可见。本版有意将对应 `level` 改为 `needs_review`，增加 eligibility、policy_version、historical_evidence_ids、invalidated_by_event_id 等字段。原有字段结构兼容，stable 的适用语义收紧；调用者应判断当前资格，不能仅凭曾经存在 evidence_ids 推断掌握。

权威链不变：EvidenceEvent → five_kernel_reducer → KernelMutation → KernelState → MemoryFact → MemoryModule → MemoryClaim。只新增只读 data contract，绑定既有 `vnext_five_kernel_profile_reader`，无新增 Agent、评分器或写入授权。用户纠正继续使用已有声明反馈事件，不能修改正式评分。

新复习事实按本次事件涉及的题目投影；KernelState 保留兼容的题目字典，避免某题事件把其他项目的旧结论重新发布为自己的证据。版本标记保留旧 Mutation 的原有事实展开解释。旧聚合事实包含多个题目时，失效采用保守的整条排除，不改写其正文；来源接口也不把这类整包归到当前题目或项目，显示无法核对的覆盖缺口。新的短期保持状态与实践历史快照同样通过 SUPERSEDES 标识后续更新。

旧库无需迁移：只读 guard 根据已记录失败与引用的成功事件，排除失效的旧 stable 事实及其声明，并在兼容状态投影中给出 detached needs_review。读取不写回 KernelState。新事件通过 reducer 正式更新资格。该 guard 扫描本学习者的复习历史与相关旧事实，尚无大规模延迟基准；后续可做等价索引优化，不能以缓存引入另一套状态权威。

## 安全与验收

接口 `/api/memory/evidence` 与 `/api/memory/evidence/{node_id}` 由当前登录身份确定 learner。入口及每个来源、邻居验证所属项目与检查点；来源同时核对 Fact ordinal/predicate/value、Mutation 与 Event 链接和 session ownership。原始 Event payload、正式答案、提交正文不会直接返回。越权返回通用 404；损坏、缺失或被遮蔽来源显示覆盖缺口。清理项目不会使全局列表崩溃。

回归覆盖资格失效、历史保留、重新取得资格、跨题隔离、旧库只读保护、来源完整性、反向关联及跨用户拒绝。浏览器验收覆盖画像与复习页、关联导航、翻页与窄屏；错误响应和来源损坏由接口与客户端回归覆盖。新实验单独冻结并保留原始记录，旧论文结果不覆盖。
