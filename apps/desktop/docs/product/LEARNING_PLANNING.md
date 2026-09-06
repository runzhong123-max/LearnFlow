# vNext 学习规划态 · v1

## 一分钟结论

学习规划态处理一个原子任务或几轮简单讲解无法完成的目标。它仍发生在 Chat 中，只有两个分支：

- `project_seed`：围绕真实产物收集项目启动所需信息，形成项目雏形；当前不创建项目。
- `direction`：比较职业、科研和长期学习方向，给出建议与低成本探索实验。

```text
较大目标 / 发展方向表达
  -> 确定性识别 learning_plan
  -> append-only PlanningEvent
  -> LearningPlanProjection
  -> Tutor 有界规划上下文 + 轻量规划锚点
```

## 项目雏形需要什么

目标产物、当前基础、来源与资源、时间投入、实践与验收、现实约束。每轮只优先追问一个缺口；信息达到可用阈值后写 `vnext_project_seed_ready`，但 UI 仍显示“项目尚未接入”，不生成项目 ID、关卡或文件夹。

## 发展方向与 Value Claim

方向规划收集当前位置、候选方向、决策时间、选择标准、探索证据和现实约束。只有“我想 / 我希望 / 我倾向 / 未来准备”等明确表达可以生成 Value Claim 候选。

候选必须展示：

- 当前 Value 内容。
- 建议内容。
- 学生原话依据。
- 推断边界与正式写入状态。

学生可以接受为候选、要求修改或拒绝。拒绝和修改请求是零 target 运行事件；接受会通过正式 Value Claim gateway 写入带 scope 的确认事件，再由 reducer 裁决，不能直接修改 `KernelState`。

规划态还会调用正式学习路径 Reader。已知课程或技能由确定性 Path Planner 形成长期路线 proposal；页面必须明确标记“尚未写入”。学习者点击确认后，`vnext_learning_path_plan_manager` 追加正式事件，同时更新 Structure 的活动路线与 Value 的确认目标。后续规划态使用 `learning_plan` ContextPolicy 读取该活动路线，不再把每轮建议当成无状态文本。

## 当前事件

`vnext_learning_plan_started`、`vnext_learning_plan_note_captured`、`vnext_project_seed_ready`、`vnext_direction_plan_ready`、`vnext_value_claim_proposed`、`vnext_value_claim_proposal_accepted/rejected/revision_requested`、`vnext_learning_plan_closed`。

前述运行事件不是掌握或能力证据。正式 Value Claim 与长期路线确认事件只证明学习者确认了目标，不证明路线节点已经掌握。
