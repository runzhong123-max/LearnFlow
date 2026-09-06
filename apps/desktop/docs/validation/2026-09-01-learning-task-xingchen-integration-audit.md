# 学习型任务转化 + 讯飞星辰接入考察报告

> 更新日期：2026-09-02\
> 范围：本地真实代码、API、插件、测试与 2026-09-02 手工导出的脱敏工作流合同快照\
> 安全：未读取、复制或记录 `.env`/私密文件中的密钥

## 1. 一句话结论

当前实现已经形成“专属语义模型预检 → 本地消歧并锁定任务 → 用户确认 → 讯飞生成不可信候选 → LearnFlow 确定性校验 → 用户以候选 root hash 再次确认 → Learning Design/正式任务运行时创建 LearningTask → 个性化学习入口”的完整宿主链；两个外部模型都不成为第四个主 Agent、不直接写五核或掌握状态。2026-09-02 的真实 provider 回归已成功生成并确认 JavaFX EXE 打包任务，但线上已发布 Flow 与本次平台导出是否为同一修订仍无法从本地证据确认。

## 2. 工作流身份与版本

- 平台导出显示工作流名为“岗位典型工作任务转化智能体”，编辑器 ID `660757`，DSL v1，19 个节点，模型族为 Spark Pro-128K。
- LearnFlow 私有运行配置使用 API Flow ID `7489976439921045504`；该 ID 不在导出的 YAML 字面内容中，因此编辑器 ID 与 API Flow ID 的映射“无法从本地证据确认”。
- 平台页面观察状态为“编辑中”。无法从本地证据确认导出内容与线上已发布修订一致。
- 脱敏、无提示词和无凭据的合同快照见 [xingchen-workflow-660757.contract.json](fixtures/xingchen-workflow-660757.contract.json#L1)。

## 3. 当前已实现能力

1. 插件选中后，宿主先用能力专属语义模型按严格 JSON 合同判断输入层级并提出同领域典型任务候选；本地代码再验证原文、锚点和“不得替用户选择”边界，返回待选择/待确认准备单，不调用讯飞。
2. 登录用户与项目归属检查；来源限定为项目内不可变 `SourceVersion`。
3. 用户明确确认准备单后，将任务标题、描述、目标步数与有界来源摘要序列化为 `AGENT_USER_INPUT`。
4. 调用固定讯飞工作流，解析 JSON 或导出式 Markdown 结束节点输出。
5. 优先从结束节点 `handoff_url` 读取 `learning-task-to-personalized-learning-v1`，固定 HTTPS origin 与任务卡路径后规范化为内部 bundle；旧服务间 bundle 接口作为兼容路径。
6. 将规范化 bundle 转为 `role-learning-task-candidate.v1`，包含工作情境、目标、前置、资源、步骤、安全、交付物、知识/技能/能力映射、成功标准、Rubric 与独立验证声明。
7. 确定性检查 schema、快照、步骤数、ID、DAG、引用、映射、URL、安全、Rubric 与评分权威；结构失败最多两次定向重试。
8. 候选按 learner + project + requestId 幂等保存，读取、来源检查、审计与 handoff 均项目隔离。
9. 用户明确确认后，LearnFlow 再校验候选与 root hash，幂等创建正式 `LearningTask`，返回 `/tasks?task={id}`。
10. 确认只创建任务并记录零 target 操作事件；不产生掌握结论和 KernelMutation。

核心生成、解析、映射和验证见 [xingchen_learning_task_candidates.py](../../backend/app/services/xingchen_learning_task_candidates.py#L621)、[候选确认](../../backend/app/services/xingchen_learning_task_candidates.py#L1693)。正式任务创建复用 [learning_tasks.py](../../backend/app/services/learning_tasks.py#L560)。

## 4. 未实现或无法确认的能力

- 无法确认本地配置的 API Flow ID 与平台编辑器 ID `660757` 是同一工作流。
- 无法确认本次 YAML 导出与线上发布修订完全一致；平台观察状态是“编辑中”。
- 工作流知识库 Pro 在导出/平台观察中处于不可用提示；真实可用范围需要运营方在平台确认。
- `citations` 只有当 provider 实际回传本次来源 `citationId` 时才成为绑定引用；没有绑定时只能标为 `source_supplied_unverified` 或 `ungrounded`。
- 岗位来源事实的稳定对象 ID、跨快照来源闭包、岗位包 packageVersion/rootHash 必须由上游明确提供；不能由模型推断。
- 当前确认创建正式任务，但不会自动产生讲义、题目、评分或掌握变化；这些由后续 LearnFlow 教学与 Practice 运行时负责。

## 5. 精确输入合同

`POST /api/projects/{project_id}/integrations/xingchen/learning-task-candidates`

请求字段定义以 [CandidateCreateRequest](../../backend/app/api/learning_task_integrations.py#L30) 为准：

| 字段 | 类型 | 必填 | 限制/默认 |
| --- | --- | --- | --- |
| schemaVersion | literal | 是 | `role-learning-task-candidate-request.v1` |
| requestId | string | 是 | 8—160；字母、数字、`_ - : .` |
| taskTitle | string | 是 | 2—300 |
| taskDescription | string | 否 | 默认空；最多 2000 |
| upstreamTask | object/null | 否 | 默认 null；不可信输入 |
| sourceVersionIds | integer[] | 否 | 默认空；正整数、去重、最多 20 |
| targetStepCount | integer | 否 | 默认 6；3—12 |
| maxSourceSegments | integer | 否 | 默认 16；1—20 |

```json
{
  "schemaVersion": "role-learning-task-candidate-request.v1",
  "requestId": "demo-request-001",
  "taskTitle": "在测试服务器部署 Nginx 并验收 HTTPS"
}
```

讯飞开始节点只有一个必填字符串 `AGENT_USER_INPUT`。LearnFlow 向其中发送紧凑序列化 JSON，不是裸自然语言，wire 总长由宿主限制为 500 字符。wire 支持合同版本、脱敏请求引用、标题、描述、目标步数、快照 ID、来源 citation/version/excerpt 和输出类型；`idempotency_key`、`package_id`、`package_version` 与 `root_hash` 由 LearnFlow 宿主维护，不是独立开始节点变量。

确认请求以 [CandidateConfirmRequest](../../backend/app/api/learning_task_integrations.py#L60) 为准：

```json
{
  "schemaVersion": "learning-task-candidate-confirmation.v1",
  "confirmationId": "plugin-confirm:stable-id",
  "expectedRootHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "confirmed": true
}
```

`confirmed` 只能为 `true`；`expectedRootHash` 必须是 64 位小写十六进制值。

## 6. 精确输出合同

讯飞结束节点字段来自平台导出：`interactive_url`、`pdf_url`、`handoff_url`、`feedback_url`、`failure_report`。适配器既接受 JSON，也接受导出节点常见的 Markdown 标签；见 [workflow_end_output](../../backend/app/services/xingchen_learning_task_candidates.py#L621)。有意义的 failure report 会映射为 `workflow_input_insufficient` 或 `workflow_review_failed`，而不是永远显示同一句话；见 [错误映射](../../backend/app/services/xingchen_learning_task_candidates.py#L656)。

LearnFlow 成功响应是完整 `role-learning-task-candidate.v1`。错误统一包含 `code`、`message`、`stage`、`retryable`、`whoFixes`、`suggestedAction`、`diagnostics`。输入不足由用户补充且不盲重试；结构/评审失败可定向重试；授权与配置问题由 operator 修复；超时为 retryable。

确认成功响应是 `learning-task-candidate-confirmation-result.v1`，含 `candidateId`、`created`、`formalLearningTaskCreated`、`learningTask`、`navigation`、`managementNavigation`、`masteryChanged=false`、`kernelWrites=0`。

## 7. 工作任务转换链分析

| 输出 | 当前支持 | 权威类型 |
| --- | --- | --- |
| 岗位典型工作任务 | 部分 | 有 citation/稳定 ID 才是岗位事实，否则为候选 |
| 工作情境 | 是 | 模型候选或有引用事实 |
| 学习目标 | 是 | 教学设计推导 |
| 前置要求 | 是 | 模型候选 |
| 资源与设备 | 是 | 有引用事实或模型候选 |
| 分步操作 | 是 | 模型候选 + 宿主结构/DAG 校验 |
| 安全要点 | 是 | 模型候选 + 高风险确定性安全门 |
| 交付物 | 是 | 模型候选 + 每步可检查门 |
| 知识/技能/能力映射 | 是 | 教学设计推导 + 引用/派生标记 |
| 成功标准 | 是 | 模型候选 + 非空门 |
| Rubric | 是 | 候选内容；Practice 确定性执行 |
| 独立验证 | 是 | LearnFlow 确定性合同 |

候选使用 `derivedFromObjectIds`、`citationIds` 和 `derivationKind` 区分 `direct_fact`、`pedagogical_transformation` 与 `explicit_assumption`；见 [bundle_to_candidate](../../backend/app/services/xingchen_learning_task_candidates.py#L1026)。

没有来源时不会标为岗位事实；引用不在固定快照即拒绝；输入不足返回可操作错误；高风险任务缺少安全要求即拒绝；截断量进入 coverage/warnings；相同 requestId + 相同输入幂等，不同输入复用同一 ID 返回 409。

## 8. 确定性与模型边界

模型决定候选工作情境、教学目标、步骤文案、候选映射和候选 Rubric 内容。

确定性代码决定用户/项目/来源归属、来源固定、请求指纹、wire 限长、URL 安全、任务卡 ID、schema、步骤范围、ID 唯一、DAG、引用闭包、映射闭包、安全门、评分权威、重试次数、幂等、root-hash 确认、正式任务创建与全部五核/证据写入。

权威注册见 [architecture_registry.py](../../backend/app/services/architecture_registry.py#L1070)；确认事件是零 target，见 [同文件](../../backend/app/services/architecture_registry.py#L1315)。

## 9. 数据、安全和运行限制

- DeepSeek 预检与讯飞凭据都只从各自服务端私密配置读取，不进入浏览器 bundle、插件对象、日志 payload、候选或本文档。
- DeepSeek 只做一次输入分级和任务契约预检；必须输出 `learning-task-intake-model.v1` JSON，并通过本地原文/锚点/选择权校验，不能生成最终步骤。
- 插件只能调用宿主 allow-list 的项目集成操作；浏览器不取得 provider secret。
- 新交接读取器只接受配置 origin 上与当前任务卡严格匹配的 HTTPS 路径，保持证书校验并拒绝重定向、跨域、查询凭据和任意路径；证书覆盖的 HTTPS IP 可作为被固定 origin，不能用于任意 URL 抓取。
- 旧 bundle 接口仍要求 HTTPS DNS 地址与服务间 token。provider、handoff 和 bundle 均有硬超时；候选修订最多两次。
- 候选保存在 `learning_task_candidate_artifacts`；正式任务保存在 `learning_tasks`。
- 候选生成/确认不建立 KernelMutation；正式学习证据继续走 EvidenceEvent → reducer。
- 存在离线 MockTransport、固定 bundle、确定性 validator、隔离、幂等与确认测试。

## 10. LearnFlow 接入建议

1. **不可变静态任务包**：可行，适合离线 demo；需要固定 package/version/snapshot/rootHash 和导入 validator，推荐作兜底。
2. **候选 artifact 远程 Tool**：当前已实现且推荐。讯飞只生成候选，用户确认后才由 LearnFlow 创建正式任务。
3. **直接复用外部项目/路径/学习者状态 API**：不推荐，会与正式任务、路线、五核、评分和长期记忆权威冲突。

当前语义满足 `role_capability_graph__draft_learning_task` 所要求的候选能力，但实现名为 `learning_task_conversion__draft_learning_task`，返回 `learning_task_candidate`，不直接创建正式任务。

## 11. 必须新增或保持的接口/schema

已实现并应保持：

- `role-learning-task-candidate-request.v1`
- `learning-task-intake.v1`
- `learning-task-intake-model.v1`
- `role-learning-task-candidate.v1`
- `learning-task-candidate-confirmation.v1`
- `learning-task-candidate-confirmation-result.v1`
- candidate create/read/evidence/audit/handoff/confirm 六类项目 API
- `learning_task_candidate_confirmed` 零 target 事件

上游仍应提供稳定岗位对象 ID、packageVersion/snapshotId/rootHash、真实 citation IDs、来源快照一致性声明和发布 revision/hash 查询接口。

## 12. 风险与阻塞项

1. 平台导出状态为编辑中，发布版本一致性未知。
2. API Flow ID 与编辑器 ID 映射未知。
3. 知识库 Pro 可用性未知。
4. provider citation 回传不足会限制事实表述。
5. 真实 provider 受授权、配额、延迟和交接产物服务可用性影响；离线 demo 必须保留。

## 13. 证据索引与实际执行

- [工作流脱敏合同快照](fixtures/xingchen-workflow-660757.contract.json#L1)
- [候选 API 合同](../../backend/app/api/learning_task_integrations.py#L30)
- [本地输入分级与确认 Tool](../../frontend/plugins/learning_task_conversion/server.ts#L152)
- [独立语义预检合同与解析](../../frontend/plugins/learning_task_conversion/preflight-model.ts#L1)
- [结束节点输出适配](../../backend/app/services/xingchen_learning_task_candidates.py#L621)
- [受限 handoff 读取器](../../backend/app/services/xingchen_learning_task_candidates.py#L468)
- [候选映射](../../backend/app/services/xingchen_learning_task_candidates.py#L1026)
- [确定性 validator](../../backend/app/services/xingchen_learning_task_candidates.py#L1316)
- [生成与修订循环](../../backend/app/services/xingchen_learning_task_candidates.py#L1559)
- [明确确认与正式任务创建](../../backend/app/services/xingchen_learning_task_candidates.py#L1693)
- [正式任务运行时](../../backend/app/services/learning_tasks.py#L560)
- [插件确认 Tool](../../frontend/plugins/learning_task_conversion/server.ts#L238)
- [宿主工具桥接](../../frontend/server/agent-runtime.ts#L1145)
- [架构权威](../../backend/app/services/architecture_registry.py#L1070)
- [后端测试](../../backend/tests/test_xingchen_learning_task_candidates.py#L1)
- [前端插件测试](../../frontend/server/learning-task-conversion-plugin.test.ts#L1)

实际执行：仓库状态与真实代码检索、平台导出文件脱敏结构考察、前端全套 `npm test`、生产构建、后端全套 pytest、真实讯飞工作流调用、真实 `personalized-learning.json` 读取、候选校验和正式任务确认。真实回归样例“在 Windows 11 上把 JavaFX 库存管理应用打包为 EXE 并完成离线安装验收”产生 8 步候选，首轮不合格后自动修订，共 2 次 workflow run；候选与正式任务均成功，KernelMutation 为 0。未读取或输出 `.env`；未修改线上讯飞工作流；未证明线上发布修订等于导出修订。
