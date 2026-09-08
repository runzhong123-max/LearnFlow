# 长尾优化验证协议（2026-09-08，运行前冻结）

目的：检验五项读取优化是否修复已知检索缺口，以及预算、安全和成本是否退化。不测真实学习提升，也不将人工合成的投影宣称为真实用户事件。

1. 主对照完整保留 v2 fixture、gold、scorer、6 个消融配置、6 条轨迹（2001..2006）、1800/2800/5600 预算、每条件重复 2 次；Web 和 Desktop 分开运行。每端 210 个查询、3,780 条件、7,560 次读取。两次重复验证确定性，不作独立样本。v2 已用于诊断和优化，因此这是已知回归集，不是盲测或无偏泛化证据。
2. 旧版对照使用先前冻结的 relevance-budget.v1 原始结果，fixture/gold SHA256 必须相同。比较 coverage、complete、precision、预算、误召回、证据/归档/scope 违规；按精确词、同义、错拼、长文本、时间、高度图等 family 分组。跨日期的延迟仅作描述，不当作严格因果测速。
3. 纯边机制单独报告：复用 v2 数据，但 two_hop_dependency 查询只含“仪器联调”，dense_edge_window 只含“密集”，保留原 root subject；目标节点没有查询词。分别限制 max_hops=0/1/2，只跑 full，6 轨迹、3 预算、2 重复，各 72 次。指标是预先指定结构目标的可达性，不代表自然语言意图消歧能力。密集场景测试 96 条边中最旧必要边；不据此承诺所有中间边均可召回。
4. 黑盒回归使用额外领域术语和独立 fixture（TCP/scheduler/deadlock、长限定、304 条同主题历史、纯图与隐藏中间节点等），验证失败不改 gold、不弱化断言；这些开发测试不算新的统计独立轨迹。
5. 所有实验禁网、禁 LLM，并在临时目录复制实验数据库。原始 queries/packets/fixture/provenance 逐项保留；失败及试跑记录保留。新 wrapper 校验所有共享 Python、宿主 app、实验源码/协议的运行前后 SHA256，源代码变动使该次结果无效。
6. 除冻结 scorer 的 empty_on_uncovered（无已知 unit）外，另从原包计算 items/paths/非 Human head 正文/概念节点是否确实为空，避免把“没命中已标注 unit”误写成“没误召回”。
7. token_estimate 沿用产品 JSON 长度估算器，计入 heads/items/paths/概念图/指导，不是模型 tokenizer；manifest/omitted 外壳不在该预算中。报告不把它解释为真实 API 账单。统计同时保留条目数、来源片段和限定遗漏。

复现保护修复：已冻结运行使用 wrapper v1；随后 v1.1 仅把新输出目录的独占创建移到 try/finally 之前，拒绝任何已有目录，防止误用旧路径时覆写旧 provenance。fixture、gold、scorer、生产检索与实验参数均未修改；原始 v1 源码随证据包保留。
