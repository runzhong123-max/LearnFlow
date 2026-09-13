# 教育记忆只读索引升级实验协议 v1

预注册版本：learnflow-memory-upgrade.v1，2026-09-13。用户授权升级和实际实验；正式运行前保存本文件、驱动、独立核验器、产品与数据逐文件 SHA-256，运行中改变任何冻结来源即失败。原 v2 结果与 gold 不改。本文是实验计划，不是完成声明。

## 研究问题与固定输入

比较同一形成快照上的源文本读取、紧凑评估片段、语料级 BM25/混合候选及组合。在两个字符估算预算 1800、3200 下，检索是否更完整地保留最新适用评估和表现条件，支持来源合法的当前教学动作。所有组保留旧别名、模糊、时间、摘要等读取开关；新版产品默认不由本实验改变。

教育：原 72 任务族、22 轨迹模式、1584 合成案例，复用 frozen_sources.py 校验整个数据清单。三个 split 均作者已见；不是未见任务族验证。教师标签审核、教学适切性盲评、学生学习收益均未执行。LoCoMo：既有固定 SHA 的 locomo10.json，10 对话、1986 问题；保持 v2 原始标注和 scorer，主类 1/2/4、外部知识类 3、对抗类 5、无效标注分别报告。无生成模型或 LLM judge，不产生官方 QA 准确率。

## 干预矩阵

| 配置 | 原文读取 | 紧凑片段 | candidate_mode | 额外干预 |
| --- | --- | --- | --- | --- |
| legacy | false | false | legacy | 无 |
| source | true | false | legacy | 无 |
| compact | false | true | legacy | 无 |
| bm25 | false | false | corpus_bm25 | 无 |
| hybrid | false | false | hybrid | 无 |
| source_hybrid | true | false | hybrid | 无 |
| education_full | true | true | hybrid | 无 |
| education_full_no_episodes | true | true | hybrid | enable_episodes=false |
| education_full_no_paths | true | true | hybrid | max_paths=0 |

紧凑开关将可用 observation 上限改为 min(1, max_episode_facts)，策略声明的原上限仍保留；紧凑片段只缩减 observation 数量至 1，保留完整合法文本、hash、闭合来源 ID、task/outcome/scope/time/limitations；不能把未送达正文计为送达。no_paths 名字只表示输出关系路径关闭，独立概念附件未关闭，因此不是全部图机制消融。LoCoMo没有原生评估、Module/Claim/边，episode/paths相关组仅是未激活负控制。source开关同时扩大SQL候选扫描至4096并沿用旧排序，改变来源读取和元数据；LoCoMo无Fact仍可能因扫描范围或预算变化而改变结果，所以source不是纯未激活负控制。source−legacy解释为组合读方案效应；source_hybrid与hybrid共同扩大候选，更接近来源投影差异，但仍含来源元数据预算成本。混合通道的具体 provider、模型/词表/特征、离线降级和候选上限由冻结产品实现与诊断原样记录；不得把散列特征或词法匹配称为外部预训练语义模型。

默认教育 1584×9×2=28512 条件，LoCoMo 1986×9×2=35748 条件。每例形成一次，条件读取一次；默认单 worker 串行执行。可在正式冻结前选择分片数量与 workers；并发时延必须标为存在资源争用，只作描述。条件顺序使用既有固定随机种子，分片按任务族/对话互斥划分。不得把重复读取或条件数当作独立学习者数。

## 排序与测量

只在教育轨、每个预算内给出确定的描述性优先组，不合并两轨或两个预算，不设计加权总分。

1. 准入：全量矩阵、raw packet/plan、形成快照、独立 checks 完整；无运行错误、源漂移、网络尝试。每个必检预算/当前控制/敏感原文检查必须实测通过；条件适用的 scope、来源、片段链、指导有效期、决策来源检查不得失败。过时引用、无依据动作、错误动作状态、来源篡改和预算超额任一非零即不进入优先组。NA 不算通过；明确没有对应对象的链检查可为 NA，并报告对象分母。此准入仅覆盖已有结构检查，不能声称全面隐私安全、语义答案泄露或人格推断防御已验证。
2. 一级指标：最新适用评估动作覆盖，以及可独立验证的结构化条件交付（当前schema），包括其结果、辅助、独立性、角色、时间和来源条件完整交付。适用分母由真实形成快照、当前输入事件时间及 scope 决定，不能由是否产生动作决定。复用既有独立时序审计校验实际动作与最新来源；无动作在存在适用评估时记 0，不记正确拒答。完整条件交付仅由已验证 episode 的最新事件来源及显式完整字段决定；合法 guidance 可支持动作，但不自动计为完整结果/辅助/独立性/角色交付；不以主题词或模型判断代替结构条件核验。
3. 二级指标：题目主题/来源 Fact 探针与严格原文探针。继续原 scorer 的每个完整 term、事件闭包、原文范围/hash 规则；source文本增加来源解析，不放宽内容要求。
4. 每一层采用 Pareto 分层：某组在该层所有指标不差且至少一项严格更好才支配另一组；完全相等或权衡组并列。仅在一级指标向量完全相同的组间使用二级指标细分；名称字母序只是稳定展示顺序。缺指标不自动排在有值组前，不强造唯一冠军。token估计、packet字符、实测墙钟时间列出但不打破质量并列。

另报 education_full 与每组、legacy 与各单因素组的同 case/预算配对差。教育按 72 任务族、LoCoMo 按 10 对话聚类，2000 次固定种子 bootstrap、95% 描述性区间；不按问题/条件独立抽样，不做总体推广或显著性冠军主张。精确固定样本排序与区间不确定性分别呈现；区间跨零不能声称差异确定。

## 制品与失败

运行器在全新目录先写 suite.json 与 PROTOCOL.md 快照；保留每条命令、开始结束、退出码、单 worker/并发设置、Python版本、输入数据和全源hash。每个条件保留原始 packet、plan、checks、指标与错误；教育 formation 单独保存。报告器要求恰好等于预注册 case×variant×budget 的集合，拒绝重复、少项、多项、非有限值、缺 raw、缺必需 metrics、源hash不一致和失败子进程。检索实际失败与不可评分标注分开，不允许丢掉失败行提高均值。

输出 aggregate.json、两轨压缩 trials、逐条件教育诊断、REPORT.md、制品hash清单；原始 LoCoMo 正文留在本地运行目录，不自动复制到公开论文目录。源字段只允许从独立 DB sidecar 的 MemoryFact.object_value 或 MemoryNode.text 重建，禁止为了得分直接读 gold/问答标签/任意 Event 原文。

Contract impact：仅实验读取配置与独立核验的增量兼容，不新增权威写入、教学策略或画像维度。不存在五核逐核完整消融、等证据平面表示对照、完整图评测、未见任务族实验或教师盲评结果；这些均为后续研究。

语义模型身份：本轮离线推理固定 thenlper/gte-small revision `17e1f347d17fe144873b1201da91788898c639cd`；运行器从 `LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH` 或 `--model-path` 读取本地公开推理文件清单，核验全部文件 SHA，结束后复核。只记录路径/身份/hash，不复制权重或训练数据；模型装载是否真正成功仍以运行诊断为准。

完整条件指标只覆盖本系统当前 episode schema 的独立核验；文本事实或其他系统也可能表达相同条件，未通过本结构通道不代表语义信息绝不存在。正式报告核对每个hybrid组实际semantic_model_sha256与冻结身份一致，并记录真正semantic_used条件数；仅有配置或模型文件不算运行证据。
