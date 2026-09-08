# 真实工作区接入与岗位快照实例化 v1.0

状态：`implemented`\
产品入口：任意岗位工作台对话栏上方的“接入真实工作区” Skill\
API：`POST /api/workspaces/ingest`、`POST /api/workspace-upgrades`

## 1. 目标与边界

真实工作区不是另一份 JD，也不能直接成为岗位共性。它回答的是：在一个可定位的软件研发、运维、安全或 AI 协作实例中，什么事件发生了，谁参与了，操作了什么对象，形成了什么交付物，怎样验证，结果如何。

完整流向：

```text
外部导出 / 公开案例 / 测试夹具
  → Adapter
  → Workspace Package 1.0
  → 敏感信息扫描与稳定资源清单
  → [事件 episode 抽取 || 独立产物抽取]
  → 观察去重与预算裁剪
  → 典型任务对齐 / 候选新任务
  → workspace_observation 证据
  → 统一 Snapshot Iteration Skill (instantiate + verify)
  → 语义图谱 + 事理森林 + 证据层 + 新的不可变候选快照
```

原始工作区永远不直接覆盖静态岗位快照。统一迭代仍会执行结构检查、外部交叉验证、候选重建、聚类整理和信息增量评估。

2026-09-08 验收补强：适配器输入结构在提交后台任务前校验，并返回需检查的字段。工作区读取成功不等于生成新岗位版本；升级要求观察能回指本包内未隔离的事件经过、结果或产物正文，只有标题、空值或遮蔽占位符的观察不进入模型重建。原始读取记录仍保留，工作台显示“需要补充资料”，不伪装生成成功。正常升级也保存与岗位迭代相同的领域结果摘要，区分“未生成新版本”和“已更新但仍有缺口”。

对话插件把 LearnFlow 的只读 `learningPathGraph` 传入工作区升级，与其他岗位工具使用同一学习路径对齐。用户填写目标不会替换“组织实例须经岗位级证据核验才能上升为共性”的边界；开启联网时，工作区观察同时进入交叉核验计划。此变更只增加可选请求字段及既有 job 的结果摘要，无新数据库或学习证据契约。回归入口：`tests/workspace-upgrade-quality.test.ts`。

## 2. Workspace Package 1.0

一个工作区包同时维护四类对象：

- `resources`：任务描述、沟通、文档、代码快照、Patch、Review、Test、CI、Release、Log、Metric、Trace、Incident、Outcome；
- `objects`：工作项、交付物、仓库、服务、系统、事件、测试用例、发布或数据集案例；
- `events`：带 `caseId` 的可排序工作事件，记录角色、对象、证据资源、状态和可观察结果；
- `links`：资源或对象之间的解决、依赖、生成、验证等原始关系。

它不是岗位图谱本身。Adapter 可以忠实保留各来源的结构差异，进入快照的是从事件链和交付物蒸馏出的 `WorkspaceObservation`。

## 3. 真实性等级

| 等级 | 可以支持的判断 | 不可自动外推 |
|---|---|---|
| `real_work_activity` | 某个公开或授权工作实例中确实发生的活动 | 所有组织的岗位共性 |
| `curated_real_case` | 从真实历史提取、经过筛选的可复现案例 | 原始组织的完整工作周期 |
| `production_trace` | 生产系统中实际产生的流程或遥测轨迹 | 轨迹之外的人类决策过程 |
| `controlled_experiment` | 受控故障或实验中可观察的因果链 | 未经生产验证的常态流程 |
| `teaching_simulation` | 教学场景中可训练、可评价的活动 | 企业真实岗位要求 |
| `synthetic_fixture` | 协议、UI 和算法是否正常 | 任何现实岗位事实 |

真实性和信息质量是两个维度。真实资料也可能片面、过时或缺少上下文；合成资料也可以用于充分测试结构，但必须清楚标记。

## 4. 第一批适配器

- `generic_package`：完整 Workspace Package 1.0；
- `github_trace`：Issue → PR → Commit → Review → CI → Release；
- `devgpt`：开发者与 AI 的多轮对话、代码片段和关联 Issue/PR；
- `swebench`：真实问题、基线版本、人工 Patch、测试与验收结果；
- `bug_benchmark`：Defects4J、BugsInPy 等缺陷版本、触发测试和修复；
- `event_log`：工单、流程或运维 case event log；
- `telemetry_case`：Metric、Log、Trace、故障动作和根因；
- `soc_case`：安全告警分诊、调查、处置与关闭。

适配器仅负责忠实归一化，不负责判断岗位共性。后续可加入 Jira、GitLab、飞书、钉钉、Confluence、IDE 会话、CI/CD 和本地目录 manifest 连接器，而不修改后续编排。

## 5. 并行与聚类策略

安全扫描后启动两条并行 Lane：

1. 事件 Lane 按 `caseId` 聚合、按 `sequence / occurredAt` 排序，形成目标—操作—验证—结果的 episode；
2. 产物 Lane 抽取没有被事件引用的独立文档、代码、测试、报告或发布制品。

Barrier 汇合后使用内容哈希去重，并优先保留事件完整、交付物丰富的观察。与快照对齐时先做中英混合标签/别名/摘要召回：高于阈值的观察绑定到既有典型任务，低于阈值的观察进入 `candidate_task`，交给模型和外部证据进一步判断。算法不强行把每份工作资料塞进现有任务。

## 6. 安全与溯源

- 疑似 API Key、Bearer Token、私钥、邮箱、手机号和本机路径在进入模型前遮蔽；
- 重复或空资源隔离，但普通低质量资料只产生警告，不做粗暴门禁；
- 私有工作区不生成公开 URL；只有 `publishable_metadata` 才允许把来源 URL 写入观察；
- 每个 `SourceAsset.workspaceEvidence` 保存工作区包、适配器、资源 ID、episode ID、真实性等级、许可证和公开定位；
- 工作区观察在证据层保持 `workspace_observation` 类型，模型提示明确“组织实例不能冒充岗位共性”。

## 7. 工具与持久化

可复用工具函数：

- `inspectWorkspacePackage`：读取真实性、来源、时间窗、资源和 case 清单；
- `readWorkspaceResource`：精确读取一个资源及关联事件/对象；
- `queryWorkspaceEvents`：按 case、角色、类型或资源检索事件；
- `inspectWorkspaceObservation`：读取蒸馏后的观察及完整回指；
- `alignWorkspaceSnapshot`：对齐当前快照任务并报告候选新任务与未覆盖任务。

D1 的 `workspace_ingestion_runs/events` 保存运行输入、阶段 checkpoint、事件流、结果、对齐报告和后续 iteration run ID。LangGraph 图不依赖进程内 `MemorySaver`；D1 记录才是产品恢复与审计依据。

## 8. 当前测试样例与下一步

`fixtures/workspaces/langgraph-pr-8053.json` 是公开的真实 GitHub 工作链小样例，绑定 Issue、PR、Commit、Review 和 CI 元数据。自动测试还覆盖敏感信息遮蔽、事件/产物并行汇合、任务对齐和 `workspaceEvidence` 穿透岗位包证据层。

接下来优先补：

1. GitHub URL 自动采集工具，减少手工导出 JSON；
2. 本地目录 manifest / ZIP 分片上传与 R2 Blob Store，原始大文件不进入 D1；
3. 多工作区批次聚类与跨 episode 任务共性统计；
4. 观察节点、任务节点和事理场景的前端 Hub 联动；
5. 用 DevGPT、SWE-bench、BPI、RCAEval 和公开 SOC 案例建立分层评测集。
