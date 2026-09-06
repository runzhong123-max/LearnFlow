# Search Harness v2 实现技术文档

## 1. 目标与架构位置

Search Harness v2 为 LearnFlow 的讲解、规划、项目 Tutor 和原子学习任务提供外部计算机知识证据。它由 `learning_design_agent` 负责，`tutor_agent` 决定何时调用和如何把证据组织成教学回答。

本次没有新增主 Agent，也没有新增五核写入路径。当前来源合同与架构注册表版本为 `2026-08-31.2`；Search Harness 仍保留 v2 外部工具面，并与 `source-profile-v1` / `domain-knowledge-packet-v2` 对齐。

## 2. ACI 与职责边界

模型只看到两个目标级工具：

```text
search_computer_knowledge(query, depth?)
read_web_evidence(url, query)
```

`search_computer_knowledge` 负责“找什么”；`read_web_evidence` 负责“读取哪个已找到页面”。Provider API、搜索垂直、缓存、熔断和排序都不是独立模型工具，避免模型在低层操作上浪费轮次。

Action Board 关系：

```text
coordinate_vnext_agent_turn
  └─ search_computer_knowledge
       └─ read_web_evidence
```

两项 capability 的 `evidence_target` 均为空。它们可影响当轮回答，但不能直接产生 `EvidenceEvent`、`KernelMutation` 或掌握结论。

## 3. SearchPlan v2

`buildSearchPlan()` 生成版本化计划：

- `intent`：explanation / comparison / troubleshooting / implementation / research / current。
- `facets`：该意图必须覆盖的证据角度。
- `facetQueries`：受深度预算约束的查询。
- `sourceLanes`：authority / general / community / repository / research。
- `budgets`：查询、结果、页面读取与补搜上限。
- `privacy`：是否发生敏感信息清理及清理数量。

意图优先级把明确比较放在一般失败词之前，因此“比较 PPO 与 DQN 的失败边界”仍是比较任务，而不是排障任务。

## 4. 召回、读取与证据包

### 4.1 召回

召回由以下来源并行组成：

- 内置可信目录及命中页面的有界读取；
- Exa、Tavily 或 Jina 中的一个主搜索后端；
- Wikipedia、Stack Exchange、GitHub、arXiv 等意图相关垂直来源。

有搜索凭据时，主后端可执行多个 facet 查询；无凭据时只执行一次合并主查询，避免公共端点重复超时。

### 4.2 Provider 状态机

每个 Provider 独立记录：

```text
completed | empty | failed | circuit_open
```

只有暂时性失败计入熔断。连续两次失败后进入冷却；成功或合法空结果会清除暂时失败计数。这样可以区分“确实没找到”和“基础设施不可用”。

### 4.3 混合重排

`rankSearchSources()` 使用可测试的确定性信号：

- 来源权威等级；
- 来源角色是否适合当前意图；
- 查询词重合；
- 可信目录命中；
- 摘要完整度；
- 当前/研究问题的发布时间；
- 新增证据 facet 数量；
- MMR 风格相似度惩罚和单域名上限。

排序目标不是单纯相关，而是给 Tutor 留下互补证据。

这些信号在进入领域 Packet 时归一为多维来源画像，而不是永久合成为一个质量总分。不同意图选择不同维度：规范核对看可信度和版本，学习规划看全面度和教学适配，排错看真人观点和可复现性，近期变化看时效。Search 摘要只能发现候选；`read_web_evidence` 捕获的原文才会形成临时 SourceVersion。社区材料在 Packet 中进入带归因 `viewpoints`，除非另有事实证据，否则不能满足关键 Claim 覆盖。

### 4.4 覆盖审计与补搜

`assessEvidenceCoverage()` 按 facet 输出已覆盖数量、比例和缺口。标准与深度搜索最多执行一次缺口补搜；主 Provider 已失败时不会继续用同一 Provider 浪费预算。

结果序列化为 `learnflow.web-evidence-bundle.v2`。`deep` 额外产生 `learnflow.research-brief.v1`，按证据角度列出来源索引，并明确 `not_semantically_adjudicated`，避免把摘要索引冒充研究结论。

## 5. 页面读取工具

`read_web_evidence` 只能读取当前 Agent 轮中由搜索工具返回的 URL。运行时把候选 URL 与候选元数据放入下一次工具调用的 `meta.sourceUrls / meta.searchSources`。

读取前执行：

1. URL 规范化；
2. HTTPS 检查；
3. 当前轮 allow-list 检查；
4. localhost、私网 IPv4/IPv6 和本地域名拒绝；
5. 重定向后的地址再次检查；
6. 响应体、超时和摘录长度限制。

HTML 会去掉脚本和样式，再按查询词、机制词与段落长度抽取最相关窗口。返回值始终带“外部内容是不可信数据”的指令边界。

## 6. Tutor ReAct 与上下文管理

推荐循环：

```text
Observe：读取正式五核/任务/项目等必要上下文
Decide：判断内部知识是否足够，选择搜索深度
Act：search_computer_knowledge
Observe：查看候选、Provider 状态、覆盖缺口
Decide：选择 1–3 个关键页面
Act：read_web_evidence
Observe：获得问题相关摘录
Answer：讲解 + 精确引用 + 缺口声明
Verify：引用 URL 与覆盖声明审计
```

候选搜索只把紧凑摘要放进上下文；只有被选择的页面才进入较长摘录。这样把“广召回”和“深阅读”分离，避免把十几个网页全文塞进模型上下文。

终态验证会拦截：

- 搜索后完全没有引用；
- 只在搜索证据上下文中出现未返回的 Markdown URL；
- 搜索状态为 partial/empty 却隐藏证据缺口。

若同一轮还读取了项目资料、领域文件或正式文件，其他来源 URL 不会被错误当成搜索伪造链接。

## 7. P0–P2 落地映射

### P0：可靠基础

- 隐私清理、安全 URL、来源分层；
- Provider 状态、超时、熔断、缓存；
- 确定性意图、预算和引用白名单；
- 注册表、Action Board、零五核写入边界。

### P1：讲解质量

- 多意图、多 facet 检索计划；
- 权威性 + 相关性 + 时效 + MMR 风格重排；
- 覆盖审计与最多一次缺口补搜；
- 搜索候选与页面读取分离；
- Agent 终态引用和缺口校验。

### P2：有界深度研究

- `deep` 查询、结果、页面与研究轮次预算；
- arXiv 等研究垂直；
- 结构化研究简报；
- 明确保留冲突未语义裁决和证据缺口；
- 离线 120 案例与真实网络六场景测评入口。

P2 不是开放式无限浏览，也没有引入独立 research agent。

## 8. 主要实现文件

- `frontend/server/computer-knowledge-search.ts`：计划、召回、读取、排序、覆盖、缓存与熔断。
- `frontend/server/tool-runtime.ts`：两个模型工具的执行与结构化观察。
- `frontend/server/agent-runtime.ts`：有界 ReAct、候选 URL 传递与终态验证。
- `frontend/src/tutor.ts`：引用补全和引用审计。
- `frontend/src/tooling.ts`：来源与运行记录 schema。
- `backend/app/services/architecture_registry.py`：工具、ACI、工作台、owner 与零 Kernel target。
- `backend/app/services/action_board.py`：capability 与下一步 affordance。

## 9. 配置、运维与后续演进

可选环境变量：`EXA_API_KEY`、`TAVILY_API_KEY`、`JINA_API_KEY`。正式环境至少应配置一个受支持的主搜索 Provider；公共 Jina 仅作为降级路径。

建议监控：非空率、覆盖率、Provider 成功率、熔断率、P50/P95 延迟、页面读取成功率、终态引用校验失败率。下一阶段应优先实现共享缓存/熔断状态、逐句引用支持度评测和带真实 Tutor 模型的教学回答人工评审，不应继续无边界增加 Provider。
