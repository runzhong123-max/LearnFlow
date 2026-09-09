# 岗位知识技能自动正式挂载

用户启动冷启动、迭代或工作区生产时，授权本次知识技能写入自己的 LearnFlow 学习路径源图。挂载复用现有正式 resolve/commit，不新增个人计划、不写掌握状态、不公开岗位包。手动 LearnFlow 预览入口保留。

## 调度与恢复

`commitProjectVersion` 将 `role_learning_mounts` 入队与版本保存放在一个 D1 batch。只处理有中央 owner 的 cold_start/iteration/workspace；restore、历史迁移、删除项目和非中央主体不自动触发。唯一键是 project_version_id + policy_version。

已有 job-worker 先发现角色生产任务，补上内核后的 enrichment，再读取挂载任务。会话仍有 queued/running/waiting_user 生产时等待；只处理 conversation.version_id 对应的最终版本。较旧 queued/retry 置 superseded；已完成回执保留。不同对话各有最终版本，正式源图通过中央 CAS 合并，同账号同一时刻本 worker 只运行一个挂载任务。

Worker 对 `/api/internal/learning-mounts/:id` 使用既有内部签名。挂载租约 120 秒，重试最多八次，指数退避上限五分钟；过期租约可恢复。私有制品版本号由项目/版本/快照确定，已保存 packageRef 复用；编译中断且没有制品的同身份私有记录可重新编译。完整性不合格不能准备成功；publicationBlockers 不阻止私有学习来源准备，但公开发布仍执行完整质量检查。

调用 LearnFlow 前再次核对项目 owner、删除状态、会话最终版本及活动生产。签名与服务端账号复核见 [中央服务契约](../../../../docs/product/ECOSYSTEM_GATEWAY_V1.md)。请求最多 60 秒；中央按稳定批次键持久 commit，网络响应丢失可安全继续。所有 KS 按 25 点批量读取，无全包截断。

## 结果与研究反馈

UI 通过 owner-scoped `/api/projects/:projectId/learning-mounts?versionId=...` 读取精确版本状态。existing/created 是正式回执，v1 名称匹配只作预览。pending/running/retry 持续轮询，failed 可显式重试。superseded 说明该对话更新版本负责挂载。

`readAutomaticMountResearchFeedback(projectId,versionId)` 返回原 roleNodeId、reason、researchGoal 与候选，用于定向补全。needs_definition / needs_evidence / needs_decomposition 不算正式成功，不能通过伪造定义或来源消除。最终挂载不能反向宣称岗位研究质量全通过。

可研究的三类缺口或 no_learning_points 会由原 worker 在同一 owner、conversation 和精确 version 上最多接续一个研究任务，预算 maxRounds=2、sourceLimit=12、maxWorkItems=8。持久 role_learning_repairs 保存稳定子任务 ID；无活动任务、对话仍处迭代态且仍固定该版本时才能原子入队。中断准备可租约恢复，最多三次准备尝试；真正研究仍只有一个子任务。子任务产出的新版本再次正式挂载，但通过 source_run_id 血缘阻止继续生出下一轮补研。版本或归属变化、切换讲解、缺失原授权、中央撤权均停止接续，并留下可见原因。

补研复用完成生产任务保存的服务端身份记录，并通过原挂载回执重放重新验证中央活动账号与私有包权限。冷启动已提交部分版本后失败时，只有服务端任务结果明确记录 partial=true 且 projectVersionId/snapshotId 与该挂载精确一致，才可接续；失败状态保留，不泛化授权其他失败任务。供应商配置来自原密封配置；完成任务已清理密封配置时使用既有服务端配置，不伪造凭据，也不转发浏览器 Cookie 或授权头。只构造固定内部 snapshot-iterations 请求，走同进程可信 dispatcher，再由原执行路由验证 scope。原任务关闭联网时不会自动打开联网，而是复用该版本已核验的来源文本。发现 GET 仅查库；中央复核与入队在既有 mount POST worker 槽执行。missing_resolution 等协议缺口不会反复消耗研究预算。

相同类型、名称/别名与显式 scopeNote + assessmentCriteria 复用节点；纯摘要更新不重复建点。自动模式下多个完全等价候选按已持久同主体内容 ID、官方节点、namespace/id 稳定顺序选择；手动歧义预览保持原行为。新节点内容 ID 碰撞时依次延长哈希，再使用稳定后缀，检查源图和本批节点并在后续重用，不覆盖旧节点。定义变化是不同点，历史节点与学习记录保留。找不到可靠容器时建立本人 graph_extension 命名空间下的岗位学习域，通过 standaloneRoots 明确声明并连接新原子点；不强行等价或虚构官方归属。

## 部署和数据边界

- 两服务复用仅服务端 `ROLE_ATLAS_GATEWAY_SECRET`（至少 32 字节），Role 需 `LEARNFLOW_BASE_URL`；生产使用 HTTPS 固定源站。内部同机容器允许 `http://learnflow-backend:8000`。不得放入 PUBLIC/VITE 配置。
- 部署中央 API/接收校验器与 Role worker 同一版本；中央既有 init_db 创建 `curriculum_automatic_operations`，Role 既有 ensureAppSchema 创建 outbox。无需迁移旧学习数据；旧包不批量回填。
- 自动挂载只到中央账号源图；桌面本地身份不能签发中央主体。没有新增桌面中央登录或把本地令牌转发到服务端。
- 正式 source commit 沿现有事务生成零核审计事件，所有回执 masteryUnchanged=true。没有个人学习状态变更。

## 验证

Role 测试覆盖签名正文、主体、有效期、固定源站、凭据隔离、错误回执、真实 SQLite outbox 与会话末版合并、私有制品恢复/发布门禁、无锚点合法容器、精确复用与定义变更保留旧节点。自动补研使用真实 SQLite、生产 dispatcher 与入队事务验证并发 CAS、密封配置、可信请求身份、执行正文一致、重启恢复和一次后代限制；不调用真实模型。中央测试覆盖 active account、CSRF/浏览器凭据拒绝、真实源图落库、权限重检、161 点分批、幂等/响应丢失/并发 CAS、零 KernelMutation 及回执重放。测试使用隔离数据库与 mock 网关，不调用生产账号写入。
