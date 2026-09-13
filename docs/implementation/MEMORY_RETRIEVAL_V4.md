# 记忆检索 v4：可对照的教育场景升级

## Contract impact

共享实现版本 0.2.6，检索版本 relevance-budget.v4。Web 与 Desktop 消费同一实现。ContextPolicy 新增 enable_source_text、enable_compact_episodes、candidate_mode；默认 False、False、legacy，兼容既有调用。新增字段计入预算，所以相同预算的新版 legacy 结果可能与历史 v3 少量不同；正式对照必须同一 v4 程序重跑，不混用历史数字。没有数据库迁移，没有新 Agent、工具或事件写权限。

仍遵守 EvidenceEvent → reducer → KernelMutation → KernelState → Fact/Module/Claim。所有新增结构只在读取时产生，不将相似度、生成文本或模型推断写成学习证据。

## 实验开关

- source：校验现有 Fact 的来源链后，用允许的原始字符串检索和截取，hash/ranges 针对真正源字符串。没有合规 Fact 的记录保持 node_text；不把任意 Event payload 提供给 Agent。
- compact：学习经历最多携带一个有效 Fact 观察；完整保留尝试、结果、辅助程度、时间、scope、来源 ID 和限制。省去的观察明确记录在原 collector 的 omission 统计中。最新经历优先，不能因它较大而跳过并用旧成功取代。
- corpus_bm25：对统一过滤后的扩大候选集合计算 BM25。SQL 每次扫描最多 4096 行，截断如实上报；这是有界的可重建读取过程，并非全数据库无限索引。
- hybrid：在相同集合上融合 BM25 与本地 thenlper/gte-small 语义候选。允许零词面交集的语义候选进入共同排序，保留 scope、答案隔离和 Human 原文保护。模型缺失/分词器不完整时明确失败，不静默伪装为语义成功。

原有别名、错拼、时序配额、有界二跳关系与模块汇总策略仍可单独控制。本轮组合是论文机制的本地适配，不是 Mem0、A-MEM、SimpleMem、Hindsight 或 Zep 官方实现复现。gte-small 不是多语言教育模型，本轮中文效果须由数据决定。

## 边界与成本

source 与 corpus 模式增加 scoped SQL 扫描、来源链读取与重排成本。向量只是内容 hash 下的可清空内存缓存，候选集合每次由调用者按权限重新提供；跨请求不缓存文档 ID 或检索结果。具体模型文件、分词器及分段参数由实验 manifest 记录。

正文、学习经历、控制字段、诊断和开关均计入现有字符估计预算；token_estimate 不是模型账单 token。模型身份与必要的截断/未知词计数计入 retrieval_diagnostics 的预算；详细缓存审计仅由候选模块直接调用返回，不复制到 Agent packet。未声称 SQLite 扫描达到生产向量库的吞吐量。

## 验证与排名

见 evals/education_memory_upgrade/PROTOCOL.md。保留旧集合和独立 verifier，新增源文本时只扩展真实源解析与逐字 hash/offset 核验，不降低评分标准。教育排名是固定数据与预算下的工程适用性，不等同于教师偏好、学生学习增益或 SCI 审稿结论。所有实际运行、失败、未运行在新报告中分别披露。

本轮固定语义参数：官方 thenlper/gte-small revision 17e1f347d17fe144873b1201da91788898c639cd；内容窗口 510 tokens，重叠 64；余弦门槛 0.35，RRF k=60，返回至多 80 候选。文档/查询字符上限 65536/4096，超过截断单独计数，总窗口超过 32768 明确失败。BM25 使用已经完成别名/错拼归一的 QueryPlan；语义通道保留原始查询。
