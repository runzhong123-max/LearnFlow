# 教育记忆升级消融协议 v2

2026-09-08。用户已授权升级与相应实验；沿用已有服务级运行框架。旧 `joint_memory` 代码、gold与已发布结果不变；本目录复制驱动改版，正式运行前冻结本协议及源文件SHA。

## 要回答的问题

同一升级后的学习经历，独立关闭某个读取组件，是否改变合法证据交付、可追溯教学准备、预算和错误？输入解析升级的前后结果另作固定回归比较，不能把共同使用新版形成快照的读取消融称为解析器因果实验。教学方案是否合适仍需教师盲评；真实学习收益仍需独立学生研究。

教育沿用72任务族、22轨迹模式、1,584例合成数据及216题目探针，原数据与gold不改。标签尚待教师审核。development/validation/holdout均已被作者看过，holdout名称仅保留原split身份，不能再称未见测试。通用侧沿用官方固定LoCoMo10原文、同一1,986题清单和原始引用标注；主类1/2/4、外部知识类3、对抗类5、无效标注分别计分，不合成教育与通用总分。

## 干预矩阵

教育默认12组，LoCoMo默认7组，预算均为1,800/3,200字符估算单位（非模型token）。

| 组 | 干预 | 教育 | LoCoMo默认 |
| --- | --- | --- | --- |
| full | 所有默认读取组件 | 是 | 是 |
| facts_only | 在隔离副本去掉Module/Claim和相关边；保留Fact、指导、episode | 是 | 否 |
| recent_facts | facts_only基础上仅留每学习者最近24个Fact | 是 | 是 |
| no_relations | max_paths=0，关闭输出关系路径 | 是 | 否 |
| no_guidance | 返回后裁剪历史teaching_guidance，保留本轮原生控制，不重新分配预算 | 是 | 否 |
| no_episodes | enable_episodes=False | 是 | 否 |
| no_bm25 | enable_bm25=False | 是 | 是 |
| no_aliases | enable_aliases=False | 是 | 是 |
| no_fuzzy | enable_fuzzy=False | 是 | 是 |
| no_temporal | enable_temporal=False | 是 | 是 |
| no_summary_boost | enable_summary_boost=False，只移除查询驱动的摘要加分 | 是 | 否 |
| no_memory | 不读历史；教育仍保留经本轮真实Event ID选择的当前控制 | 是 | 是 |

默认完整矩阵为教育38,016条件、LoCoMo27,804条件。CLI允许预先选择较小矩阵，`suite.json`逐项记录实际variants/budgets/expected count，汇总按该矩阵验全量覆盖；选择应在正式运行前固定。recent_facts同时改变保留历史与层级，是受限基线。no_relations不关闭独立概念附件。facts_only仍可形成episode，不能解释为彻底没有结构化记忆。

LoCoMo没有真实Attempt/Event/Mutation/MemoryFact，不伪造学习事件来激活episode；也无Module/Claim/edges。缺少机制的组可作校准负控制，不能证明机制无用。BM25是词项候选排序，不声称新增embedding语义召回。每组记录真实enabled、matched、selected、activated及预算/候选截断计数；缺失diagnostic为null。启用却未触发、触发但未入包、入包但未满足引用探针分开解释。

## 运行与验证边界

教育调用同一真实文本入口、封闭候选评分API、reducer、worker与离线规划；一个case形成一次，再从固定快照读取消融。作者提供的`valid_until`元数据不直接交给产品，只记录供审计；自然语言内的期限由新版解析器自行识别。未支持的原始回答、源撤回或运行操作继续保留adapter_gap。跨scope/future材料由适配器过滤，不能当作产品防御成绩。ORM创建时间不作为学习发生时间证据。

新预算体在旧heads/items/paths/concept/adaptation/guidance之外增加learning_episodes、retrieval_diagnostics及manifest.policy的8个component字段。驱动与独立verifier各自重建JSON，再按同一公开len/3.2向上取整；不调用产品预算函数给自己判分。旧版本少计这些新增载荷，因此相同数值预算下的新旧排名变化同时包含额外载荷成本。完整HTTP envelope不在这个估算体内，输出字符数另报。

独立verifier从DB快照检查episode的Attempt/Event/Mutation/Fact身份、原文hash/范围、scope、真实发生时间、判题与帮助等级。缺失independent维持null，不能因assistance=none自行补真。episode观察也计入实际证据交付，不能只看items。检查v1/v2指导的来源/应用scope与有效期，检查实际plan.teaching_decisions仅引用已合法交付的指导或episode，且不宣称掌握。没有选中对象的这些检查为null，不能当满分。

来源链正确、计划分钟数合规、产生了某项教学动作，都不等于教学有效。完整原话与题目标题仍是不同强度的逐字交付诊断，不转为语义教学评分。教师材料分两阶段：先审核数据/gold，再独立盲评真实产生的方案；导出文件所有评分空白，状态pending。真实学生前后测、延迟保持和迁移效果本轮未测。

## 冻结、失败与统计

首先运行纯数据评分器校准和development小pilot。失败保留在新目录；只在正式冻结前修复框架缺陷，不用正式结果改gold。正式运行禁止网络，使用临时隔离数据库；源文件、数据、CLI、实际调用、packet/plan、失败和hash均记录。输出目录必须全新。正式运行中源文件漂移则拒绝发布为有效结果。

按同case/预算配对；教育按任务族、LoCoMo按对话聚类。区间只描述固定作者已见样本，不推断学生群体。输入/来源失败、内容交付、教学决策、成本分别报告；不平均成一个总分，不把组件activation次数当正确率。所有组件关闭比较都有各自局限，发现负收益照实报告。

Contract impact：本目录是独立评测工具，消费本轮增量读取契约，不新增产品写入口，不写生产画像。正式运行由集成任务冻结后执行。
