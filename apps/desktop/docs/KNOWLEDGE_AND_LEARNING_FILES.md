# 隐形领域知识底座与学习文件

## 一分钟逻辑

```text
本地文件 / URL / GitHub
  -> learner-owned Source -> immutable SourceVersion -> version-bound Chunk
  -> DomainBrief + 来源健康检查
  -> DomainKnowledgePacket（Claim 绑定 version/chunk/locator）
  -> 规划态资源策展 / Tutor 讲解 / TeachingContentBrief

LearningTask
  -> 显式“生成讲义与练习”
  -> hidden task_artifact Project + Checkpoint
  -> Lecture + ConceptQuestion / Exercise
  -> 独立工作台或对话纸张（只保存 artifact ref）
```

来源内容不是学习者状态；文件被生成、打开或接入对话也不是掌握证据。

## 对象权威

- 领域知识底座复用正式 `Project -> Source -> SourceVersion -> Chunk`。每个 learner 有一个 `project_kind=knowledge_library`、`visibility=internal` 的隐藏 Project，纯粹作为权限与存储边界。当前对话明确附加的 source id 优先进入工作集；即使词面得分低也不会被静默丢弃。其余个人库只按主题相关性补缺。
- 每个已检查 SourceVersion 具有多维 `source-profile-v1`，分别描述可信度、全面度、时效性、真人观点性、教学适配与可复现性；不存在对所有意图都成立的单一“最佳来源”总分。
- `DomainKnowledgePacket` 是任务级事实投影，不是第二套学习者画像，也不是掌握证据。事实 Claim 与带归因的真人 `viewpoints` 分开存放；观点材料不能静默满足事实覆盖门。
- 讲义权威仍是 `Lecture`；练习权威仍是 `ConceptQuestion` 与 `Exercise`。`.lflecture` / `.lfexercise` 是逻辑文件名，不复制数据库内容。
- 对话纸张只保存 `{kind, ref, title}`，打开时由服务端重新检查 learner ownership，并返回答案安全视图。

## Tool 与 Skill 分工

- `domain_knowledge_reader` 是 ACI Tool：按当前对话附件和问题返回有界领域索引、来源片段和 provenance，不做资源选择。输入区可以显式选择“对话资料”，也可由 Tutor 在“自动”模式中与联网搜索比较。
- `learning_resource_curation` 是规划态 Playbook Skill：先比较个人来源和学习路径覆盖，再用计算机知识搜索补缺；从目标匹配、来源层级、实践价值和成本说明推荐理由。
- 视频资源沿用同一个 Playbook：`search_learning_videos` 只返回 `discovered` 候选；推荐前用 `inspect_learning_video` 核验本轮候选的字幕/ASR、时间点、目标覆盖与答案泄露风险。底层平台适配器不是模型工具，标题、热度、观看和字幕读取都不构成掌握。
- `learning_file_service` 管理正式讲义/练习的列表、打开和纸张接入。模型没有通用文件写权限；仅在带领学习态、正式 `LearningTask + checkpoint` scope 下，`dynamic_practice_generator` / `similar_practice_generator` 可以提交题目候选，服务端通过静态质量门后物化为正式练习文件。
- `practice_quality_inspector` 只检查 schema、测量目标声明、答案确定性和重复指纹；它不评价学生，也不产生掌握证据。
- `dynamic_practice_loop` 是 Tutor Playbook：组合出题、质量检查、正式提交、确定性判题、纠错、变式和复习。Tool 生产或读取对象，Skill 编排闭环，二者不互相冒充。

## 五核与证据

| 事件 | Kernel target | 含义 |
|---|---:|---|
| `knowledge_source_added/processed` | 无 | 资料进入上下文空间 |
| `web_evidence_captured` | 无 | 已读网页原文进入临时版本化证据 |
| `project_knowledge_source_promoted` | 无 | 学习者显式把精确来源版本复制到目标项目；仍未成为项目基线 |
| `project_knowledge_baseline_proposed/confirmed` | 无 | 项目来源基线提案与用户确认 |
| `knowledge_source_health_changed` | 无 | 过期、冲突、隔离或恢复的完整性事实 |
| `learning_task_knowledge_blocked` | 无 | 任务保留，但知识不足时不发布教学产物 |
| `learning_file_generated/opened/attached_to_chat` | 无 | 产物与 UI 审计 |
| `practice_file_generated/practice_variant_generated` | 无 | 已通过静态门但尚未校准的练习产物 |
| `practice_quality_inspected` | 无 | 题目质量观察，不是学生表现 |
| `lecture_viewed` | Knowledge exposure | 明确读过，`mastery_unchanged=true` |
| `concept_attempt_evaluated` | Knowledge + Practice；显式反馈时可到 Structure / Human | 确定性评分后的概念题证据；只有学生明确填写的卡点或有效帮助才进入后两核 |
| `exercise_attempt_evaluated` | Knowledge + Practice | 沙箱/测试后的实践证据 |

任何文件内容中的指令都被当作不可信数据，不能改变 Agent 目标、安全边界、路径或五核。练习读取接口在提交前隐藏答案、解释、solution 和私有测试预期。

## 后续项目来源迁移

隐藏领域底座中的 Source 具有稳定 owner、Source ID、Chunk ID 与 provenance。项目创建后通过 `POST /api/vnext-projects/{project_id}/knowledge-sources/promotions` 显式选择精确 SourceVersion；服务端校验 learner ownership，快照复制版本与 Chunk，记录幂等、零 Kernel 的晋升事件。晋升只得到 `confirmed` 候选，仍需经过覆盖提案与基线确认才能成为 `pinned` 项目约束。规划态推荐最多把来源推进到 `recommended`，不得静默把个人资料或 Tutor 推荐变成项目主来源。
