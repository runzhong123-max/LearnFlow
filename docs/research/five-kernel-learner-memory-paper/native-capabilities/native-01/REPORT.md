# 五核原生能力契约核验结果

代码基线 `917b8a04e88c4f2afa7f72b477a127c3ef2249b7`；15 个预声明作者合成案例，15 个通过。
源码冻结后未变化：True；原始字节重开核验一致：False。

| 核 | 通过/案例 | 失败案例 |
|---|---:|---|
| structure | 3/3 | 无 |
| knowledge | 3/3 | 无 |
| human | 3/3 | 无 |
| value | 3/3 | 无 |
| practice | 3/3 | 无 |

原生行计数：{"events": 38, "attempts": 5, "mutations": 55, "facts": 78, "nodes": 78}。概念 API session 缺口 5 条。

所有失败和断言原值均保留在 aggregate.json；完整 Event/Attempt/Mutation/Fact/Node、路径 API 返回、上下文和真实计划保留在 native.jsonl.gz。

这是源链与确定性消费者的能力契约核验。通过说明所列具体输入被现有系统正确处理，不证明五核表示最优、通用检索优势或真实学习收益。

## 未覆盖与边界

- 15 authored synthetic cases, not statistical performance estimates
- No representation ablation, no traditional memory benchmark, no learning-outcome claims
- No LLM or human evaluation; actual deterministic consumer only
- Formal concept API has no session parameter; raw gap retained
- Learning path API is learner-global, not checkpoint-scoped
- Temporary controls intentionally form no Fact; native mutation/state route audited
- No positive stable mastery, true transfer, synthesis, long-tail retrieval or full graph quality study
