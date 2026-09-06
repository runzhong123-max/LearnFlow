# vNext 正式五核画像与读取工具 · v2

## 一分钟结论

当前 vNext 已读取正式后端的 `KernelState -> MemoryFact -> MemoryModule -> MemoryClaim`，不再把浏览器模拟画像当作权威。它让 Tutor 选对知识锚点、路径关系、表达方式、当前目标和实践证据缺口，同时让学习者在独立画像页逐核检查和纠正。

Tutor 每轮通过正式 `five_kernel_retriever` 请求有预算的 answer-free ContextPacket。敏感 Human Claim 不原样进入模型，而转成静默适配指令。任何写入都由 allow-list 网关生成 `EvidenceEvent`，再经 reducer；Agent、Reader 和 UI 都不能直接改 KernelState。

```text
学习者问题 + Tutor mode + LearningTask/Skill
  -> 确定性意图与主题识别
  -> ContextPolicy + 五核优先级 + scope/主题检索
  -> Fact/Module/Claim 评分、关系展开与预算裁剪
  -> 敏感信息策略过滤
  -> bounded ContextPacket
  -> Tutor prompt（只读）
```

## 1. 当前正式对象

### Module

Module 是由同核、同主题 Fact 经确定性门槛形成的不可变版本：

- `kernel`：Structure / Knowledge / Human / Value / Practice。
- `subjectKey`：模块所描述的领域。
- `summary`：供检索和人工检查的压缩摘要。
- `relatedModuleIds`：跨核联取关系，不建立第六个共享状态核。
- `claims`：该模块中的可检查原子陈述。
- `evidence_fact_ids / delta_fact_ids / parent_module_node_id`：可重放证据闭包与版本链。

### Claim

Claim 保留文本、置信度、证据边、状态、敏感度、使用策略和版本关系。

- `user_self_report`：学习者明确说过，但不等于已验证能力。
- `design_boundary`：系统的证据与推断边界，例如“学过不能推断掌握”。
- `direct`：可进入模型上下文。
- `adapt_silently`：只转成表达或支架约束，不向模型暴露敏感原文。
- `ask_before_surface`：未来用于必须经学习者同意才能显式使用的内容；当前种子没有此类 Claim。

学习者可以确认、纠正或撤回 Claim；系统生成新事件或新版本，不覆盖原始 Fact。画像中的“删除”是将当前 MemoryFact 归档为不再参考，仍保留审计历史。

## 2. 初始学习者自述与正式边界

| 核 | 当前 Module | 关键边界 |
|---|---|---|
| Structure | 当前位置与先修关系 | 准大二是位置；数学、编程、AI 入门只是后续路径锚点；LLM Agent 工程不必等待 RL |
| Knowledge | 自述课程与技术接触；AI 已有接触与开放边界 | “学过”是 exposure，不是 mastery |
| Human | 讲解与表征偏好；敏感理解边界 | 先定义后例子/代码；可视化是偏好，不是固定学习风格 |
| Value | 当前方向与未来分支 | 只保留方向、优先级和未来可能性；当前三方向无固定优先级 |
| Practice | 项目实践能力的待证区域；实践证据组合规则 | 目前没有真实项目证据；事件和提交计数不能单独代表能力 |

种子内容来自学习者明确描述：计算机专业准大二；学过微积分、概率论、数据结构、C、Python、线性代数、离散数学以及机器学习/深度学习基础；希望深入机器学习、智能体工程和强化学习；偏好可视化与“定义后立即给例子或代码”；未来可能走智能体工作或广义机器学习科研。

## 3. Reader 如何实现

### 输入

- 当前用户消息。
- Tutor 状态：自由态、简单讲解态、带领学习态或学习规划态。
- 可选的原子学习任务目标、当前 Skill 与步骤。

### 确定性选择

1. 先识别路径、项目、职业/科研、支持需求、概念讲解五类意图。
2. 再识别机器学习、深度学习、强化学习、智能体、编程和数学主题。
3. 根据意图建立 Kernel 优先级，而不是每轮固定读取五核：
   - 讲解：Knowledge + Human + Structure。
   - 路径：Structure + Knowledge + Value + Human。
   - 项目：Practice + Knowledge + Structure + Human。
   - 职业/科研：Value + Structure + Knowledge。
   - 明确困难：Human + Knowledge + Structure。
4. 对 Module 的 kernel、标签和学习任务目标匹配计分；每个优先 Kernel 至少先取一个最高分 Module，再补全高分项。
5. 默认最多 5 Modules / 9 direct Claims / 约 800 tokens；返回省略数量和证据缺口。
6. 使用稳定哈希生成 `snapshotId`，相同输入与画像版本必然得到相同选择，便于测试与复现。

### 敏感信息处理

人因 Claim 在进入模型前按策略分流：

- “偏好可视化”变为“关系或过程确实受益时提供简洁图解”，不让 Tutor 说“你是视觉型学习者”。
- “先定义后例子/代码”变为回答组织要求，不让 Tutor 复述“根据你的画像……”。
- 负荷或挫败信号只影响当前步幅和支架；一次答错、停顿或“不会”不能形成稳定情绪、能力、人格或医学判断。

对话工具过程只显示读取了哪些核、Module/Claim 数量和是否静默适配，不展示敏感 Claim 原文。Chat 的画像面板只显示学习者自述摘要与 Module 摘要；设置页由本地学习者本人检查完整 Claim。

学习规划态可以产生 Value Claim Proposal。候选必须由学习者接受、修改或拒绝；只有正式确认接口成功记录 EvidenceEvent 后，前端才显示 `formalWriteCompleted=true`。失败或离线时保留候选，但明确标记未正式写入。

### 模型上下文契约

```ts
type FiveKernelContextPacket = {
  schema_version: string
  policy_id: string
  purpose: 'global_tutor' | 'learning_plan' | 'learning_task'
  heads: KernelHeadSummary[]
  recalled_items: ContextMemoryItem[]
  relation_paths: ContextRelationPath[]
  conflicts: ContextConflict[]
  missing_facets: string[]
  omissions: ContextOmissionManifest
}
```

## 4. 五核分别怎样继续设计

### Structure + Knowledge：共用领域图，不共用状态权威

二者确实需要共同维护一些东西，但不应把它们合并成一个核。

- 共享的是只读领域对象：`ConceptNode / CompetencyNode / PrerequisiteEdge / ProjectMilestone`。
- Structure 维护“在哪里、依赖什么、从哪里返回、接下来可走哪条边”。
- Knowledge 维护“对哪个概念有什么级别的证据、误解、开放问题和待验证点”。
- 二者通过稳定的 `subject_key / node_id` 对齐。Structure 不能因为路线走完就宣布掌握；Knowledge 也不能脱离依赖图自行安排路径。

知识空间理论强调把领域结构与学习者当前状态联系起来，并只定位当前状态到目标之间的边界；Knowledge Tracing 则提供技能层随练习变化的估计。工程上应把二者分别用于“路径候选”和“知识证据”，避免概率估计直接变成产品事实。[Doignon & Falmagne 的知识空间工作](https://doi.org/10.1016/S0020-7373(85)80031-6)、[Corbett & Anderson 的 Knowledge Tracing](https://doi.org/10.1007/BF01099821)、[KST Tutor 实例](https://doi.org/10.1080/08839510801972785)。

下一版建议：新增共享 `LearningDomainMap` artifact；Module 只引用节点，不复制图。正式写入仍各自经过 reducer。

### Knowledge：从“课程列表”走向“可证伪的理解 Claim”

Knowledge Module 不应堆知识点，也不应把一次对话摘要当掌握。每个关键 Claim 需要至少区分：

- exposure：见过、学过或读过。
- supported performance：有提示完成。
- independent performance：独立完成。
- transfer：变式或新情境迁移。
- misconception / open question：稳定错误模式或尚待验证的问题。

当前模拟只保存 exposure 与待验证边界。正式版本才从 Attempt、变式、解释/复述和项目产物生成证据等级；多次、跨时点证据再形成 Claim。

### Human：凝练、敏感、理解优先，但默认不暴露

Human 建议只保留三类 Module：

1. 明确且相对稳定的互动偏好，例如“定义后给例子”。
2. 当前 Session 的短时负荷与支持需求，结束后默认衰减。
3. 经多次明确证据支持、确实会改善学习的长期约束。

认知负荷研究说明复杂问题求解会占用有限工作记忆，因此支架应减少与 schema acquisition 无关的负担，而不是简单把题目变容易。[Sweller 1988](https://doi.org/10.1207/s15516709cog1202_4)、[Sweller 等的认知架构综述](https://link.springer.com/article/10.1023/A:1022193728205)。情绪检测研究即使在受控条件下也只是中等准确，说明产品不能从自然对话轻率长期定性；最多提出低置信、短期、可纠正的适配。[D'Mello 等 2008](https://doi.org/10.1007/s11257-007-9037-6)。学习者可以有表达偏好，但没有充分证据支持按固定“学习风格”匹配教学法，因此我们只静默优化呈现，不建立类型标签。[Pashler 等](https://journals.sagepub.com/doi/10.1111/j.1539-6053.2009.01038.x)。

下一版建议：为 Human Claim 增加 `ttl / consent / surface_policy / contradiction_count`，并允许学习者直接纠正和删除。

### Value：主动简化成目标、优先级、相关性和约束

Value 不需要维护复杂人格、动机画像。建议只保留：

- active goal：当前想完成什么。
- priority / horizon：相对优先级与时间范围。
- relevance：为什么这个任务和目标相关。
- constraint：明确的时间、课程或职业约束。
- branch：尚未决定的未来分支。

自我决定理论相关研究提示，内在目标框架和自主支持有利于深层加工、表现与坚持；产品应帮助学习者看见个人相关性和选择，而不是用外部标签操控动机。[Vansteenkiste 等 2004](https://selfdeterminationtheory.org/SDT/documents/2004_VansteenkisteSimonsLensSheldonDeci_JPSP.pdf)、[Deci 等 1991](https://selfdeterminationtheory.org/SDT/documents/1991_DeciVallerandPelletierRyan_EP.pdf)。

下一版建议：Value Module 数量保持很少，只在规划、任务推荐和复盘时读取；普通概念讲解默认不读。

### Practice：以真实产物旅程评估，不缩成做题核

Practice 应维护“在真实约束下能做什么”，至少拆成：

- implementation：能否实现可运行产物。
- diagnosis：能否定位错误、形成假设并验证。
- verification：测试、评估、复现实验与质量门槛。
- design judgement：能否解释架构与取舍。
- tool fluency：能否有效使用仓库、调试器、文档、Agent 等工具。
- collaboration / individual contribution：团队项目中自己的可归因贡献。
- transfer：换仓库、换约束或换数据后能否迁移。

学习事件只能做时间线和索引；它不能完整承载代码质量、设计理由、隐性协作与复杂判断。正式事件必须引用 `artifact_id + rubric_version + evaluator + evidence_grade`，再由 reducer 决定是否形成 Practice Claim。Git 提交、代码行和任务数只能补充传统判断，不能单独评分；更可靠的方案需要联合客观轨迹与定性评审。[Buffardi 的 Git/User Story 研究](https://www.researchgate.net/publication/339510728_Assessing_Individual_Contributions_to_Software_Engineering_Projects_with_Git_Logs_and_User_Stories)、[多校复现实证](https://pconrad.github.io/files/paper032.pdf)、[ICSE-SEET 自动贡献摘要研究](https://doi.org/10.1109/icse-seet58685.2023.00030)。

下一版建议：定义 `PracticeEvidenceBundle`，由仓库快照、测试结果、Issue/PR、决策日志、反思、代码审查与独立复现组成；事件只引用该 Bundle，不把它压扁成几个计数。

## 5. 正式系统的下一步

1. **Reader 评测**：建立真实对话集，检查相关性、遗漏、敏感泄漏、过度个性化和 token 预算。
2. **共享领域图**：继续扩充 Knowledge/Structure 共用主题坐标，但保持状态权威分离。
3. **Human 生命周期**：补齐 TTL、consent、surface policy 与 contradiction count。
4. **项目实践 Bundle**：在真实 Agent 工程项目里验证过程、产物、迁移与独立贡献证据。
5. **项目接入**：让项目关卡创建正式 LearningTask，并用同一 ContextPacket 和事件网关读写。

## 6. 当前代码位置

- 正式前端网关与 ContextPacket：`frontend/src/formal-runtime.ts`
- Tutor 工具接入：`frontend/server/tool-runtime.ts`
- 五核画像页：`frontend/src/LearnerProfilePage.tsx`
- 后端正式网关：`backend/app/api/learner_state.py`
- 读取与分核策略：`backend/app/services/five_kernel_context.py`、`backend/app/services/architecture_registry.py`
- 确定性测试：`backend/tests/test_learner_state.py`、`backend/tests/test_memory_graph.py`
