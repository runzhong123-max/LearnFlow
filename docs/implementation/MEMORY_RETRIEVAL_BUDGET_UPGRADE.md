# 完整记忆检索升级：相关性、去重与关系预算

2026-09-08。适用 Web 与 Desktop；共享核心 `0.2.2`，检索策略 `relevance-budget.v1`，两端 registry `2026-09-08.5` / `2026-09-08.5-desktop`。

## 问题与结果边界

原检索把活跃 Claim 固定加 3 分、热头引用加 2.2 分，先装满节点再加入关系，超预算时优先丢弃关系。相同事实也可能同时在热头正文和节点正文出现。在先前的固定合成检索实验中，2,800 token 下完整系统的必要证据平均召回率为 96.59%，仅事实方案为 98.86%；完整系统又在多事实汇总中优于仅事实。这说明读取层存在效率问题，不能据此否定 Module/Claim 或推出真实学习效果结论。

本次改进读取与组装，保留完整 Fact → Module → Claim 存储。最终实验数字与实际验收见 [验收报告](MEMORY_RETRIEVAL_BUDGET_VERIFICATION.md)。

## 已实现的读取流程

1. **先隔离，再取候选**：保持 learner、project、checkpoint、session、归档、有效状态和答案字段边界。精确主题、缓存引用、词项匹配和最近记录保持有界候选通道；每通道最多 240 节点。主题和词项通道在窗口截断前按查询词项匹配数量排序，英文不区分大小写，避免精确旧记录被大量近期泛化记录挤掉。
2. **相关性分层**：显式主题匹配优先于词项匹配，之后才以显著性、当前范围、时效和小幅 Claim 奖励排序。自动加入的 project/checkpoint 坐标只是范围上下文，不等于用户指定的主题；缓存引用只记录召回理由，不再加排序分。定向查询中完全无匹配的节点不会用来填满上下文；无定向查询保留概览读取。
3. **热头作为索引**：当前深读核的热头只保留引用和有界 facet，正文统一在 items/paths 呈现。非深读核仍可提供相关的有界摘要，Human 继续只提供经过 scope/TTL 校验的类型化适配。
4. **保守去重**：只合并同一 Module 版本、同核同主题同 scope 同状态且完整原文相同的 Module/Claim。全文比较在 900 字显示裁剪之前进行。共享来源事实或文字前缀相同不足以去重；两次尝试、辅助等级、时间和原始证据不合并。
5. **关系参与预算选择**：先从有界高排名候选发现一跳边（最多 80），纠正/冲突和因果依赖优先于同主题/巩固关系。选择一个节点时先尝试加入它的有用语义路径，再考虑低排名背景节点。剩余预算才用于增加有信息增量的支持/版本关系。所有选择通过相同完整内容体 token 估算，不再先装入超预算路径再统一删除。
6. **路径可追溯**：端点保留 status、occurred_at、原子事实 evidence_grade/source_event_id。路径与端点实际使用的事件加入 manifest.evidence_ids；superseded 端点只作为纠正/冲突历史出现，不作为当前事实。
7. **概念图使用相同过滤门**：ContextPacket 附带的个人概念图接受同一节点过滤器，在形成概念、统计和摘要之前应用检索相关性与敏感/归档/scope 边界，避免旁路重新带入被过滤节点。

这是确定性、有界的贪心组装，并非全局最优背包算法。优先级表达当前已有政策，没有 LLM 评分、额外 Agent 或向量数据库。

## Contract impact 与兼容性

- `five-kernel-context.v2`、`memory-item.v2`、现有 API、policy ID、Agent/Kernel/Event schema 保留。
- manifest 增加 `retrieval_version`，omitted 增加无关/重复摘要过滤计数；关系端点增加时间和证据来源字段。旧字段和兼容投影适配器保留，消费者可忽略新字段。
- snapshot 哈希纳入检索策略版本，升级后同一查询可获得新的 snapshot；不改写历史快照。
- 原热头 summary 不再重复深读正文；需要正文的调用方应读取既有 items/paths。两端前端已有相关测试验证兼容消费。
- 原个人概念图读取函数增加可选 `node_filter`；独立图谱工作台未传入时维持原行为，ContextPacket 显式提供统一过滤器。两端 adapter 同步修改。
- 注册表更新既有 `five_kernel_retriever` / `context_packet_assembler` 的实现说明并提升版本；共享核心版本升为 `0.2.2`。没有新增 capability、主 Agent、事件或持久化表。
- 无 EvidenceEvent、reducer、KernelState、合成门槛或评分变化；无数据迁移、模型调用或日常数据库操作。
- 极小自定义预算仍按字段降级，若连固定控制投影都装不下则明确拒绝，不返回伪称满足预算的包。内置预算保持不变。token 是当前字符估算口径，不是真实模型 tokenizer 或整个 HTTP JSON 大小。

## 测试与复现

两端新增 `tests/test_memory_retrieval_budget.py`，独立于原消融模板，覆盖低预算依赖+纠正共存、大量支持边干扰、旧精确词项、无关热摘要、同版本去重、相同前缀不同尾部不去重、辅助等级/时间保持、关系与概念附带内容的 scope/敏感过滤、完全无匹配查询。

```bash
(cd backend && venv/bin/python -m pytest tests/test_memory_retrieval_budget.py tests/test_five_kernel_context.py tests/test_memory_upgrade.py tests/test_architecture_registry.py -q)
(cd apps/desktop/backend && venv/bin/python -m pytest tests/test_memory_retrieval_budget.py tests/test_five_kernel_context.py tests/test_memory_upgrade.py tests/test_architecture_registry.py -q)
python3 scripts/check_shared_contracts.py
npm --prefix frontend run test:profile
npm --prefix apps/desktop/frontend run test:profile
```

固定合成消融驱动已收录到 `scripts/evals/memory_retrieval/`，保留原 1.1 数据、评分和协议，仅把默认仓库路径改为可移植路径。每次必须使用新的结果目录；脚本自带 SQLite 临时目录和网络拒绝审计：

```bash
backend/venv/bin/python scripts/evals/memory_retrieval/run_ablation.py --output /tmp/learnflow-ablation-web-upgraded
apps/desktop/backend/venv/bin/python scripts/evals/memory_retrieval/run_ablation.py --host "$PWD/apps/desktop/backend" --output /tmp/learnflow-ablation-desktop-upgraded
```

默认每端 12 条合成轨迹 × 14 类查询 × 6 组 × 2 档预算 × 3 次重复。旧实验是回归集，不是升级后的独立保留测试集。新增边界用例是开发回归测试，也不冒充真实用户评测。

## 当前限制与后续验证

- 中文词项为二元切分，弱词项仍可能召回无关背景；无匹配回退只对真正零词项匹配生效，不等于解决语义拒答。
- 240 节点/通道、80 条候选边、一跳扩展等上限仍存在；密集关系、超长历史和大量同分主题可能截断。
- 未实现语义别名检索、自适应二次检索、跨主题长尾推理或摘要对任意事实的语义覆盖去重。
- 排序更精细会增加 SQL 与组装成本，应与召回、token 和延迟一起评估；不能只展示有利指标。
- 后续需冻结新的自然语言、多会话、多次纠正与大规模单用户历史保留集，再决定二次检索与向量召回是否必要。

本轮在独立 worktree 验证，无部署、无安装替换、无真实学习库迁移；与其他任务的本地改动隔离。
