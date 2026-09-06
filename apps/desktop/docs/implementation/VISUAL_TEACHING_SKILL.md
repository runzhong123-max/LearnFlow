# Visual Teaching Composition

## 目标

把“形成教学解释”和“生成视觉增强”放在两个不同的失败域中。视觉工具无论超时、返回非法 JSON、未通过语义/布局/安全门或传输中断，都不能使已经形成的讲解失效。

## 所有权

| 对象 | Owner | 职责 |
|---|---|---|
| 对话意图与展示 | Tutor Agent | 识别显式视觉请求并触发 Playbook |
| `visual_teaching_composition` | Learning Design Agent | 讲解、VisualBrief 候选和模态边界 |
| Skill Harness | Tutor Turn Runtime | 状态、一次修复、提交边界、失败降级和终态 |
| diagram / animation generator | Learning Design Tool | 编译、校验、布局和渲染 |

没有新增第四类主 Agent，也没有新增 Kernel writer。

## 运行合同

1. Skill 先生成纯文本讲解；这一步不生成 JSON，也不调用视觉工具。
2. Harness 校验讲解至少三句并覆盖对象、过程、结果和边界，随后立即发出 `teaching_segment_committed`。UI 单独保存 `committedContent`；`text_reset` 只清除后续 draft。
3. Skill 再使用 provider-native JSON object，把已经提交的讲解编译为 VisualBrief；`explanation` 字段必须逐字复制提交文本。
4. Harness 校验对象和引用完整；动画至少两个状态变化，图解至少一个关系。Brief 失败只允许一次修复，仍失败即以 `explanation_only` 收束，不调用视觉 Tool。
5. Tool 只接受 `visualTeachingBrief`，把 Brief 作为有界上下文交给 VisualSpec 编译器。
6. Tool 成功返回 `bundle_ready`；失败返回 `explanation_only`。最终回复始终以提交讲解原文开头。
7. 客户端若在提交事件后遇到 Brief、视觉或流传输失败，使用已提交讲解确定性收束，而不是抛弃整个回合。

Desktop 路径先调用正式 `/turns` 并取得已经持久化的 Tutor 消息，再生成 Brief 和视觉；不再并行启动两者。

## 兼容性

- VisualSpec 仍为 `learnflow.visual.v3`。
- `generate_learning_diagram` 与 `generate_learning_animation` 稳定 Tool ID 不变。
- 新增 VisualBrief `learnflow.visual-teaching-brief.v1` 与可选 `AgentTurnResponse.visualTeaching`。
- 普通非视觉回合继续使用可撤销 `text_delta/text_reset` 协议。
- 没有数据库迁移或 EvidenceEvent schema 变化。

## 验收

- 每个视觉失败阶段下，最终回复都逐字保留已提交讲解。
- 提交事件必须早于 `tool_started`，之后不得出现能清空提交段的 reset。
- 缺少 VisualBrief 的底层视觉 Tool 调用必须失败。
- 动画少于两个真实变化、图解没有真实关系时不得调用渲染器。
- 不允许静默从动画切为图解，也不允许视觉行为形成掌握证据。
