# Teaching Delivery 与学习视频 Harness

## 目标与落层

本能力解决两个问题：教学生成失败时不能“什么都没有”；视频推荐不能只看标题和热度。它不新增主 Agent、Skill、数据库表或学习者状态。

```text
Checkpoint.learning_contract
  -> knowledge_input_contract（可选 answer-free Knowledge ContextPacket）
  -> teaching_contract_gate
  -> ready | ready_with_gaps | fallback_ready
  -> Lecture（始终至少有一个答案安全小节）

既有 Source / Lecture / Practice / Assessment
  -> package_readiness（读取时重建）
  -> outline_only | content_ready | practice_ready | verification_ready

learner-owned LearningTask + package_readiness
  -> task_readiness（读取时重建）
  -> unbound | awaiting_acceptance | runnable_with_fallback ... verification_ready

学习目标
  -> search_learning_videos（discovered）
  -> inspect_learning_video（content_inspected | metadata_only）
  -> learning_resource_curation 给出候选建议
```

## Teaching Contract v1

权威仍是 `Checkpoint.learning_contract`。新字段为：

- `schema_version`
- `objective`
- `outcomes`
- `must_preserve`
- `avoid`
- `source_refs`

旧 `exit_criteria`、`knowledge_target`、`practice_target` 等字段原样保留。门禁只把 scope 越界、答案泄露、非法来源引用和不可解析结构视为硬错误；缺少来源或保留事实只是 gap。模型最多修订一次，随后由代码生成目标、核心事实、最小示例、下一步与缺口说明。降级讲解明确 `mastery_inference=false`。

`knowledge_input_contract` 是 Teaching Contract 的新增可选子契约，不是 Knowledge `MemoryModule`。它固定使用 `learning_design` ContextPolicy 的 answer-free、scoped 只读投影，可用于选择教学起点、例子、练习难度和缺口覆盖；不允许直接读取答案、生成 Kernel 写入或推断掌握。后台 Lecture 规划与小节生成只接收通过 `manifest.answer_free=true` 校验的 Knowledge 摘要、规范 facet 和最多六条观察；其他核、答案字段和完整记忆图谱不进入生成 prompt。没有可用知识上下文时使用通用包并显式保留缺口，不阻塞生成或原子任务启动。

## Delivery readiness

成熟度不是学习进度。它在读取 Checkpoint 时从既有对象重建，并放进响应中的 `learning_contract.delivery_readiness`。v2 将资产与运行实例拆开：

### `package_readiness`

只读取 Source、Lecture、ConceptQuestion、Exercise、AssessmentBlueprint 与 AssessmentRubric：

1. `outline_only`
2. `content_ready`
3. `practice_ready`
4. `verification_ready`

它不依赖 LearningTask；基础教学资产可以先准备，learner-scoped Assessment 仍只影响当前学习者的包投影。缺少资产时返回明确 `gaps` 和已登记的 `next_capabilities`，但固定 `fallback_allowed=true`。

### `task_readiness`

只把当前 LearningTask 的接受/运行状态与 `package_readiness` 组合，返回 `available_phases` 和透明降级：未绑定、等待接受、最小讲解启动、仅带领学习、可练习、可独立验证以及终态。Teaching Contract 的非空 fallback 保证已接受任务即使只有大纲也能进入 `learn`；没有练习或 Rubric 时只是不开放对应阶段，不能伪造验证。

旧顶层 `overall/sources/content/guided_learning/practice/verification/gaps` 继续按 v1 语义输出，作为迁移期兼容摘要；新消费者应读取两个具名子投影。删除投影或重建数据库不会损失学习事实。任务创建、开始、完成和教学包就绪均为运行事实，不形成掌握；正式验证仍唯一走 Attempt 和 EvidenceEvent。

## 视频 ACI 与 Harness

模型只看两个目标级接口：

- `search_learning_videos(target, goal, level, language, max_duration_minutes, platforms, max_results)`
- `inspect_learning_video(candidate_id, query, outcomes, max_segments)`

第二个接口只接受本轮搜索返回的 candidate ID。Bilibili/YouTube 搜索、元数据读取、字幕抓取和离线 seeded catalog 是 Harness 内部机制。没有字幕或 ASR 时返回 `metadata_only + asr_required`，不得把元数据相关性写成内容覆盖。字幕片段显式带开始/结束秒数，输出同时列出 outcome gap 和 answer-leak risk。

所有接口只读、无需确认、零 Kernel target。若以后接入音频 ASR，仍只能补充资源核验，不得直接生成 LearningAttempt 或掌握状态。

## 兼容与降级

- 无数据库迁移；历史 Checkpoint 在读取时规范化。
- 离线评测通过显式 fake adapter 注入固定候选；生产环境无网络时返回 empty，而不是伪造链接或把评测数据展示给学习者。
- 未配置 `YOUTUBE_API_KEY` 时 YouTube 实时搜索返回 `not_configured`；Bilibili 失败不阻断其他 provider。
- 正式学习验证仍唯一走 `LearningAttempt -> EvidenceEvent -> five_kernel_reducer`。
