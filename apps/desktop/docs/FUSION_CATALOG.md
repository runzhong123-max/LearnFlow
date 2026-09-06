# 两仓库并行参考目录

LearnFlow 与 [killoppen/-](https://github.com/killoppen/-) 保持两个独立仓库、两套提交历史和各自的产品节奏。本文只登记已经验证并由 LearnFlow 自主实现的灵感映射；不自动同步代码，不合并仓库，也不复制第二套状态权威。

## 并行原则

- 两个仓库互不作为对方的开发分支、submodule、发布源或数据库权威。
- 可以只读研究交互和产品逻辑；吸收灵感时按 LearnFlow 的三类主 Agent、五核、事件链和安全边界重新实现。
- 禁止为了“保持同步”自动 merge、rebase、cherry-pick、批量复制文件或共享运行数据。
- 复制具体代码、资源或文案前必须检查许可证和来源；一般优先记录思路并独立实现。
- LearnFlow 内发生冲突时，以 `AGENTS.md`、架构注册表和架构权威文档为准，参考仓库不能覆盖这些契约。

## 已吸收并标准化（implemented）

| 参考仓库构件 | LearnFlow 落点 | 处理结果 |
|---|---|---|
| 学生画像分析工作流 | 五核 reducer + Memory Graph | 画像输出降级为可验证的记忆综合建议；Evidence Ledger 仍是事实源 |
| 学习阶段个性化讲解 | Learning Design Agent + Lecture/Concept workbench | 作为可选内容生成 adapter；输出必须带 provenance，不能证明掌握 |
| 测验后个性化纠错 | `RemediationStrategy` + `RemediationCase` + 练习/复习工作台 | 已实现答错、纠错、重做、变式和证据回写；策略不交给 LLM；不存在独立发布的 RemediationPanel |
| “换种讲法 / 看步骤 / 看示例” | 练习/复习工作台内的 remediation 流程 | 已实现并将被替换的讲法记录为 `remediation_mode_rejected` |
| 原题重做和变式题 | 概念/代码提交 API + variant API | 共用同一个 remediation case 和证据链 |
| 上游 `event_id` 去重 | `EvidenceEvent.client_event_id` | learner 范围幂等，避免重复副作用 |
| 本地 mock 演示 | `bash start.sh demo`、`/review` | 独立 seeded SQLite、无 LLM、离线可验收 |
| 目标图和连续学习路径 | Roadmap DAG + structure kernel | 统一到项目、路线、关卡和返回锚点 |
| VS Code 式多开与文件操作 | Tauri `desktop_workspace` + Explorer | 保留 LearnFlow Agent/五核/会话权威，只吸收标签、分屏和真实项目目录操作逻辑 |
| 学习专属文件 | `.lflecture/.lfexercise` + 自定义播放器 | 描述符只引用数据库对象；讲义版本化、练习草稿/批注隔离、正式提交才写证据 |
| 通用文件编辑 | Monaco + Markdown/PDF/image preview | UTF-8 轻量编辑与 Vim 模式；不内置 Python runtime、终端或任意编译 |
| Tutor 本地构建能力 | `local_agent_broker` + `LocalAgentProfile` | 本地代码 Agent 仅作 Tutor 工具；确定性选择、隔离副本、两次确认、hash 校验与批量回滚 |
| 对话式学习方法 | `LearningSkillRun` + `LearningTask` + `learning_skill_runtime` | 清晰讲解/苏格拉底/费曼/示例渐隐在 Session 内有界运行并绑定原子任务；推荐需确认，独立验证才进入能力证据链 |
| Teaching Contract 与内容门禁 | `Checkpoint.learning_contract` + `teaching_contract_gate` + `checkpoint_delivery_readiness` | Knowledge 通过可选 answer-free 输入契约辅助起点设计；包成熟度只由教学资产重建，任务就绪度只组合 learner-owned LearningTask；模型最多修订一次，失败仍交付答案安全 fallback，三者均不等同学习进度或掌握 |
| 视频推荐与内容核验 | `learning_video_search` + `learning_video_inspector` + `learning_resource_curation` | 模型只看“搜索候选/核验本轮候选”两个目标级只读 ACI；平台 API、字幕和 ASR 留在 Harness，标题与热度不能替代内容核验，观看不形成掌握 |
| 讲解优先的视觉教学 | `visual_teaching_composition` + diagram/animation generators | Playbook 先提交独立讲解并编译 VisualBrief，底层 Tool 只渲染；视觉失败合法降级为 `explanation_only`，不能撤销讲解或写掌握证据 |

## 已登记但未实现（optional_unimplemented）

| 参考构件 | 稳定声明 | 当前事实 |
|---|---|---|
| 星辰三工作流 | `workflow_gateway`、`external_workflow_rendering` | 仓库内没有可调用 runtime、API route 或 handler；只保留未来 adapter 契约，不进入 available 能力 |
| 工作流构建/校验脚本 | `workflow_validator` | 仓库内没有 builder/validator 实现；接入前不得报告可用 |
| 星辰 Studio | `xingchen_studio` | canonical frontend 没有 route/component，工作台不可用 |

外部 workflow 将来接入时必须先得到真实 implementation binding，并把输出校验为 LearnFlow
artifact 或 Event 输入；供应商名称、YAML 或清单字符串本身不能把 lifecycle 提升为 `implemented`。

## 统一分类

- **Tools**：能执行读取、生成、评估、事件写入或投影的运行构件。
- **Product skills**：由一个主 Agent 负责、组合多个 tools 的稳定产品能力，不等同于本地 Codex `SKILL.md`。
- **Workbenches**：用户或维护者操作能力的产品空间；候选外部 Studio 可以保留稳定声明，但只有 `implemented` 且 binding 校验通过的条目才可发布为 available。
- **Important events**：会影响教学连续性、证据、偏好或里程碑的只追加事实。

机器可读清单位于 `backend/app/services/architecture_registry.py`，API 为 `GET /api/architecture/registry`。
每个 Tool、Product Skill、Workbench、Capability 与 Event 都公开 lifecycle、binding 与 `available`；
`GET /api/architecture/validate` 分开报告 `schema_valid` 和 `implementation_valid`。外部 workflow
名称、供应商或版本可以变化，稳定 ID、证据语义和五核写权限不能随之变化。

## 暂不复制的部分

参考仓库的原生 HTML 页面、单文件 Python HTTP 服务和第二套 SQLite 学生模型不进入主运行时。它们已经对应到 React workbench、FastAPI 服务和五核 Memory Graph；并行保留会造成身份、事件和画像冲突。星辰 YAML 若未来作为部署资产接入，必须先实现并验证 adapter；在此之前它不是 available 能力，也永远不得成为 LearnFlow 的本地业务真相。
