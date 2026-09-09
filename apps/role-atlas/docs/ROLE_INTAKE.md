# 对话内岗位澄清与确认

Contract impact：新增 `role-intake/v1` 私有操作产物与兼容 API，作为 Role Atlas 冷启动插件的前置步骤。复用既有中央身份、owned 项目/对话、模型与搜索适配器；不新增主 Agent，不写 LearnFlow 核心对象、EvidenceEvent、五核或学习者画像。岗位说明修订不是岗位快照，确认只表示用户选定研究范围，不表示岗位事实已经被证明。

## 流程与接口

空项目及讲解态会话沿用现有项目 API；开始澄清或生成说明时才需要创建项目。右侧对话处理以下步骤：

1. `clarify` 读取公开 Graph Hub 候选的固定 Release，提出 1—2 个简短问题。此时没有岗位图谱写入。
2. `draft` / `refine` 执行三条有限检索，整理完整 JD 样式岗位说明：概述、主要任务、能力要求、工作场景、职责边界和资料索引。
3. 用户明确确认 `revisionId + contentHash`，服务器固定唯一 `buildRunId`。
4. 冷启动 API 根据确认引用从数据库读取岗位说明及来源，在同一个任务入队事务中检查确认仍有效，再进入原深研流程。

```text
GET  /api/projects/:projectId/conversations/:conversationId/intake
POST /api/projects/:projectId/conversations/:conversationId/intake/turn
POST /api/projects/:projectId/conversations/:conversationId/intake/confirm
```

三个 API 都返回 `{ intake: IntakeView }`，使用 `private, no-store`。`IntakeView` 的字段定义在 `lib/intake/types.ts`；初始 `revisionId/contentHash` 为 `null`，阶段为 `clarifying`。历史消息使用现有 messages 表，运营草稿状态在独立表中保存，不能从聊天措辞推断确认。

Turn 输入为 `action: clarify | draft | refine`、`operationId`、`message`，可带 `roleTitle/market/goal/sources/providerConfig/searchConfig`。已有修订后必须提交 `expectedRevisionId`；字段省略表示继续既有范围，显式传入空 sources 表示清空用户材料。输入 sources 最多 20 份。客户端声明的 public/authoritative/provider/workspace 元数据不会被提升为来源资格：这些材料被规范化为 private_document/contextual 研究线索。

Confirm 输入为 `revisionId/contentHash/operationId` 和可选 `buildRunId`。同一修订重复确认，即使操作 ID 不同，也返回第一次确认的构建 ID。未形成完整 review 修订不能确认。确认事务只为尚无 project_versions 的当前 owned 项目更新岗位名称、完整说明和市场范围，已有快照项目的名称不受影响。

## 持久化与并发

`ensureIntakeSchema()` 只新增 `role_intakes` 与 `role_intake_revisions`，不迁移日常数据或重写既有岗位记录。每个会话拥有独立 head/pending/confirmed 指针；修订记录保存操作输入 hash、完整结果、内容 SHA-256、搜索报告、原始检索资料以及确认主体/时间/构建 ID。

同一操作 ID 的相同输入重试复用原修订；不同输入返回 `INTAKE_OPERATION_CONFLICT`。供应商配置不参与草稿身份、不写入 input_json，修复凭据后可以用原操作重试。单会话只有一个有效生成租约（180 秒）；过期尝试不能提交迟到结果。完整请求有 115 秒总时限，检索有 45 秒预算，模型调用分别有 40/55 秒上限。失败记录保留输入和原材料，成功后响应丢失的重试只读取已提交结果。

GET 的可选 `recovery` 保存失败或过期中断操作的修订 ID、状态、精确 `input` 和错误说明，供刷新后用原 operationId / expectedRevisionId 重试；凭据取当前设置，不从草稿恢复。当前已完成说明保持显示，恢复材料单独保留，不覆盖旧说明。新修订成功后旧恢复项自动失效。

新 turn 原子地撤销当前确认；head 条件更新防止旧结果覆盖新修订。项目 building 或本会话 queued/running/waiting_user 任务存在时禁止改稿。所有私有操作及最终落库再次验证真实项目 owner、对话归属、未删除状态；管理员身份不能自动访问别人的草稿。

根构建接口集成点：

```ts
const confirmed = await requireConfirmedIntake({
  actor, projectId, conversationId, revisionId, contentHash, runId,
});
// 使用 confirmed.roleTitle / description / market / sources 覆盖客户端正文。
const fence = intakeBuildGuard({
  subjectId: actor.subjectId, projectId, conversationId, revisionId, contentHash, runId,
});
// 将 fence.sql + fence.bindings 加入新任务 INSERT 的 WHERE，不能只在事务外检查。
```

`requireConfirmedIntake()` 会初始化草稿表；若直接使用纯 SQL guard，先调用 `ensureIntakeSchema()`。入队 guard 与 turn 的“无活跃任务”条件构成两侧事务保护：先改稿则不能入队旧确认，先入队则不能改稿。既有后台投递必须依照服务端密封的原不可变输入恢复，不能以客户端标志绕过确认。

## 来源与事实边界

生成的 JD 只作为 build 的研究边界，不能另存为权威 public_document。独立检索来源保存 URL、获取时间、query/request IDs 和正文，并在真正深研时重新经过现有资格与证据绑定规则。用户材料没有独立支持的条目显示“待独立核实”。即使已有 20 份材料填满 build.sources，仍会进行独立检索；检索报告及额外正文保存在修订的 researchReport/researchSources 中，供 JD 生成和审计，build.sources 保持 20 份上限且优先保留用户原件。

联网不可用或失败仍可形成明确标注的候选说明，页面返回 warnings/researchStatus，不宣称完成联网核验。无效模型结构不会变成可确认的空壳。模型调用复用 research_model_calls 记录，附件原件链接到修订 ID；不持久化模型或搜索配置中的 API Key。

Hub 建议最多三个，固定 `packageLineId/releaseId/packageId/packageVersion/snapshotId/rootHash`，先验证公开访问和不可变制品，再提取任务、能力与场景。没有匹配是正常空结果；目录或制品不可用是可见告警。候选预览不会调用 Fork。现有 Hub 页面跟随推荐版本，因此固定候选 href 指向精确 Release 的 JSON 导出，不能伪装成推荐页面的固定版本链接。

## 验收

`intake-repository.test.ts` 使用隔离内存 SQLite 执行生产 SQL，覆盖三用户隔离、空项目、失败重试、响应丢失、并发租约、过期确认、唯一构建 ID、改稿/入队交错与确认后的项目名称。

`intake-generation.test.ts` 使用受控模型和搜索响应，覆盖有材料仍联网、20 份原件、来源身份降级、检索失败、改进上下文、短澄清、固定 Hub 建议与输出结构校验。`intake-hub.test.ts` 验证公开权限、固定身份、制品完整性和候选数量边界。测试不调用真实模型或搜索供应商。

## 工作台接入与已执行验收（2026-09-09）

新建入口进入 `/projects/new` 的固定展示台，全部输入留在右侧。空项目也使用该入口；普通岗位问答不承担冷启动。初次输入才创建私有项目，URL 带项目与对话以恢复；明确新建不会继续其他项目的草稿。草稿按中央主体、项目、对话保存，初步材料在缺少本地草稿时从服务端恢复。离开页面后允许已提交的服务器操作完成，但迟到响应不能重新导航或启动后续构建。

服务端确认后，浏览器提交稳定 buildRunId。外部 `/api/build-runs` 从已确认修订读取岗位说明和资料，强制继续联网研究，并在角色任务入队事务内再次校验当前确认。内部 worker 只重放已密封输入，不读取其他会话后来改变的项目来源。新增说明不会偷偷改写既有任务。

本地真实组件与受控 API 浏览器验收已完成：无新建弹窗；不明确→岗位建议和 Hub 拉取入口；改进输入刷新后保留；确认前 0 次构建提交；第 3 版说明确认后 1 次构建提交，携带最新说明且 webResearch=true。供应商输出为受控响应，这些验收证明交互与请求衔接，不代表真实供应商内容质量。
