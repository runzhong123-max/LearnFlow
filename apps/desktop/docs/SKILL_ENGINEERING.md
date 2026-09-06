# LearnFlow Skill 工程契约

## 1. 定义

LearnFlow 的 Skill 是一个由主 Agent 拥有、在明确状态中运行、组合已登记工具并产生结构化输出的有界策略。它不是 Agent、Tool、单段 Prompt 或页面按钮。

- `pedagogical_method`：学习者可选的教学方法，只绑定 Tutor 的 `learn` 状态。
- `playbook`：Agent 内部组合能力的流程，不出现在学习方法选择器。
- `coordination_skill`：跨工作台或责任接口的协调策略。

机器权威是 `architecture_registry.py` 中的 `SkillContract + SkillRuntimeContract`。前端清单由 `backend/scripts/export_learning_skill_manifest.py` 生成；前后端不得各自维护另一套步骤。

## 2. SkillSpec v3 最小字段

每个可运行教学 Skill 必须声明：

1. 稳定 ID、owner、适用与避用条件；
2. 绑定 Chat mode、所需 context、输入/输出对象；
3. 初始状态、有序状态、每态教学目标与允许交互信号；
4. turn budget、循环与失败策略；
5. 允许的 EventContract、证据边界、独立验证交接；
6. eval suite 与成熟度。
7. `knowledge_requirements`：所需定义、机制、例子、边界、误解与评估依据，权威层级、时效等级和最低覆盖。Skill 只消费 Harness 编译的 `DomainKnowledgePacket`，不自己决定来源已充分。

需要因人或因任务调整的 Skill 还必须把校准维度声明在 `calibration_axes`，而不是把“难度”藏在
Prompt 中。费曼复述当前声明四个正交维度：受众层次、认知要求、支架强度和表征方式。学习者
可以显式修改；运行时也只能在“不会/请求直接解释”等求助信号下有界提高支架，不能据一次回答
擅自修改教育层次、学习偏好或掌握状态。

状态推进规则固定为：

```text
missing / acknowledgement / skip / no_prior / request_direct_explanation
  -> 留在当前态 + 有界支架

checkable learner attempt
  -> 最多推进一个状态

verification_ready
  -> 停止教学追问，移交无提示正式验证
```

这里的 `attempt` 只表示有可检查回应，不表示正确。正确性、评分、纠错和掌握只能由 Practice Agent 的确定性链裁决。

费曼复述允许在 `revising_explanation` 内围绕同一候选缺口循环，最多两次，再把该缺口作为
`VerificationHandoff` 的检查目标。`TeachBackDiagnostic` 只保存学习者原话、可观察的表达覆盖、
候选缺口、所用支架和待验证状态；它不判断领域正确性，事件为零 Kernel target。只有独立验证
后的正式 Attempt 才能产生 Knowledge / Practice 证据。

## 3. 评估蓝图不是教学 Skill

`assessment_blueprint_design` 是 Learning Design Agent 的 Playbook。它通过 `assessment_blueprint_builder` 形成：

- `AssessmentBlueprint`：目标能力、用途、题型组合、难度分布、成功条件和来源；
- `AssessmentRubric`：准则、权重、表现层级、可见性和证据政策。

蓝图只约束动态习题生成。它不作答、不评分、不写五核；`assessment_blueprint_proposed` 为零 Kernel target。正式链路是：

```text
LearningTask + scoped context
  -> AssessmentBlueprint + Rubric draft
  -> validated ConceptQuestion artifact
  -> learner submission
  -> deterministic grading / remediation
  -> EvidenceEvent -> reducer -> five kernels
```

## 4. 验收

- 注册漂移：`pytest tests/test_architecture_registry.py -q`
- 路由评测：`python scripts/evaluate_learning_skills.py`
- 多轮契约评测：`python scripts/evaluate_learning_skill_dialogues.py`
- 前端清单漂移由架构测试比较生成 JSON 与注册表。

多轮评测衡量信号分类、状态转换、支架边界、单步推进、验证交接和零 target 边界。它是工程验收，不替代学生实验、知识前后测或长期保留率研究。

## 5. 视觉教学 Playbook

`visual_teaching_composition` 是 Learning Design Agent 拥有、Tutor 触发的内部 Playbook，不出现在学习方法选择器。它统一编排图解和动画，但不替代两个底层渲染 Tool：

```text
compose_explanation
  -> commit_explanation
  -> compile_visual_brief
  -> render_visual
  -> bundle_ready | explanation_only
```

- `TeachingExplanationArtifact` 必须在渲染前独立成立并提交；视觉失败不能改写或撤销它。
- `VisualBrief` 固定包含主题、学习目标、稳定对象、真实关系、初末状态、步骤变化、不变量、误解与 claim boundary。
- 动画至少包含两个有意义的状态变化；图解至少包含一个真实关系。
- Tool 缺少已校验 Brief 时必须快速失败，不得从裸 query 私自恢复教学策略。
- `explanation_only` 是成功保留教学现场的合法终态，不是占位视觉或伪成功。
- 讲解、Brief、生成、观看与重播都是零 target 暴露，不构成 Knowledge / Practice 掌握证据。

详细实现和故障注入矩阵见 `docs/implementation/VISUAL_TEACHING_SKILL.md`。
