# 学习路径源图契约 v2

状态：2026-09-06 已实现结构校验、官方图迁移和双版本静态导出。特殊节点入库、岗位侧语义匹配器和图上编辑工作流尚未接入。字段权威是 `frontend/src/learning-path-contract-v2.ts`；架构登记见 `architecture_registry.py` 的 `DATA_CONTRACTS`。本文细化语义，不另建 schema。

## 契约对象与身份

| 对象 | 版本／身份 | 用途 |
|---|---|---|
| `LearningPathGraphV2` | `learnflow-learning-path/v2`；`graphId + revision` | LearnFlow 维护的课程、技能领域、知识点、技能点与关系快照 |
| `PathNodeV2` | `namespace + id + revision`，节点 revision 从 1 开始 | 跨岗位复用的规范语义；ID 不随名称或简介改变 |
| `RoleLearningAlignmentV2` | `learnflow-role-learning-alignment/v2` | 一个固定岗位包到一个固定路径快照的语义挂载集合 |
| `GraphExtensionProposalV2` | `learnflow-graph-extension-proposal/v2` | 固定基线上的特殊节点及关系新增批次；不是已入库图谱 |
| `RolePackageRef` | `packageId + packageVersion + snapshotId + rootHash` | 与既有岗位包不可变四元身份一致；rootHash 为小写 SHA-256 |

官方源图当前版本为 `learnflow:computing / 2026-09-06.1`，含 108 个节点和 187 条边，其中 90 个课程、18 个技能领域。首次 v2 导出中的节点 revision 为 1。没有把已有粗粒度节点自动宣称为知识点或技能点。

`protocolVersion` 变化表示字段契约变化；图谱 revision 变化表示源图内容变化；节点 revision 变化表示该节点内容修订。这三者独立；维护时更新变更节点在 `OFFICIAL_PATH_CONTENT` 中的 revision，并提升官方图 release，不重新分配稳定 ID。新增 v2 是兼容共存，不要求改写学习者历史。图谱 revision 是发布者分配的不可变版本标识，纯校验器不计算图谱内容哈希；未来通过 Hub 分发时仍必须校验现有 Hub 对象哈希，不能只相信文件自报版本。

## 节点语义与命名

| kind | 名称习惯 | 例子 | 边界 |
|---|---|---|---|
| `course` | 学校常用课程名 | 软件测试、数据库系统 | 组织教学内容，不能与其中某个知识点等价 |
| `skill_domain` | 稳定实践领域名 | 工程调试与可观测性 | 包含多个可独立说明和检验的能力要素 |
| `knowledge` | 概念、原理、规则的名词短语 | 等价类划分原则 | 能解释、辨别或推导的具体内容 |
| `skill` | 动词＋对象＋必要条件 | 使用边界值分析设计测试用例 | 能通过操作过程或交付物检验的具体行为 |

所有节点有 `title / summary / aliases / domains / audiences / stage / order`。知识点、技能点另外必须提供 `atomic.scopeNote` 与非空 `atomic.assessmentCriteria`，说明范围和如何检验；课程与技能领域不能携带这个原子定义。它们是教学设计规格，**不是实际学习结果或评分**。`order` 仅是布局提示，不能代替先修关系。

避免“掌握软件测试”“了解数据库”等泛化标题；把“会写 SQL 并调优数据库”拆成不同技能，再分别说明条件、产物和判断标准。校验器只能检查字段与关系约束；是否自然、是否真的原子、考核能否区分表现，需要后续命名和语义工作流结合证据判断。

简介由 LearnFlow 编辑整理，写明主要内容、实践活动或可达到的学习目标。官方表示 LearnFlow 官方维护的源图，不表示简介逐字出自教育部或某所学校。`official-learning-path-content.ts` 维护简介与粗粒度分类，来源索引和拓扑仍在 `learning-path-graph.ts`。本次移除 67 条通用占位简介并增强智能体工程简介，原有 40 条具体简介保留。参考来源保持原 ID；校验来源引用存在不等于逐条核实课程设置或先修关系。

参考入口包括 [CS2023](https://csed.acm.org/)、[Google SRE 目录](https://sre.google/sre-book/table-of-contents/) 与 [NYU Foundations of AI Agents](https://aiagents.stern.nyu.edu/)；详细课程来源随 v2 的 `sources` 一同导出。先修关系是 LearnFlow 的编辑性组织，边上的来源引用提供相关课程背景，不冒充学校原文规定。

## 图谱关系与岗位挂载

| 关系 | 方向／含义 | 校验规则 |
|---|---|---|
| `contains` | 课程／技能领域 → 技能领域／知识／技能 | 单独无环；原子点不能充当包含容器；不是先修 |
| `hard_prerequisite` | 必要前置 → 后继 | 与软前置合并后无环 |
| `soft_prerequisite` | 建议前置 → 后继 | 不表示强制学习或已掌握 |
| `co_learning` | 建议共学的两个节点 | 无先后约束；反向同类重复边被拒绝 |

图允许一个知识技能点属于多个课程或领域，不以复制节点实现多归属。命名空间与 ID 联合定位端点，不能仅按标题连接。包含图和先修图分别校验，避免把“课程包含技能”误当成“先学整门课程再学该技能”。

岗位挂载方向固定为“岗位知识技能要求 → LearnFlow 节点”：

- `equivalent`：知识对知识、技能对技能，定义和边界相同；课程或领域不能成为原子要求的等价目标。
- `narrower_than`：岗位要求是目标范围的一部分。例如“设计边界值用例”挂在“软件测试”课程下，属于粗粒度定位，不代表已找到规范技能点。
- `related`：相关但不保证包含或等价。不能据此推导学习完成或能力满足。

每条绑定带 `requiredLevel / context / rationale / evidenceRefs`。岗位要求深度和企业情境放在绑定上，规范节点保持可复用；不能把某企业工具版本或熟练度要求直接改成所有人的课程定义。`knowledge_skill` 旧混合类型需在后续生产工作流中显式判定为 knowledge 或 skill，不能原样冒充已完成分类。

`validateRoleLearningAlignmentV2(input, graph, source)` 同时检查图谱版本、目标节点版本、岗位包四元身份、岗位节点类型和包内证据引用存在。`source` 必须由已验证岗位包适配器给出。结构合法不证明语义等价；模糊检索的分数、模型自报置信度或标题相等都不能替代定义比较。

## 图谱特殊节点

缺少合适知识技能点时，岗位侧可以形成 `GraphExtensionProposalV2`。批次包含基线 `baseGraphRef`、包身份、`idempotencyKey`、作用域 namespace、新来源、新节点及新边。所有新增对象带 `role_package_proposal` provenance、同一包四元身份和包内 `evidenceRefs`。来源名称、URL 与包内证据引用分别保留，不能只提供一个模型生成的参考网址。v2 的 `sources` 同时接受原有公开课程来源与 `package_evidence` 来源；后者只携带包身份和证据引用，不强迫企业私有材料拥有公开 URL，也不复制其正文。接收服务须按已验证包的可见范围和脱敏策略决定命名空间与可分发元数据。

特殊节点的 `ownership.system = learnflow`、`ownership.catalog = graph_extension`，命名空间形式为 `learnflow:extension:<scope>`。它既不是 `official` 节点，也不是学习者 personal overlay。来源仍可追溯至 Role Atlas 岗位包；“由谁生成”和“由谁维护语义”是两个字段维度。

`validateGraphExtensionProposalV2(input, baseGraph, source)` 校验包身份和证据 ID、作用域一致、初始 revision、合并后唯一 ID、端点、来源、关系类型及环。每个新增连通分量必须接到已有图谱；不能只提交一团与路径无关的新点。批次只允许新增，不允许覆盖现有节点或偷偷编辑已有节点之间的边。返回校验结果并复制合法输入，不修改 baseGraph，不存储幂等键，不分配下一图谱版本。

未来确定性接收服务还必须负责：认证主体与 namespace 授权、包完整性及证据支持性检查、语义去重、幂等持久化、当前 revision 的并发检查、分配下一版本和审计回执。这些不是本次纯契约校验器已实现的能力。授权范围内的特殊节点可自动进入组织扩展图；成为官方公共节点应走既有维护与发布权限。

## 兼容和调用

```ts
import { exportOfficialLearningPathContractV2 } from '../../frontend/src/learning-path-graph.ts'
import { validateLearningPathGraphV2 } from '../../frontend/src/learning-path-contract-v2.ts'

const graph = exportOfficialLearningPathContractV2()
const checked = validateLearningPathGraphV2(graph)
if (!checked.valid) throw new Error(JSON.stringify(checked.issues))
// checked.value 是独立复制的源图；不是学习者状态写入请求。
```

导出函数在源图校验失败时直接报错。Role Atlas 执行 `npm run learning-path:sync` 同步：

- `public/data/learnflow-learning-path.json`：保持现有 v1 字段、节点 ID 和边 ID，用于现有 UI 与匹配器。
- `public/data/learnflow-learning-path.v2.json`：新增可选择消费的 typed source contract，含来源索引和节点语义类型。

两份数据均来自 LearnFlow 源码。同步前先构造并校验 v2，再写制品；契约测试检查两份制品与权威导出的逐字一致。当前没有通用 v2→v1 降级器，防止特殊节点和包含关系被静默丢弃或伪装成 personal 节点。尚未切换的 Role Atlas v1 matcher 仍是旧的词法定位，其结果不能按 v2 等价绑定解释。

源图改动不创建学习者兴趣、计划或掌握状态。个人路线选择继续由 Tutor 协调；教学设计交给 Learning Design Agent；实际练习和评分由 Practice Agent 负责。任何学习状态变化仍只能经过 `EvidenceEvent → reducer → KernelMutation`。
