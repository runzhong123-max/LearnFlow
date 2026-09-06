# 学习路径检索与个人节点提案

## 目标

学习路径检索要回答“目标在图中的哪个节点”，不能替代路线规划，更不能推断掌握。运行顺序固定为：

```text
自然语言目标
  -> 精确读取（ID / 标题 / 别名）
  -> 未命中才做模糊检索
  -> resolved：读取邻接关系并规划
     ambiguous：请学习者选择
     not_found：联网研究图谱缺口
  -> 结构化来源通过主题/权威/独立性门槛且无重复节点：个人节点 proposal
  -> 学习者确认：正式事件网关写入个人覆盖层
```

## 三个模型可见工具

| 工具 | 输入 | 输出 | 硬边界 |
|---|---|---|---|
| `lookup_learning_path_node` | 原始目标、候选上限 | 精确候选与匹配原因 | 只比较稳定 ID、标题、别名；不自行模糊匹配 |
| `search_learning_path_graph` | 精确未命中的目标、候选上限 | 候选、分数分解、`resolved/ambiguous/not_found` | 确定性排序；歧义不得生成路线 |
| `propose_personal_path_node` | graph gap、建议锚点；来源由 Harness 注入 | 可检查节点提案及证据评估 | 模型不能提供 URL；必须通过主题、权威、独立性和重复检查；不写图或五核 |

旧 `read_learning_path` / `vnext_learning_path_graph_reader` 只保留为兼容调度器，不进入模型 tools
列表。Agent Runtime 在执行任何模型工具调用前还会检查当前 mode/scope 的工具 allow-list。

## 模糊检索策略

实现位于 `frontend/src/learning-path-retrieval.ts`。查询先做 Unicode NFKC、大小写、常见繁简字和
Agent 术语归一化，然后分别计算：

- 词法身份与包含关系；
- Damerau-Levenshtein 与双字组 Dice 拼写相似度；
- 领域与摘要 token 重叠；
- 三路独立排名的 reciprocal-rank-style 融合。

原始异构分数不会直接互比。最终决策还使用头部差距、短词宽泛歧义和复合主题惩罚：例如
“安全”必须保留多个候选；“量子机器学习”不能只因为包含“机器学习”就被判定为同一节点。
`vnext-learning-path-retrieval-v3` 还执行意图包装清理、繁简课程术语归一化和少量可解释的常见错字
归一化。精确读取先尝试原始输入，再尝试抽取出的主题，因此“研究课题与学位论文”这类课程标题
不会被误当成“研究”意图；“我想用半年系统学习 Agent 开发”仍能抽取出 `Agent 开发`。策略版本或
阈值发生变化时必须增加真实语言行为测试。

## 个人节点证据门槛

搜索工具返回 `title / url / snippet / source / quality / role`。Agent Runtime 保存本回合真正执行过的
结构化结果，只把它们注入提案工具元数据；模型调用参数中的 URL 没有证据效力。确定性评估要求：

- 只接受公开 HTTPS 地址，拒绝 localhost、私网和缺少标题/摘要的条目；
- 标题、摘要或来源必须覆盖目标主题的中英文关键词；
- 官方或学术来源中至少一条通过，或者至少两条不同主机的独立来源通过；
- 社区文章和代码仓库需要更高的主题覆盖，不能单独证明一个课程节点；
- 只给 URL、拿数据库页面证明量子机器学习、或复用旧回合未知 URL，均返回失败而非弱提案。

通过门槛后，提案仍固定 `confirmationRequired=true`、`masteryUnchanged=true`。与现有节点仅有词法
复合关系时可以建议软前置；普通语义接近只建议共学，不能把搜索相似度伪造成先修关系。

## 路线与层次语义

`vnext-learning-path-planner-v2` 对 resolved 目标执行：

1. 递归收集硬前置（有界深度）；
2. 加入目标的直接软前置；
3. 对硬/软前置诱导子图做确定性拓扑排序；
4. `co_learning` 仅保留为并行建议，不参与先后排序。

因此“优化方法”必须位于“深度学习”之前，“数字逻辑”必须位于“计算机组成原理”之前。高职、
本科、研究生筛选首先展示该层课程，再递归加入这些课程所需的硬前置；跨层加入者在 UI 标为
“补充前置”，避免课程可见但先修课消失。

官方图当前包含 108 个课程节点、187 条关系，并补充十二个培养方案经常缺失但行业常用的稳定域：
工程调试与可观测性、可靠性与生产事件响应、安全软件开发与软件供应链、信息检索、数据治理与隐私、
AI 系统评测、API 设计与演进、性能工程、平台工程、软件维护与演化、开源协作、数值与科学计算。

## 状态与证据边界

- 检索结果是 Structure 参考，不是正式路线，也不是 Knowledge mastery。
- 个人节点 proposal 固定 `confirmationRequired=true`、`masteryUnchanged=true`。
- 正式加入继续走 `vnext_personal_path_node_added -> five_kernel_reducer`；提案阶段无事件写入。
- 自报“学过/掌握”最多形成带来源的 exposure，不能自动提升验证等级。
- 搜索片段是不可信外部内容，只作为节点关系和命名的 provenance。

## 最小验收矩阵

| 场景 | 预期工具链 | 禁止结果 |
|---|---|---|
| `machine-learning` / `机器学习` / 已登记别名 | exact | 额外 fuzzy 或联网 |
| `操作系統原里` | exact miss -> fuzzy resolved | 直接 graph gap |
| `安全` | exact miss -> fuzzy ambiguous | 自动选网络安全 |
| `量子机器学习` | exact miss -> fuzzy not_found -> search -> proposal | 折叠为机器学习；直接写图 |
| 模型请求旧 `read_learning_path` | runtime blocked | 绕过当前工具目录 |
| proposal 只有 URL | rejected | 无结构化 provenance 的个人节点 |
| proposal 来源与主题无关 | rejected | 以权威性替代相关性 |
| 本科/研究生层次隐藏硬前置 | 补入并标记“补充前置” | 课程可见但路线断裂 |
| 深度学习路线 | 优化方法先于深度学习 | 按手工 order 逆序 |

前端行为测试位于 `frontend/server/learning-path-graph.test.ts`、
`frontend/server/learning-path-production-eval.test.ts` 与 `frontend/server/agent-runtime.test.ts`。
生产评测逐一验证所有官方标题、代表性学习者语言、每个目标的拓扑路线和三种学历视图的硬前置闭包；
注册漂移由
`backend/tests/test_architecture_registry.py` 检查。
