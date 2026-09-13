# 原生知识文本长尾检索验证 v1

2026-09-13，正式运行前冻结。仅新增实验，不改生产或旧实验。基线 62fd197。研究对象是五核系统中的原生知识自述文本读侧，不是五核逐核消融、真实用户长尾频率、语义问答正确率或学习收益。

## 固定数据和矩阵

12 个作者独立编写的计算机教学情境、13 个问题：旧稀有精确词、两个词表内别名、唯一错拼、歧义错拼、词表外同义表达、分离限定、正文尾部、同主题最初/当前两个问题、scope 强匹配污染、两种未覆盖。每情境在目标之后加入 4/64/256 条干扰，1800/3200 两个字符估算预算。历史问题最后加入当前自述；它与最初问题共用数据库。

common 配置为 default 与 source。两者均保留生产 checkpoint_tutor 的全部五核读取、max_items=12、max_paths=6、episode=true 等配置，只改变预算；source 额外 enable_source_text=true。别名情境各加 default_no_aliases/source_no_aliases，错拼情境各加 default_no_fuzzy/source_no_fuzzy，最初/当前情境各加 default_no_temporal/source_no_temporal。共 228 条件，不用全交叉重复未适用开关，不据结果删掉失败情境。

32 条背景语义笔记循环并改变练习坐标；同主题时序情境采用同主题日志干扰。背景重复是显式有界压力，历史长度不是新任务、条件不是独立学习者。不做总体显著性/自然频率/领先排名主张。当前长度最多产生约 532 个 Fact，未测试 4096 corpus 截断极限，更不能证明无限历史能力。

## 形成、读取和信息边界

隔离 :memory: 数据库，所有学习文字经正式 record_event(user_message) → reducer → KernelMutation → KernelState → MemoryFact。只建立身份、项目、关卡和会话，不手写 Event、Mutation、Fact、Node、State、图边或金标准记忆。用户自述疑问仅为 self-report，不构成独立练习或掌握。原文均 <=500 字符，正文位置机制单独受原生 reducer 的 500 字符上限约束。

每数据库放置异 learner/project/checkpoint 的三条强匹配外源污染（active 持久 Fact 可合法跨同关卡 session；不把该合同误作污染）。生产读取只接收实际身份坐标、自然 query 和公开 policy，不提供目标 Event/Fact id、subject_keys、评分 term、qualifier、模式或 gold。金标准仅由独立标准库 verifier 使用。

目标旧事件日期固定 2026-06-01，干扰为 2026-08-31，读时固定 2026-09-01T12:00:00，时序当前自述为当天 11:00。只改生产模块 clock；不改检索返回。元数据调用跟踪只记录传入 ID，再调用原函数。记录每条件完整 trace，依据真实 omitted.candidate_count 确認对应候选集合；若相同大小的调用不一致，则追踪核验失败，不猜目标已入池。

current KernelState 的 evidence_refs/action_chain 有界，故不要求全部旧事件仍驻留最新状态；独立验证保留的 Event→applied Mutation→Fact 正文、scope、版本，以及完整 mutation 版本连续到当前 KernelState。旧即时回执是否被淘汰单列，不能混作历史 Fact 形成失败。

## 固定指标与失败口径

每个适用条件分别报告：真实目标 Fact 进入候选、最终目标 Fact item 交付、完整目标 term 交付、限定交付、同一来源 item 同时交付 term 与限定。时序任务另报首个合法 item 是否来自所问最初/当前事件；这只是读取优先次序，不是模型理解时序。未覆盖/歧义任务严格检查 items/paths/episodes/guidance/adaptation/非 Human head 正文/concept 正文是否为空，不能以没命中 gold 代替空包。

全部实际 item 必须由独立 DB 快照逐字重建 source SHA、Unicode ranges、来源 IDs 和 scope。source fallback 仍按真正 node_text 核验，不能把 Fact 原文存在自动算作已交付。source 为整体读方案：同时扩展候选扫描至最多 4096、读取原文并增加元数据预算；不能称为纯分段因果。aliases/fuzzy/temporal 是该局部组件整体消融；候选变化是其机制的一部分，另报每个配对池是否相同。

主分母固定，由预注册目标/负控标注决定；没召回、正文不完整为 0。形成/执行/来源/scope/预算失败保留且使完整性验收失败，不产生有效性能主张。没有目标的负控主目标指标为 NA，不能计作成功召回。不将自然语言同义模型推断作为 oracle。本次全程禁网络、禁 LLM、禁 embedding，来源hash前后复核，全部原包/快照/异常存档。

## 预冻结验证和修订

先运行独立 verifier 负例单测（伪 hash、错误范围/来源/scope/ordinal、目标缺失、候选追踪歧义、预算超额、严格非空未覆盖），生成固定数据并保存 prepare manifest，再执行。正式后不得按成绩改数据或gold。执行/核验器 bug 若需修复，保留完整失败运行，明确修订原因和源hash，用新目录完整重跑，不能隐去试跑。

### 首轮执行前形成错误修订

run-01 保留全部228形成错误、0个packet与原源快照：驱动建立第二关卡时误建同项目第二Roadmap，触发唯一键。后继修复为复用该项目Roadmap。尚未观察任何检索结果时，代码核对另发现 active Fact 的合法读取scope允许同关卡跨session；撤去错误的异session强匹配必禁入负控，保留异learner/project/checkpoint。固定12情境、13query、目标term/qualifier和228条件均不变。此变更是合同纠正，不是按成绩删除失败问题。
