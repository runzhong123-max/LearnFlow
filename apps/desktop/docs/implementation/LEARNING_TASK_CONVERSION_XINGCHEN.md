# 学习型任务转化与讯飞星辰接入

## 1. 目的与权威边界

该能力把项目中的具体真实工作任务与固定来源版本发送给运营方配置的讯飞星辰 workflow，并返回可复核的 `role-learning-task-candidate.v1`。它是 Tutor 所有的插件 Product Skill，不是第四个主 Agent，也不是正式学习计划发布器。

- 远程 workflow：生成不可信候选 bundle。
- LearnFlow 后端：校验项目归属、固定 `SourceVersion`、组装有界来源、调用 provider、优先读取结束节点返回的版本化个性化学习交接 JSON（兼容旧 bundle）、执行确定性 validator、幂等保存候选。
- Tutor：解释候选、检查引用与警告、请求学习者确认。
- Learning Design：只在学习者以当前候选 `rootHash` 明确确认后，消费再次校验通过的候选并创建正式学习任务。
- Practice：仍独占评分、通过条件和独立验证结果。

候选生成、读取、来源检查、审计、handoff 与确认事件的 Kernel target 均为空。确认会创建正式 `LearningTask`，但生成文本、任务卡、任务创建、资源链接和 workflow 的“校验通过”声明都不是学习者掌握证据。

## 2. 插件合同

插件目录：`frontend/plugins/learning_task_conversion/`。Manifest 只使用 `learnflow.plugin-api.v1` 支持的四类扩展：`objects`、`tools`、`skills`、`renderers`。

| Tool | 类别 | 作用 |
| --- | --- | --- |
| `learning_task_conversion__prepare_learning_task_intake` | read-only | 消费宿主独立语义模型的结构化预检结果，再用本地规则锁定原文与语义锚点并形成待确认任务契约；不调用讯飞 |
| `learning_task_conversion__draft_learning_task` | artifact | 生成未确认候选 |
| `learning_task_conversion__read_learning_task_candidate` | read-only | 读取当前项目候选 |
| `learning_task_conversion__inspect_learning_task_evidence` | read-only | 检查快照、引用、覆盖与 grounding |
| `learning_task_conversion__audit_learning_task_candidate` | read-only | 重新执行确定性校验 |
| `learning_task_conversion__prepare_learning_handoff` | read-only | 形成 Tutor 审阅包；不创建正式任务 |
| `learning_task_conversion__confirm_learning_task_candidate` | artifact | 显式确认后由 LearnFlow 幂等创建正式任务 |

学习者在项目对话的工具选择器启用插件后，可像选择 Codex plugin 一样直接输入岗位、方向、学习主题或具体工作任务，不必再写“生成学习型任务”命令。宿主先使用该能力专属的独立语义模型做一次严格 JSON 预检：具体工作任务形成候选契约；岗位/方向只提出三个同领域、可执行、可验收的典型任务选项；学习主题或含糊输入只追问一个高价值缺口。模型被要求原样回显用户输入，但该回显不具备标识权威；宿主始终恢复自己持有的原始输入，再经过本地层级、锚点和候选选择规则，才能交给 `prepare_learning_task_intake` 生成不可变准备单。只有学习者点击或表达确认后，Tutor 才把原始输入、`intakeId`、`intakeRootHash` 和锁定后的任务契约交给 `draft_learning_task`，随后才调用讯飞。页面不跳转，也不要求用户到独立插件页重复输入。宿主仅暴露 allow-list 操作的 `projectIntegration.request`；插件无法取得后端地址、Cookie、任意 fetch 或 provider 凭据。

从其他插件的 Renderer 点击或拖入一个已校验 `task` 对象时，宿主把对象信封作为本轮结构化引用传给 Tutor；转化入口使用对象原始 `label` 作为任务名、对象摘要作为描述，并把 `plugin-object://...` 仅作为 `role_package` 来源引用。学习者可见的“引用插件对象”包装文本不参与任务标题、动作或工作对象提取。该逻辑只识别通用对象类别，不识别岗位插件 ID、岗位对象 ID 或具体 renderer；引用多个任务时仍需先明确选择一个。

## 3. 请求合同

`POST /api/projects/{project_id}/integrations/xingchen/learning-task-candidates`

```json
{
  "schemaVersion": "role-learning-task-candidate-request.v1",
  "requestId": "stable-request-20260901-001",
  "taskTitle": "部署 Nginx 静态站点并验收 HTTPS",
  "taskDescription": "在隔离实训环境完成部署并提交验证记录。",
  "upstreamTask": {},
  "sourceVersionIds": [12, 18],
  "targetStepCount": 6,
  "maxSourceSegments": 16
}
```

插件调用该接口前还执行不可跳过的双层前置合同：专属语义模型先按 `learning-task-intake-model.v1` 返回 `original_input`、输入层级、候选任务、置信度与单一追问；本地代码不信任模型回显，以宿主持有的原文为主键，并验证岗位/方向不能被模型代选、任务锚点没有被偷换。确认阶段要求 `originalInput` 原样保留、`intakeConfirmed=true`，且 `intakeId` 与 `intakeRootHash` 能由当前锁定契约重新计算一致。任何模型结构错误、语义锚点变化、未确认调用或过期 hash 都在讯飞调用前失败。`targetStepCount` 由已确认任务的动作数、验收/安全/证据门槛及描述复杂度确定，范围为 4—9，而不是固定六步。

`learner_id` 不在请求合同中，由登录会话获得。后端要求 `project_id` 属于当前学习者；`sourceVersionIds` 必须属于该项目，去重后最多 20 个。`requestId` 在 learner + project 范围幂等：相同输入返回同一候选，不同输入复用同一 ID 返回 409。

后端发送给讯飞的 `AGENT_USER_INPUT` 是序列化紧凑 JSON，版本为 `lf.xingchen-ltc.v1`。当前线上工作流内部工具的 `user_query` 上限是 500 字符，因此 wire contract 只发送任务标题、有界描述、目标步数、快照 ID 与一个带 `citationId`/`sourceVersionId` 的来源摘要，并在发送前硬性校验总长不超过 500。LearnFlow 仍在本地计算完整请求指纹，不会因 wire 压缩破坏幂等冲突检查。未发送片段数与未发送字符数都会明确进入 `coverage` 和 `provider_context_truncated` warning；不得把未发送内容声称为 provider 已使用的岗位事实。

wire 中的短键是固定合同：`v`=合同版本、`r`=脱敏请求引用、`t`=任务标题、`d`=有界描述、`n`=目标步数、`ss`=快照 ID、`s.c`=citationId、`s.v`=sourceVersionId、`s.x`=来源摘要、`o`=输出类型。结构修订使用 `fix` 字段并同样受 500 字符限制。当 provider 返回步数与 `n` 不一致时，候选保留实际步骤并返回 `provider_step_count_mismatch` warning，不伪造本地步骤填数。

## 4. 候选响应合同

响应保留完整结构字段，不压缩成摘要：

```json
{
  "schemaVersion": "role-learning-task-candidate.v1",
  "candidateId": "ltc_...",
  "requestId": "stable-request-20260901-001",
  "packageId": "learnflow-project:1",
  "packageVersion": "source-set....",
  "snapshotId": "source_snapshot_...",
  "rootHash": "...",
  "lifecycle": "candidate",
  "confirmationStatus": "unconfirmed",
  "groundingStatus": "grounded",
  "sourceSnapshot": {
    "packageId": "learnflow-project:1",
    "packageVersion": "source-set....",
    "snapshotId": "source_snapshot_...",
    "rootHash": "..."
  },
  "sourceBindings": [],
  "citations": [],
  "task": { "steps": [] },
  "mappings": {},
  "assessment": {},
  "coverage": { "partial": false, "truncated": false, "omitted": 0 },
  "warnings": [],
  "assumptions": [],
  "validation": { "valid": true, "kernelWrites": 0, "masteryChanged": false },
  "provenance": {
    "provider": "xunfei-xingchen",
    "flowId": "...",
    "workflowRunIds": [],
    "taskCardId": "...",
    "contractVersion": "learning-task-conversion-integration-bundle-v1",
    "validatorVersion": "learning-task-candidate-validator.v1.1",
    "kernelTargets": []
  }
}
```

`grounded` 只在 provider 输出实际引用本次发送的 `citationId` 时成立。有来源但 provider 未绑定引用时为 `source_supplied_unverified`；没有可发送来源时为 `ungrounded` 且 `citations=[]`。

## 5. 确定性验证与重试

LearnFlow 不信任 workflow 自报的 gate。Validator 实际检查：候选版本与固定 SHA-256 快照、3—12 个步骤、步骤 ID 唯一、依赖存在且无环、每步 operation/交付物/验收依据、知识技能映射不悬空、citation 属于固定快照、截断遗漏量、外部资源为 HTTP(S) 绝对地址、高风险任务有明确安全要求。任务标题词汇不重合只产生复核 warning，不以硬编码别名阻止所有候选。

结构、引用、依赖或安全失败会把精确 JSON path 诊断送入完整 workflow 重生成，最多两次修复；不会用通用模板冒充 provider 成功。Audit 每次重新执行 validator，不复用候选中的旧 `validation.valid`。

## 6. 错误合同

错误 `detail` 含 `code`、`message`、`stage`、`retryable`、`whoFixes`、`suggestedAction`、`diagnostics`。`stage` 为 `request | provider | bundle | validation | commit`；`whoFixes` 为 `user | learnflow | provider | operator`。

- 422：请求来源或候选结构不满足合同。
- 409：幂等输入冲突。
- 429：provider 限流，可使用同一 requestId 稍后重试。
- 502：provider/bundle 非法响应。
- 503：服务端凭据、授权、网络或外部服务不可用。
- 504：provider 或 bundle 超时。

讯飞 401/403 是服务端集成授权问题，返回 `provider_authorization_failed`、`whoFixes=operator`，不会冒充当前 LearnFlow 用户登录失败。

## 7. 配置与安全

专属语义预检只从 Vite 服务端读取 `LEARNING_TASK_PREFLIGHT_API_KEY`、`LEARNING_TASK_PREFLIGHT_BASE_URL` 和 `LEARNING_TASK_PREFLIGHT_MODEL`；变量不会进入浏览器 bundle、插件对象或日志，且非本机地址必须使用 HTTPS。预检当前可配置为 DeepSeek，只负责输入分级与候选任务契约，不生成最终步骤，也不取代讯飞工作流。

讯飞凭据只从私密文件读取；默认使用 `backend/.private/learning_task_conversion.xfyun.env`，`.private/` 已被忽略，示例配置只列变量名、不包含值。当前工作流结束节点返回 `learning-task-to-personalized-learning-v1` 交接 JSON；LearnFlow 只允许从配置中固定的 HTTPS origin 读取与当前 `task_card_id` 精确匹配的 `handoff.json` 或 `personalized-learning.json`，保持证书校验、禁止重定向、跨域、查询凭据和任意路径，然后规范化为内部 bundle 并走同一 validator。配置 origin 可以是证书 SAN 覆盖的 HTTPS IP，但该许可不扩展为任意 URL fetch。

旧部署仍可通过 `LEARNING_TASK_BUNDLE_CREDENTIALS_PATH` 和 `LEARNING_TASK_BUNDLE_SERVICE_TOKEN` 使用服务间 bundle 接口；旧接口继续要求受信 HTTPS DNS 域名和 Bearer token。私有 CA 可由 `LEARNING_TASK_BUNDLE_CA_FILE` 指定。`task_card_id` 不是访问凭证，插件和错误 payload 均不含密钥。

未配置固定 HTTPS 产物 origin 时在线能力显式返回不可用，不能伪造成功；只有走旧 bundle 接口时才额外要求服务间 token。Seeded demo 不依赖该在线插件即可完成核心 LearnFlow 闭环。

## 8. Contract impact 与迁移

Registry 当前为 `2026-09-02.3`。在既有候选 Tool、Product Skill、capability 和三个候选事件之上，新增“专属语义模型预检 + 本地输入消歧/语义锁定”阶段、root-hash-bound provider 调用、root-hash-bound 正式确认接口、插件确认 Tool 与零 target 的 `learning_task_candidate_confirmed` 事件。新增 `learning_task_candidate_artifacts` 表；现有启动建表流程会为旧数据库创建该表，不修改五核表。旧四类插件扩展合同、正式 `LearningTask` 运行时、EvidenceEvent schema 与 reducer 不变。

旧 PR 基于已撤销 generic Plugin Host 的文件不得合并。迁移方式是在当前 main 上启用新内置插件目录、部署后端窄接口，并把旧的页面跳转/Plugin Host 调用替换为对话内 namespaced Tool。旧候选数据不自动迁移；若需迁移，必须先转成当前候选 schema 并重新校验来源快照。

## 9. 正式确认链

handoff 使用 `learnflow.personalized-learning-handoff.v1`，包含 `taskSteps`、`skills`、`resources`、`citations` 和只允许审阅/修订/确认的 `returnContract`。它仍是 `ready_for_tutor_review` 的只读候选，不创建正式任务。

用户明确确认后，插件调用：

`POST /api/projects/{project_id}/integrations/xingchen/learning-task-candidates/{candidate_id}/confirm`

```json
{
  "schemaVersion": "learning-task-candidate-confirmation.v1",
  "confirmationId": "plugin-confirm:stable-id",
  "expectedRootHash": "64 位小写十六进制 SHA-256",
  "confirmed": true
}
```

LearnFlow 会重新执行当前 validator，并校验 `expectedRootHash` 与候选固定快照完全一致；不一致返回 409。成功后由 Learning Design 调用正式任务运行时，幂等创建 `origin_kind=learning_task_candidate` 的 `LearningTask`。provider 的详细步骤保存在 `plan.work_steps`，正式运行阶段保持 LearnFlow 的 `learn → practice → verify → consolidate` 四阶段合同；评分策略明确归属 Practice Agent 的确定性规则。响应为 `learning-task-candidate-confirmation-result.v1`：`managementNavigation` 提供 `/tasks?task={id}` 管理入口，`navigation/origin_navigation` 优先提供候选产生时的 `/chat/:conversationId` 学习现场。候选 provenance 和正式任务 `source_refs` 保存原 `sessionId + conversationId + sheetId` 及插件对象来源，客户端据此恢复同一对话纸张；没有这些字段的旧任务可按 session 或同项目最近的转化对话兼容恢复。

相同候选重复确认返回同一正式任务，不重复创建；确认事件、任务创建与任务接受事件均不写五核。候选 artifact 本身保持不可变、`unconfirmed`，作为正式任务的来源引用保存，不被覆盖成第二个状态权威。
