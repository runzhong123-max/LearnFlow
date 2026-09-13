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

模型只使用 `search_learning_videos`，平台固定 Bilibili。查询承接最近用户主题，仅标题参与匹配与排序；作者、热度、字幕和正文不参与相关性判断。搜索结果不表示已观看、可播放或内容覆盖。成功但无标题匹配是正常空结果，平台请求失败单独标记。

`inspect_learning_video` 仅保留旧调用兼容，不向当前 Tutor 暴露，也不请求字幕、音频或视频；只返回 metadata_only。所有接口只读，零 Kernel target。

## 兼容与降级

- 无数据库迁移；历史 Checkpoint 在读取时规范化。
- 离线评测通过显式 fake adapter 注入固定候选；生产环境无网络时返回 empty，而不是伪造链接或把评测数据展示给学习者。
- 视频搜索仅使用 Bilibili；不需要额外平台 API Key。
- 正式学习验证仍唯一走 `LearningAttempt -> EvidenceEvent -> five_kernel_reducer`。


Contract impact（2026-09-13.3）：既有视频搜索能力缩减为 Bilibili 标题检索，保留 v1 响应与历史 inspection 读取兼容。废除内容核验前置要求，当前 Tutor 不提供 inspection 工具。已注册的三类 Agent、EvidenceEvent 和五核语义保持不变；没有数据迁移。
