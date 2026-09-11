# 六类迭代能力：技术定义与验收门禁

状态：`implemented`（2026-09-11）

本文是六类用户可选迭代能力的权威技术定义。产品入口是统一的 `迭代岗位快照` Skill（见 [snapshot-iteration.md](/Users/a1-6/LearnFlow/apps/role-atlas/docs/snapshot-iteration.md)），六类能力是 `mode × initiativeProfile × targetIds × targetAsOf × prompt` 的契约组合，不是六套独立实现。

## 1. 能力到契约的映射

| 能力 | mode | initiativeProfile | 其他字段 | changeIntents |
|---|---|---|---|---|
| 深度研究 | `deep_research` | 任意 | — | `expand + verify` |
| 风险发现 | `risk_repair` | 任意 | — | `repair + verify` |
| 时效迭代 | `freshness` | 任意 | `targetAsOf`（缺省取当天） | `refresh + verify` |
| 目标增强 | `auto` | `co_guided` | `prompt` 非空 | 由 prompt 判定（repair/expand/refresh） |
| 自动发现 | `auto` | `autonomous` | — | `repair + expand + verify` |
| 定向研究 | `auto` | `user_directed` | `targetIds` 非空 | 由 prompt 判定；无 prompt 时 `repair + expand + verify` |

契约由 `createIterationContract`（`lib/iteration/planner.ts`）唯一生成，记录目标、范围、证据政策、预算、验收政策与停止条件。任何入口不得绕过契约私下解释用户选择。

## 2. 每种能力的执行路径

公共管线（`lib/iteration/graph.ts` 九节点）：契约 → 检查与机会发现 → 研究计划 → 定向检索 → 候选重建 → 安全整理 → 评估 → 条件续轮 → 定稿。

### 深度研究

- 机会来源：全局检查中 `suggestedAction = research` 的发现（证据缺口、边界不清、能力抽象不当、事理/学习路径缺口）加上用户 prompt。
- 重建执行：有新增来源且非锚定条件时走 `full` 重建（重新提取 mention、任务壁垒、知识/能力/事理泳道）；`preserveIterationGraph` 保证已有任务、技能与证据绑定不丢失。
- 验收：信息增量（新来源 ×8、新语义节点 ×3、新事理场景 ×6、解决发现 ×5）或健康改善任一即可，见 §4。

### 风险发现

- 机会来源：`RESEARCH_REPAIR_CODES` 中的已诊断缺陷（任务知识技能缺口、能力缺口、过程缺口、失证等），按任务独立分派工作项，不用聚合告警消耗预算。
- 重建执行：已有任务 + 任务类修复发现时走 `enrichment`（固定任务 ID 补证），不重新猜测任务。
- 验收：除通用门外还必须 `repairProgress` —— 选中发现消失、任务技能覆盖改善、直接证据覆盖改善或挂载定义改善，四者至少其一。单纯新增来源或无关节点不算修复完成。

### 时效迭代

- 契约：`targetAsOf` 先参与来源核验（晚于目标时点的来源是 `FUTURE_SOURCE` 错误），评估通过后才把日期写入快照、brief 与 manifest；日期变化本身不算证据增量。
- 研究：查询带“截至 targetAsOf”约束，类别优先 `technology / future_signal / official_standard / job_market`。
- 验收：`targetDateBlocked` —— 目标时点变化后仍存在 temporal error 发现时整轮拦截。没有新来源和结构变化时，只改日期不会制造新版本。

### 目标增强

- 用户 prompt 生成 `expectedValue = 100` 的最高优先级机会和 `user_focus` 查询；prompt 命中的维度（知识技能/能力/过程/证据/时效）限定非 `user_directed` 时的发现纳入范围。
- 其余路径与深度研究相同。空 prompt 时退化为自动发现。

### 自动发现

- `graphRadius = global`，所有检查发现都进入机会候选，按 `findingValue`（严重度 + 分类 + 解锁价值 + 置信度）排序，受 `maxWorkItems` 预算约束。
- 第一轮部分改善且有剩余可研究工作时续第二轮，更换证据类别，不重复查询；停滞两轮或预算耗尽即停。

### 定向研究

- 范围：`contract.targetIds` + 沿 `requires_skill / requires_capability / contains` 的三跳下游（`createIterationContract` 的 feedbackScope）。
- 重建执行：**锚定 enrichment**（2026-09-11 起）。定向研究声明的对象是既有节点，全量重建既会因为限定来源不参与抽取分片而丢掉基线原始证据，又会引入范围外对象。锚定模式下 `knowledgeTargetIds` 只含声明范围（而非所有活跃工作项的目标），`hydrateKernel` 的 taskGroups 同步收窄，知识/过程泳道只在声明范围内派生。
- 验收：`reviewIterationScope` 整体验收 —— 新对象必须有合格来源支撑并通过可追溯关系连到选中范围；共同岗位根节点不是扩展所有兄弟任务的跳板。范围外对象/关系/断言导致候选整体不被采用（不删节点掩盖越界）；只多了未绑定目标的来源也不算完成。

## 3. 资料边界判定（智能体通用层）

检索主入口 `researchRoleSources` 在确定性排序之后、入选之前执行一次模型边界判定（`lib/search/boundary-verdicts.ts`）：

- 输入：按确定性得分排序的前 24 个候选（url、标题、域名、前 600 字摘录）；候选文本按不可信数据处理。
- 输出：每候选一个 `relation`（`core` 边界内 / `adjacent` 相邻岗位 / `comparison` 边界对比 / `foreign` 边界外）+ 置信度 + 一句边界理由。
- 效力：**只能淘汰或降权，不能扩权**。`foreign` 且置信度 ≥ 0.7 淘汰 secondary/contextual 层候选（权威/一手来源只降权不否决，因为标准文件合法命名相邻岗位）；`adjacent` 降权；`core` / `comparison` 不加分。模型编造的 url 一律丢弃。
- 兜底：模型缺失、超时、JSON/Schema 校验失败时返回 `undefined`，完全回退到 `foreignOccupationPenalty` 等确定性启发式；两者同时存在时叠加生效。
- 审计：每个 verdict 写入研究报告 `candidates[].boundaryVerdict`，研究审计页展示“边界判定：类别 + 置信度 + 理由”；按内容 hash 记忆化保证幂等。

冷启动三处检索（主检索、任务层补研、知识补研）与迭代研究统一接入同一 verifier。岗位互斥金标准（`tests/hub-boundary.test.ts`）继续作为回归断言，但边界判断不再依赖具体岗位词表。

## 4. 验收门禁政策：什么允许拦，什么不允许拦

`evaluateIteration`（`lib/iteration/planner.ts`）是唯一验收门。

**允许拦截（协议与证据诚信）：**

- 协议不变量失效（`protocolValid = false`，含 `INVALID_SNAPSHOT_TIME`、`FUTURE_SOURCE` 等硬阻断）；
- 已接受核心回退：丢任务/知识技能/任务-技能边、结构错误增多、失证增多、Agent 可用性显著下降、任务无技能覆盖净增；
- 相对本轮已验证成果的后续回退；
- 定向研究的范围违规（§2 定向研究）；
- 时效迭代的目标时点仍有时效错误；
- 风险发现没有任何修复进展（防“换个标题冒充修复”）。

**不允许拦截（有证据支撑的实质增长）：**

- 新增合格来源、新语义节点、新事理场景、发现净解决中的任一信息增量，即使它没有恰好解决某个被选中的 finding（风险发现除外，见上）；
- 候选只改善研究前沿而未提升核心健康分（信息增量路径）；
- 模型措辞、节点标签与基线不同但身份稳定（findingIdentity 按代码 + 排序 targetIds 判定，标签变化不伪造问题消失或新增）。

**“没有内容”的诚实语义：** 无搜索配置或关闭联网时研究跳过，候选不重建，结果是 `no_change`，工作项标 `known_gap`，摘要明确“当前静态快照保持不变”；不得把跑了空管线包装成完成。反过来，只要智能体与检索返回了相关资料并产生证据支撑的增长，门禁必须放行 —— 这是六能力特征化测试（`tests/iteration-capabilities.test.ts`）钉死的契约。

## 5. 事件序列与失败语义

关键事件（NDJSON，`POST /api/snapshot-iterations`）：`iteration.run.started` → `iteration.contract.created` → `iteration.inspection.completed` → `iteration.opportunities.created` → `iteration.work.plan.created` → `iteration.research.plan.created`（含 `skippedReason`）→ `iteration.search.*` → `iteration.research.completed` → `iteration.candidate.rebuild.started/completed`（`execution: enrichment|full`）→ `iteration.patch.proposed/applied` → `iteration.evaluation.completed`（含 evaluation 全文）→ `iteration.run.completed`。

- 模型失败：泳道级局部恢复（分片拆分、紧凑重试），最终失败记 `laneFailures` 与 `known_gap`，不伪造内容。
- 检索失败：查询级有限重试（429/5xx），失败进入 `report.failures`，类别覆盖标 `failed` 而非静默缺失。
- 候选被拒：诊断、查询、工作项、拒绝原因全部保留在运行记录中，当前快照不变；已接受的前轮改进不因后续候选失败而丢失。

## 6. 回归入口

- 六能力特征化：`tests/iteration-capabilities.test.ts`（六种选择各自跑通“机会 → 工作项 → 查询 → 新来源 → 可验收快照”）。
- 边界判定：`tests/boundary-verdicts.test.ts`、`tests/web-research-filtering.test.ts`、`tests/hub-boundary.test.ts`（金标准）。
- 既有迭代行为：`tests/iteration-*.test.ts`、`tests/snapshot-iteration-*.test.ts`、`tests/automatic-iteration-lifecycle.test.ts`。
