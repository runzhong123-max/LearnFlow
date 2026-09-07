# Role Atlas · 第一轮岗位智能体

本应用现位于 LearnFlow 仓库的 `apps/role-atlas/`，从这里独立安装依赖、构建和启动。源码导入版本与维护边界见 [同仓接入说明](../../docs/implementation/2026-09-04-role-atlas-monorepo.md)。

Role Atlas 把静态、版本化的 **Role Package** 作为唯一事实源。一个岗位包内部只有证据、语义链和事理森林三个命名空间；图谱、卡片、JD、学习路径、对话上下文和报告都是它的投影。当前重构总览见 [Role Atlas vNext](docs/role-agent-vnext.md)。

当前内置实例为“大模型应用工程师”岗位包 `1.2.0`，快照时点 `2026-08-19`。旧制品中的语义包与事理包会在读取边界无损归一为同一个岗位包身份。

## 本轮已经形成的闭环

1. 中间图谱展示岗位、产业链、岗位群、任务、能力、能力单元与知识技能。
2. 点击节点查看卡片；拖拽或点击可把节点作为版本化引用放入对话。
3. 事理森林展示工作场景、事件阶段、条件分支、返工环、交付物和任务桥接；场景或事件也能拖入对话。
4. 主 Agent 固定一个具体岗位包版本，生成最多四次有明确目的的工具调用计划。
5. 主 Agent 只暴露六个感知工具；冷启动、迭代、节点深化和工作区接入作为独立长任务 Skill。
6. 覆盖检查生成统一引用注册表，并按任务/事理优先级组装上下文。
7. 适配器分别转发供应商的 `reasoning_content` 和 `content`；推理通道默认折叠，只作为调试信息，不冒充系统计划或证据。
8. 前端逐项呈现快照固定、规划、工具、耗时、上下文组装、引用与正文。
9. `/projects/new` 已接入完整岗位包冷启动 Skill：用户简报与资料经过共享证据层，语义 Lane 和事理 Lane 并行生成，随后编译一个包含证据、语义、事理三命名空间的岗位包。
10. 岗位项目、会话、消息、BuildRun、BuildEvent 与候选版本写入 D1；项目和会话可以新建、重开、切换并恢复历史。
11. 冷启动默认使用智谱 GLM 网络搜索，结果经过质量排序、去重和定向正文抽取，并保留来源与请求索引。旧厂商适配保留用于兼容显式配置。
12. “继续研究”与“风险修复”已合并为 `迭代岗位快照` Skill，支持自动发现、目标增强和纯定向研究三种发起方式；每轮统一检查结构、补证、扩展/刷新/实例化、确定性修复并评估信息增量。
13. 冷启动和迭代完成后都会运行非阻断结构检查：只有协议不变量阻止新快照写入，语义重合、知识技能覆盖不足、事理或证据缺口会保留为发现、工作项和研究主题。
14. 任意岗位项目都可启动“接入真实工作区” Skill：GitHub、DevGPT、SWE-bench、缺陷基准、事件日志、遥测或 SOC 案例先归一化为 Workspace Package，安全扫描后并行提取事件 episode 与独立产物，再对齐典型任务并通过统一迭代实例化语义图谱、事理森林与证据层。
15. 冷启动、统一迭代和工作区实例化现在都通过同一提交服务形成不可变 ProjectVersion；历史版本按稳定对象 ID 生成语义 Diff，支持独立 Tag 和非破坏性恢复。
16. `/projects/:id/versions` 提供 Static Role Package 编译、硬不变量校验、发布、导出与回滚；失败 Release 不会移动当前发布指针。
17. `/registry` 提供岗位身份、别名、行业/地区/学段/人群、维护、托管、许可、证据策略、兼容性、推荐版和历史版的 Package Registry，并支持 JSON/ZIP 导入导出。

## 模型配置

打开 `/settings`，可选择：

- Xiaomi MiMo：`mimo-v2.5`、`mimo-v2.5-pro`
- DeepSeek：`deepseek-v4-flash`、`deepseek-v4-pro`

模型与搜索凭据由服务端统一配置。搜索默认 `ROLE_ATLAS_SEARCH_PROVIDER=glm`、`ROLE_ATLAS_SEARCH_ENGINE=search_pro`，密钥使用 `GLM_API_KEY`（兼容 `ZHIPU_API_KEY`）。配置写入不提交的 `.env.local`，重启后生效；状态接口只返回是否已配置，不下发密钥，也不接受客户端覆盖服务端凭据。

新建岗位和迭代页面支持附件拖动上传、公开 HTTPS URL、文本三种可选资料。附件先在浏览器提取文字，用户可预览、移除，加入清单后随本轮提交。支持格式、限制、GLM 官方服务特点与验证边界见 [GLM 检索与资料输入](docs/glm-search-and-materials.md)。

## 主 Agent 工具

主 Agent 对官方岗位包和项目岗位包使用同一个 `SnapshotRoleRuntime`。正常对话只会规划以下六个工具；`POST /api/role-tools` 仍保留完整低层工具面用于调试和兼容。

| 工具 | 用途 |
|---|---|
| `read_role_objects` | 批量精确读取节点或字段，支持一跳扩展与部分成功 |
| `search_role_knowledge` | 跨证据、语义与事理命名空间检索并消歧 |
| `query_role_graph` | 邻居或路径查询，深度硬限制为 2 |
| `inspect_role_evidence` | 证据追溯、充分性检查与张力检查 |
| `trace_work_process` | 沿事理关系追踪过程并保留语义任务桥接 |
| `audit_role_package` | 联合扫描完整性、语义、证据、时效与事理风险 |

`POST /api/agent` 返回 v1.1 NDJSON 事件流。供应商的思考增量映射为 `reasoning.delta`，正文增量映射为 `answer.delta`；两者一收到就转发到浏览器。引用注册表仍供模型和用户使用，但不再拦截或改写正文。

`POST /api/build-runs` 返回 v2.0 NDJSON 构建事件流。它不会直接修改已发布岗位包，而是在一次候选 BuildRun 中生成来源分段、证据绑定、语义图谱、事理森林、岗位快照、审计结果和统一岗位包 manifest。没有独立来源或只有推断型事理模式时，校验器会保留候选状态并生成研究缺口。

`POST /api/snapshot-iterations` 返回统一岗位快照迭代 NDJSON 事件流。运行先固定一个不可变快照并建立契约，再执行结构检查、工作组合、定向检索、候选重建、约束聚类/安全修复和回归评估。有效增量生成带 revision 的新静态快照；无增量时仍形成一个指向原静态快照的 ProjectVersion，以完整记录成功运行，但不会复制或覆盖静态快照。产品入口见 [岗位快照迭代 Skill](docs/snapshot-iteration.md)。

版本、Tag、发布与 Registry 的产品入口分别为 `/projects/:projectId/versions` 和 `/registry`。Static Role Package v3 的 JSON/ZIP 制品按内容寻址保存；发布引用使用 `packageId + packageVersion + snapshotId` 精确解析。协议见 [项目版本、Tag 与岗位包发布](docs/versioning-and-publication.md) 和 [岗位包注册中心](docs/package-registry.md)。

`POST /api/workspaces/ingest` 独立运行工作区归一化、安全扫描、双 Lane 抽取和任务对齐；`POST /api/workspace-upgrades` 随后把可追溯 `workspace_observation` 交给统一快照迭代，形成新的候选版本。协议、适配器、真实性等级和工具见 [真实工作区接入与岗位快照实例化](docs/workspace-ingestion-and-instantiation.md)。

## 数据同步

岗位事实仍由独立岗位包维护：

```text
../role-snapshot/packages/llm-app-engineer-v1.1
../role-snapshot/packages/llm-app-engineer-process-v0.1
../role-snapshot/packages/llm-app-engineer-v1.2
```

同步时会先校验 manifest 中所有规范文件的 SHA-256，再生成运行时只读数据：

```bash
npm run role:sync
```

输出包括 `lib/role-package/generated-data.json` 和前端需要的 `public/data/*`。如果快照 ID、校验状态或清单哈希不一致，运行时会 fail closed。

## 本地运行与验证

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

首次运行使用已纳入版本管理的岗位包和 `public/data/`，不依赖外部 `role-snapshot` 目录。`npm run role:sync` 仅在另行准备前述原始岗位源时运行；`npm run learning-path:sync` 默认从同仓 LearnFlow 读取官方学习路径，可用 `LEARNFLOW_ROOT` 覆盖根目录。

自动化测试覆盖主 Agent 六个感知工具、兼容层低级工具、统一包版本化引用、任务—过程联合读取、事理森林、过期引用、调用去重、长任务日志提交顺序、LangGraph 事件顺序、双通道 SSE 解析、Tavily 两阶段检索、来源去重、弱相关过滤、乱码降级和结构化抽取归一化。

## 第一轮边界

- Agent 采用确定性路由器选择岗位工具，模型负责有据综合，不负责直接决定任意代码或网络调用。
- LangGraph 不使用进程内 `MemorySaver` 冒充生产持久化；D1 追加事件、阶段检查点与不可变版本共同构成长任务恢复依据。
- 岗位包内部检索与 GLM 等外部联网研究是两条独立通道；联网结果必须经过来源摄取、质量排序、稳定分段和证据绑定后才能进入候选包。
- 冷启动已经具备联网来源连接器、持久化 Build Store 和候选版本恢复；真实工作区现支持 JSON 导出文件、八类适配器和持久化升级运行。版本、语义 Diff、Tag、Static Role Package 编译/校验/导入/导出、发布事务、历史恢复/回滚和单实例 Registry 已完成。本地目录/ZIP 工作区大文件分片、远程 Registry 联邦、制品签名与多组织权限仍待实现。

## 下一轮：新项目与冷启动设计

- [新建岗位项目：产品与交互规格](docs/new-project-experience.md)
- [冷启动 Agent 编排与候选图谱设计](docs/cold-start-orchestration.md)
- [Build Event Protocol](docs/build-event-protocol.md)
- [项目版本、Tag 与岗位包发布设计](docs/versioning-and-publication.md)
- [岗位包注册中心协议](docs/package-registry.md)
- [冷启动能力实施路线](docs/cold-start-implementation-roadmap.md)
- [冷启动图谱构建算法研究](docs/cold-start-graph-algorithms.md)
- [完整岗位包冷启动 Skill 实现](docs/cold-start-skill.md)
- [岗位快照迭代 Skill](docs/snapshot-iteration.md)
- [岗位事理图谱研究与协议草案](docs/work-process-event-graph-research.md)
- [统一岗位包、联合工具与事理森林实现](docs/composite-snapshot-and-tools.md)
- [Tavily 联网证据获取策略](docs/tavily-retrieval-strategy.md)
- [真实工作区接入与岗位快照实例化](docs/workspace-ingestion-and-instantiation.md)
