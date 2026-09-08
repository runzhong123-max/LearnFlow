# 记忆长尾检索升级

本次升级把上轮报告的五项建议落实到 Web/Desktop 共用的只读检索层。旧实现对原词、正文前段和近期候选更有利；长尾查询需要改变候选与预算分配，不能用增加摘要热度代替。

## Contract impact

共享核心 0.2.3，读取策略 `relevance-budget.v2`，Web registry `2026-09-08.6`、Desktop `2026-09-08.6-desktop`。同时对齐此前滞后的 pyproject 与 Python 包版本。稳定工具 `five_kernel_retriever` / `context_packet_assembler`、ContextPacket v2、EvidenceEvent schema 保持兼容；增量字段可被旧消费者忽略。没有表迁移，没有改动评分、掌握、归约或写入入口。

权威链仍为 EvidenceEvent → reducer → KernelMutation → KernelState → MemoryFact → MemoryModule → MemoryClaim。查询改写、摘要选择、路径和片段只决定当次读包，不构成学习证据。

## 实现与边界

| 建议 | 已实现 | 显式限制 |
|---|---|---|
| 查询归一与混合候选 | Unicode NFKC、casefold；11 组公开计算机术语双向别名；受限唯一单编辑/相邻换位错拼；subject、head、词项、近期、时间、错拼候选统一过滤重排；manifest 记录变换 | 不含 embedding/LLM 语义通道；有歧义、标识符、两次编辑拒绝纠正；词表、输入和候选扫描有上限，未覆盖术语不保证召回 |
| 原文分段与限定 | 最多 640 字符的确定性句段，目标窗口与“仅/尚未/未验证”等限定共同入包；保持 fact ID，正文 SHA256、字符数及原文偏移 | 不是生成摘要；长单句和很多限定仍可能装不全，`qualifier_spans_omitted` 明示；别名匹配与分段也不保证全自然语言语义正确 |
| 多样性与时间 | 历史/最初请求从同核同主题 active Facts 预留最早、中间、最新候选；分别加权；最新纠正锚点优先，隐藏目标不得影响加分 | 时间候选最多 48，仍受最终条目/预算限制；不是全历史分页，也不把 superseded 历史当当前状态 |
| 有界图扩展 | 第一跳白名单，BLOCKS/ENABLES 可到两跳；每端 SQL scope 与 Python 敏感过滤；循环剔除，完整前缀共同试装；纠正与依赖各预留机会 | 最多24根、32前沿、每根4扩展分支、768 incident候选行；每(anchor,关系类别)取近期6+最旧2；其他中间边可能漏检；不推断新边、不沿历史关系无限追溯 |
| 条件摘要与未覆盖 | 汇总偏好 Module/Claim，局部问题偏好 Fact；同版本重复摘要去重；弱相关候选淘汰；`direct_memory_evidence` / `evidence_gap` 公开缺少直接item | 该标记说明入包直接项，不是答案可回答性的保证；Human 控制指导可以继续存在；完整系统与 facts_only 必须分场景比较 |

图 `candidate_edges` 统计物化的 incident 行（同一边可能出现两次），不是独立边数。`max_depth_found` 是发现候选深度，不是最终包深度。`window_truncated`、`second_hop_branches_omitted` 和更新排序截断标记公开预算边界；SQL 窗口有界输出不等于数据库扫描复杂度恒定。

正文片段和路径来源元数据纳入统一 token 估算。估算延续原协议：JSON 字符估算，计入 heads、items、paths、概念图和教学指导；manifest/omitted 元数据外壳不在这个预算内，不可将其作为真实模型计费。Tutor 已有的 700 字符裁剪不会再截断 640 字符片段，双端工具消费契约测试注入测试包，检查来源与限定到达 observation；这不是浏览器与在线模型的端到端实验。

## 复现与验证

协议见 [PROTOCOL_LONG_TAIL.md](../../scripts/evals/memory_retrieval/PROTOCOL_LONG_TAIL.md)，结果见 [本轮实验报告](../competition/MEMORY_LONG_TAIL_REPORT.md)。共享一致性脚本新增读取策略、查询版本、两个工具合同和三个新 helper 的跨宿主检查。

```bash
python3 scripts/check_shared_contracts.py
backend/venv/bin/python scripts/evals/memory_retrieval/run_long_tail.py --repo . --host backend --output /tmp/new-memory-run
backend/venv/bin/python scripts/evals/memory_retrieval/run_long_tail.py --repo . --host backend --output /tmp/new-memory-edge-run --mechanism --full-only --hop-limit 2
```

输出目录必须是尚不存在的新路径。完整 v2 回归与纯边机制分开统计；旧报告的历史结果不覆盖。新增领域回归是开发期测试，不包装成盲测或真实学生效果。
