# 岗位图谱与学习路径服务契约 v1

协议：`learnflow-ecosystem/v1`。这是已实现的 opt-in 服务入口，现有岗位生产与 v1 路径 API 保持兼容。界面入口为 LearnFlow `/ecosystem`。不能把“接口可复用”解释成桌面中央登录已经完成。

## 产品与数据责任

| 系统 | 权威对象 | 本轮接入 |
| --- | --- | --- |
| Role Atlas | 工作任务、能力、知识技能、证据、岗位快照与发布制品 | 固定四元身份读取、六种有界图谱工具、只读岗位助手、v2 挂载解析 |
| Graph Hub | 同一 registry 中的包系列、发布版本、可见性与内容寻址制品 | 公开已发布版本及当前主体拥有的版本检索；不另建包目录副本 |
| LearnFlow | 学习路径定义、主体作用域扩展、挂载记录、学习者状态 | 验证过的源图预览与原子提交；学习状态仍由原有三类 Agent 和证据链管理 |

数据库只在各自服务端访问。浏览器和桌面不直连 D1、SQLite/Postgres，不携带网关共享密钥。外部岗位助手属于 Tutor 调用的 adapter，不成为第四类 LearnFlow 主 Agent。挂载源图由 Learning Design 所有，不表示学习者已学会，也不自动创建个人学习计划。

一期身份是**单一中央 LearnFlow 身份源**的 `learnflow:learner:<id>`，不是组织级授权或多身份发行者联盟。私有岗位包须由关联项目的 `owner_subject_id` 授权；未归属的历史项目不自动授权，管理员也不自动取得他人的私有包。公开目录只收录 active 系列中的 published 版本；已删除项目拒绝访问。权限复核发生在读取、预览、提交及运行结果查询时。

## 客户端与服务端 API

除下述仅服务端反向签名的 automatic 入口外，LearnFlow API 复用中央 `get_current_learner`、浏览器 CSRF/桌面现有 transport；返回 `Cache-Control: no-store`。

| API | 输入/输出 |
| --- | --- |
| `GET /api/ecosystem/capabilities` | 可用性、操作白名单、身份与无五核写入边界 |
| `POST /api/ecosystem/dispatch` | `{protocol,requestId,operation,payload}` |
| `GET /api/ecosystem/learning-path` | `{graph,namespace}`，当前主体固定基线与已提交扩展 |
| `POST /api/ecosystem/learning-path/resolve` | `{requestId,packageRef,targetIds?}` → `{resolutionId,resolution}` |
| `POST /api/ecosystem/learning-path/automatic` | 受限反向签名，固定包与生产身份 → 全部知识技能逐点回执、待补全项；无浏览器登录回退 |
| `POST /api/ecosystem/learning-path/commit` | `{requestId,resolutionId}` → 回执、alignment、新 graphRef、addedNodeIds、masteryUnchanged |

响应统一为 `{protocol,requestId,ok:true,data}` 或 `{protocol,requestId,ok:false,error:{code,message,retryable}}`。客户端不自动重试模型执行或提交；重试同一操作必须复用 requestId。HTTP 409 表示版本或幂等冲突；源图版本落后须重新预览，不能继续提交旧方案。

公开 dispatch 操作：

- `catalog.search {query?,offset?,limit?}`：最多 30 项，含 `{packageRef,title,summary,visibility}` 与分页信息。
- `package.resolve {packageRef}`：四元身份精确匹配、可见性检查、manifest 与组件哈希校验后返回 `{packageRef,title,result}`。
- `role.query {packageRef,tool,args}`：仅允许现有 `read_role_objects / search_role_knowledge / query_role_graph / trace_work_process / inspect_role_evidence / audit_role_package`，保留运行时的结果数、深度与上下文预算。
- `agent.run {packageRef,message,targetIds?}`：消息最多 4000 字符，最多 25 个节点；立即返回 runId/status。只读分析，不编辑、发布岗位包或写学习证据。
- `agent.get_run {runId}`：仅当前主体可读，返回状态与完成后的 answer/citations/packageRef。

`packageRef` 必须包含 packageId、packageVersion、snapshotId、64 位小写 SHA-256 rootHash。不得用包名、“最新版”或仅 snapshotId 代替已选版本。

## 网关与身份委托

LearnFlow 后端只访问配置源站的 `POST /api/integrations/learnflow/gateway`。用户不能传目的 URL、Cookie、Authorization、数据库查询或模型密钥。源站要求 HTTPS，仅显式 loopback 开发允许 HTTP；不跟随重定向，不读取 HTTP 代理环境变量。

请求头 `X-LearnFlow-Delegation`：`base64url(claims JSON).hex(HMAC-SHA256(secret,base64segment))`。claims 包含 `{v:1,iss:"learnflow",aud:"role-atlas",sub,role,iat,exp,requestId,bodyHash}`。bodyHash 对**实际 UTF-8 请求字节**计算；有效期最多 60 秒，绑定请求 ID 与内容。签名验证不做 JSON 重排。所有私有读取仍验证包归属，不能只验签不验权限。

仅后端源图服务能够调用 `learning.resolve {packageRef,graph,namespace,targetIds?}`、`learning.validate_extension {proposal,graph}` 与 `learning.validate_alignment {alignment,graph}`。浏览器 dispatch 不允许这些操作，也不能自行提供包证据 ID。远端必须从已验证的岗位包构造证据上下文；namespace 必须等于当前主体 hash 得出的作用域。

请求/上游响应 4 MiB，浏览器 POST 128 KiB；后端超时默认 30 秒、硬上限 45 秒。部署应另设主体限流与模型费用配额。本轮仅提供每次有界执行与同请求去重，未实现跨请求计费配额。

## 知识技能细化与特殊节点

岗位生成 detail 阶段新增 `learningDefinition:{scopeNote,assessmentCriteria[]}`。知识点用具体概念名，技能点用可观察操作名；混合或领域级点保持 `hybrid`，不能仅换名冒充可考核原子点。定义与考核边界进入语义图、不可变制品及后续解析。旧包没有定义仍可浏览，但对应挂载结果明确为 needs_definition/needs_decomposition，不自动捏造历史定义。

选择岗位、任务或能力时，只沿 performs / requires_capability / has_unit / requires_knowledge / requires_skill 向下展开，最多四跳；不把相似、共学或先修关系当成岗位要求。自动解析逐点检查类型、范围、考核条件与包内证据；只在名称/别名、类型、scopeNote 和 criteria 全部一致时自动 equivalent。相似度仅帮助寻找课程/领域容器，不证明语义等价。手动预览中重名异义转为 ambiguous_definition，锚点不明确转为 needs_anchor；生产自动挂载可为不同显式定义创建独立点，并在无可信锚点时建立当前主体的岗位学习域容器；缺失证据转为 needs_evidence。

定义完整、证据可追溯且容器明确的新点进入当前主体 graph_extension namespace。自动关系只添加 contains，不猜测先修关系。解析返回：

```text
resolution
  alignment.bindings   已存在于当前源图的绑定
  pendingBindings      只有新节点提交后才能生效的绑定
  extensionProposal    新来源、新节点和包含边
  unresolved           原因与待判断的候选节点
```

预览不会写源图。用户确认后，LearnFlow 复核包权限、远端调用同一个 LearnFlow TS 契约校验器，并独立检查只追加集合；分配新 revision，以 CAS 原子保存图、绑定、回执及零 target `learning_path_extension_committed` 事件。重复请求重放回执；同 key 不同正文拒绝；两次并发修改只有一个成功。事件失败全部回滚。生成定义和提交节点不是掌握证据。

每主体保存固定官方基线的完整 source snapshot，避免官方版本升级悄悄改坏历史挂载。后续需提供显式基线迁移、组织共享节点审核、拆分/合并/废弃与引用迁移；本轮只提供追加能力，没有开放任意图谱写入。

## Harness 与自主性

岗位助手复用现有图：validate → plan_tools → execute_tools → check_coverage → synthesize_answer。工具规划与权限校验是确定性逻辑；模型只生成带引用的说明。`role-reader/v1` 与 `grounded-role-query/v1` 随运行记录返回。

网关先原子 claim 主体+requestId，再在 Worker waitUntil 中运行，限制模型 22 秒、图执行 25 秒，记录 completed/failed。客户端断开不撤销已提交执行。数据库运行记录跨客户端可查；运行中断超过 60 秒转 failed，不自动重跑模型。waitUntil 不是持久化任务队列，不保证 Worker 重启后继续推理；无后台 execution context 明确返回不可用。未来长时间维护/生产任务应接现有 job/checkpoint 框架并补主体权限、审批与版本 CAS，不把只读 run 冒充可恢复生产作业。

自动读取/检索/定义对比可以连续进行；明确请求启动一次模型分析；手动预览经用户确认落库。用户启动冷启动、迭代或工作区生产流程时，授权该次流程的知识技能通过受限自动入口正式挂载到本人源图。官方源图覆写、跨主体发布、先修关系变化、岗位版本发布与学习策略升级均不包含在该自主范围内。

## 部署与多端接入

中央后端配置 `ROLE_ATLAS_GATEWAY_BASE_URL`、`ROLE_ATLAS_GATEWAY_SECRET` 和可选 `ROLE_ATLAS_GATEWAY_TIMEOUT_SECONDS`；Role Atlas 服务端配置同一 secret。不要采用 VITE/PUBLIC 前缀。

面向多端的生产 Gateway Worker 必须配置 `ROLE_ATLAS_GATEWAY_ONLY=true` 或使用等效的受控私网 ingress。该模式仅放行 POST 签名网关，其余页面和旧 API 返回 404。现有 Role Atlas 作者界面保留在独立受控入口；旧的预览/项目/任务路由尚未全部改造为多租户，不应随新网关一起无保护开放。不要将两个配置不同的公开入口指向同一私有数据库后声称完成隔离。

网页端使用中央账号与同源 API，已实现完整挂载链。桌面端复用 `runtimeFetch` 与同一客户端 schema；但当前 Tauri 使用本地 sidecar 身份，网关明确禁用其中央委托。真正的桌面中央连接还需服务端授权码/PKCE 或受控会话桥接、独立中央 token audience、注销/撤销与本地/中央工作区切换；**不能只把 apiBaseUrl 改成中央地址并转发本地 Desktop Token**。本轮未宣称完成桌面中央登录。桌面官方源图 JSON 已纳入 sidecar 打包。

## 验收

1. 未登录请求拒绝；未配置源站显示不可用，不能显示假的成功。
2. 主体 A 看不到 B 的私有包/运行/挂载预览；正确包 ID 配错误 rootHash 拒绝。
3. detail 原子定义穿过编译制品保持不变；缺定义旧点保持未解决。
4. 新点预览只在 pendingBindings；提交后出现在源图，刷新可读，并显示考核边界和包含关系。
5. 同请求模型只执行一次；源图重复提交不重复入库；并发 stale revision 拒绝；学习掌握状态保持不变。
6. 真实远端部署/真实模型与桌面中央认证需在环境配置完成后另行联调，单元测试不替代这些验证。


## 岗位生产自动挂载（2026-09-09）

`role-learning-auto/v1` 属于既有 `curriculum_source_runtime`，由 Learning Design 所有。Role Atlas 与不可变版本同事务写入 outbox；已有持久 worker 等会话生产与后续 enrichment 空闲，只处理该会话最终版本。中间待处理项标记 superseded，已完成回执保持不变。制品按精确版本自动准备为 private/metadata；制品完整性仍必须通过，公共发布质量门禁和显式发布动作不变。

可修复的定义、分类、证据缺口允许复用原生产身份与密封供应商配置，自动接续最多一个原会话研究任务（2 轮、12 来源、8 工作项）。入队时原子复核 owner、精确 version、迭代模式与无活动任务；先重放正式挂载请求复核中央账号和私有包权限，原任务关闭联网时沿用关闭状态。子任务版本重新挂载，血缘记录禁止后代循环。复用既有 snapshot-iterations 与可信内部 dispatcher，无新增外部授权头或模型 API；仅源图补全，零学习状态写入。自动模式下完全等价候选与内容 ID 碰撞由确定性选择/扩展 ID 处理，不触发模型补研，也不改变手动预览的歧义边界。

反向委托只使用固定源站 `POST /api/ecosystem/learning-path/automatic`：`X-Role-Atlas-Delegation` 为 `base64url(claims).hex(HMAC-SHA256(secret,segment))`，claims 严格包含 `{v:1,iss:"role-atlas",aud:"learnflow-curriculum",sub,iat,exp,requestId,bodyHash}`，最长 60 秒。签名绑定实际 UTF-8 正文与 `learnflow:learner:<id>`；使用现有仅服务端共享密钥，方向与 audience 独立于前向网关。拒绝 Cookie、Authorization、Origin、Sec-Fetch 和桌面 token，不转发登录凭据。中央重新读取 active account/learner 并复核包权限，完成回执重放也不能绕过撤权。

正文为 `{requestId,packageRef,projectId,projectVersionId,sourceRunId,policyVersion}`，不接受用户节点、图谱、namespace、外部目标 URL 或任意操作。服务读取固定制品内全部 knowledge_skill，以 25 点一批复用 `curriculum_catalog.resolve/commit`。批次提交键跨 source revision 稳定，预览键绑定当前 graphRef；遇 stale_graph 重新解析，最多四轮后交给持久 outbox 重试。独立操作表保存最终结果；超时、响应丢失和并行重试不会重复建点。

结果逐点区分 existing、created、needs_research，并包含完整 packageRef、真实 target namespace/id/revision、正式 receiptId/graphRef 及未解决原因。缺少类型、定义、验收要求或证据时返回待研究项，不补造证据；没有 KS 返回 needs_research/no_learning_points。`readAutomaticMountResearchFeedback(projectId,versionId)` 供后续研究按原节点定向补全。浏览器状态是回执投影，不承担写入调度。

新节点仅追加到当前主体 graph_extension namespace。确切类型、名称或别名、范围、验收条件相同则复用，说明摘要更新不产生新点；定义变化创建不同语义点，原节点、绑定和已学内容不被覆写。无锚点时新增显式 standaloneRoots 岗位学习域与 contains 子节点，不虚构与官方课程的包含、先修或等价。人工预览与提交入口继续保留。

提交沿现有事务保存 source graph、alignment、receipt 和零 target `learning_path_extension_committed`，自动提交的 provenance 记录 role_production_start 与精确生产身份。没有新增掌握事件或 KernelMutation，也不创建个人学习计划。部署与恢复说明见 [自动挂载运行说明](../../apps/role-atlas/docs/automatic-learning-mount.md)。
