# 五核教育记忆论文：相关研究与公平比较核验

核验日期：2026-09-13。共18项（17项研究文献及1项官方API文档）。一手来源优先；Exa和Jina失败后使用web读取原论文/出版社/作者站。未运行新实验、未更改主仓。

本材料用于教育状态语义与证据治理系统论文。以下“可比较”均为方法建议，不代表已经重跑外部系统；“未报告”不得改写为“不支持”。

## 可直接用于正文的定位

已有研究已经提供外部知识检索、分层长期记忆、动态关联、用户画像、时间处理及知识状态估计。研究空缺不宜写成“现有系统只能检索事实”，而应具体化为：在本研究的教育工作流中，如何把来源可追踪的行为记录转换为有作用域、有效期和辅助条件的学习状态，并使多个教学消费者遵循相同的更新与使用规则。这是本文提出和审计的系统契约；不据文献未报告情况推断外部系统无法实现。

五核是工程中的责任与状态语义分解，不能仅凭核的数量宣称新认知理论。structure表达学习位置、依赖和返回点；knowledge承载理解与错误证据；human限定明确偏好、负荷与支持需求；value表达目标和当前优先级；practice保留尝试、辅助与迁移条件。它们分别回应计划上下文、知识估计、用户控制、目标时效和证据资格问题，差异应体现在版本化字段、确定性规则及可追溯事件上，并由源码审计确认实际实现。

## 18项书目与能力边界

### 1. zhao2026deeptutor

Bingxi Zhao; Jiahao Zhang; Xubin Ren; Zirui Guo; Tianzhe Chu; Yi Ma; Chao Huang. **DeepTutor: Towards Agentic Personalized Tutoring**. arXiv preprint, 2604.26962v1, 2026. DOI: 10.48550/arXiv.2604.26962.

一手来源：[主记录](https://arxiv.org/abs/2604.26962v1)；[补充一手来源1](https://arxiv.org/html/2604.26962v1)；[补充一手来源2](https://github.com/HKUDS/DeepTutor)。
核验位置：§4.1.1–4.1.3; §6.2, Table 1; §6.4; Appendix B.1–B.3。

- 已有能力：图/向量混合检索、三级 trace forest、三个画像维度与角色化注入；弱点消解要求后续至少两次会话正确应用。
- 公平比较：可借鉴同骨干、同课程来源下的记忆消融与多轮模拟学生；另测证据资格、撤销和时效一致性。
- 不可写成前人缺陷：不能称其只有向量检索、没有统一画像/来源追踪/持续更新。论文未报告的 LearnFlow 式写权限契约不能判为实现缺失。
- 版本/书目说明：最新 arXiv 页显示 v3（2026-07-09）；本材料固定 v1，不能混用其他版本数值。未确认期刊/会议录用。
- 数值与方法说明：v1 Table 1: OQ 3.91/5 vs w/o Memory 3.80/5；§6.2: 270 tasks/90 profiles/30 knowledge bases，学生与 tutor 用 Gemini-3-Flash，Claude Sonnet 4.6 judge，每 transcript 评分三次平均；并非真人前后测。

### 2. lewis2020rag

Patrick Lewis; Ethan Perez; Aleksandra Piktus; Fabio Petroni; Vladimir Karpukhin; Naman Goyal; Heinrich Küttler; Mike Lewis; Wen-tau Yih; Tim Rocktäschel; Sebastian Riedel; Douwe Kiela. **Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks**. Advances in Neural Information Processing Systems, 2020.

一手来源：[主记录](https://papers.nips.cc/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html)；[补充一手来源1](https://papers.nips.cc/paper_files/paper/2020/file/6b493230205f780e1bc26945df7481e5-Paper.pdf)；[补充一手来源2](https://arxiv.org/abs/2005.11401v4)。
核验位置：§2; §3–4。

- 已有能力：联合参数化生成器与非参数知识索引，并比较序列级/词元级文档条件化。
- 公平比较：可作课程知识检索与生成基线，需固定语料、生成模型和预算。
- 不可写成前人缺陷：原论文目标是知识密集 NLP，不是全套学习者状态治理；不能把原始密集索引定义外推为所有现代 RAG 的能力上限。

### 3. packer2023memgpt

Charles Packer; Sarah Wooders; Kevin Lin; Vivian Fang; Shishir G. Patil; Ion Stoica; Joseph E. Gonzalez. **MemGPT: Towards LLMs as Operating Systems**. arXiv preprint, 2310.08560v2, 2023. DOI: 10.48550/arXiv.2310.08560.

一手来源：[主记录](https://arxiv.org/abs/2310.08560v2)；[补充一手来源1](https://arxiv.org/html/2310.08560v2)。
核验位置：§2.1–2.3; §3。

- 已有能力：工作上下文、recall/archival 外部存储、上下文换入换出和函数链式检索；工作记忆保存用户事实与偏好。
- 公平比较：可比较上下文管理、跨会话读取与预算成本；教育资格约束需要双方同样的任务接口。
- 不可写成前人缺陷：不能称其只检索、不更新或没有画像。自主记忆编辑与 LearnFlow 的确定性权威链不同，不等于原方法在其目标任务上错误。
- 版本/书目说明：按首发年2023引用并明确所读v2；本次未确认正式会议/期刊，不虚填。

### 4. park2023generative

Joon Sung Park; Joseph C. O'Brien; Carrie J. Cai; Meredith Ringel Morris; Percy Liang; Michael S. Bernstein. **Generative Agents: Interactive Simulacra of Human Behavior**. Proceedings of the 36th Annual ACM Symposium on User Interface Software and Technology, 2023. DOI: 10.1145/3586183.3606763.

一手来源：[主记录](https://arxiv.org/abs/2304.03442v2)；[补充一手来源1](https://arxiv.org/html/2304.03442v2)；[补充一手来源2](https://doi.org/10.1145/3586183.3606763)。
核验位置：§4.1–4.3; §6–7。

- 已有能力：经验流、相关性/时近性/重要性联合召回、递归反思及计划；有组件消融与行为可信度评价。
- 公平比较：可借鉴观测、反思、规划分开移除的设计，但教育终点应是资格与安排正确性。
- 不可写成前人缺陷：不能称其仅存向量或不支持计划。可信的模拟行为与真实学生掌握是不同任务，不能跨任务直接排列分数。

### 5. zhong2024memorybank

Wanjun Zhong; Lianghong Guo; Qiqi Gao; He Ye; Yanlin Wang. **MemoryBank: Enhancing Large Language Models with Long-Term Memory**. Proceedings of the AAAI Conference on Artificial Intelligence, 2024. DOI: 10.1609/aaai.v38i17.29946.

一手来源：[主记录](https://ojs.aaai.org/index.php/AAAI/article/view/29946)；[补充一手来源1](https://ojs.aaai.org/index.php/AAAI/article/download/29946/31654)。
核验位置：MemoryBank method; Experiments。

- 已有能力：记忆存储、召回、更新、事件/用户特征总结及随时间遗忘与强化，面向长期陪伴。
- 公平比较：可比较长期偏好保持和历史更新；教育中要额外公开辅助条件与测评来源定义。
- 不可写成前人缺陷：不能称其没有用户画像或时间机制；陪伴人格推断不等于经验证的教育掌握，也不能据此泛称方法无效。
- 版本/书目说明：采用AAAI 2024正式版本，非把2023预印本误写为正式发表年。

### 6. chhikara2025mem0

Prateek Chhikara; Dev Khant; Saket Aryan; Taranjeet Singh; Deshraj Yadav. **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory**. arXiv preprint, 2504.19413v1, 2025. DOI: 10.48550/arXiv.2504.19413.

一手来源：[主记录](https://arxiv.org/abs/2504.19413v1)；[补充一手来源1](https://arxiv.org/html/2504.19413v1)。
核验位置：§2; §3; Table 1–2。

- 已有能力：持续抽取、合并与更新紧凑记忆；另有图增强版。
- 公平比较：须固定 LoCoMo 子集、读出模型、judge和预算，区分记忆形成与读取成本；本轮未重跑，不能列进同一排名。
- 不可写成前人缺陷：不能称其只有向量或图版必优；v1排除对抗题，不能据该结果评价拒答。
- 数值与方法说明：Table 1 多跳 LLM-judge J：基础 Mem0 51.15±0.31，图版47.19±0.67。该反例不证明图机制普遍无用；论文机制用GPT-4o-mini，部分基线分数来自已有报告而非全部同场重跑。

### 7. xu2025amem

Wujiang Xu; Zujie Liang; Kai Mei; Hang Gao; Juntao Tan; Yongfeng Zhang. **A-Mem: Agentic Memory for LLM Agents**. Advances in Neural Information Processing Systems, 2025. DOI: 10.52202/085713-0593.

一手来源：[主记录](https://proceedings.neurips.cc/paper_files/paper/2025/hash/19909c36f51abc4856b4560aff3d36d6-Abstract-Conference.html)；[补充一手来源1](https://papers.neurips.cc/paper_files/paper/2025/file/19909c36f51abc4856b4560aff3d36d6-Paper-Conference.pdf)；[补充一手来源2](https://arxiv.org/html/2502.12110v11)；[补充一手来源3](https://github.com/WujiangXu/AgenticMemory)；[补充一手来源4](https://github.com/WujiangXu/A-mem-sys)。
核验位置：§3.1–3.4; §4.4/Table 3; Appendix A.5。

- 已有能力：带关键词、标签和上下文描述的笔记、动态连边与旧记忆演化；提供组件移除实验。
- 公平比较：可迁移链接/演化消融；固定生成模型、候选池与top-k，并预先固定调参方式。
- 不可写成前人缺陷：不能称其缺少结构化组织或记忆更新。图组织效果不是教育证据的权威资格，二者需分别评价。
- 版本/书目说明：采用NeurIPS 2025正式书目；方法交叉核对arXiv v11。基准仓库与生产库是不同产物，不能混同其配置。

### 8. wu2025longmemeval

Di Wu; Hongwei Wang; Wenhao Yu; Yuwei Zhang; Kai-Wei Chang; Dong Yu. **LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory**. International Conference on Learning Representations, 2025.

一手来源：[主记录](https://arxiv.org/abs/2410.10813v2)；[补充一手来源1](https://arxiv.org/html/2410.10813v2)；[补充一手来源2](https://github.com/xiaowu0162/LongMemEval)。
核验位置：§2; §4; §5.2–5.5; Appendix C。

- 已有能力：500个问题测抽取、跨会话、时间、更新与拒答；明确索引—检索—读取三阶段，并研究时间查询和结构化读出。
- 公平比较：可沿用分阶段指标、oracle证据条件与时序挑战；本轮等信息实验只覆盖读取组织与资格注释。
- 不可写成前人缺陷：不能说前人忽略时间/更新/拒答，或首次发现召回不等于正确回答。我们自己的证据召回率不能当它的QA准确率。

### 9. maharana2024locomo

Adyasha Maharana; Dong-Ho Lee; Sergey Tulyakov; Mohit Bansal; Francesco Barbieri; Yuwei Fang. **Evaluating Very Long-Term Conversational Memory of LLM Agents**. Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), 2024. DOI: 10.18653/v1/2024.acl-long.747.

一手来源：[主记录](https://aclanthology.org/2024.acl-long.747/)；[补充一手来源1](https://aclanthology.org/2024.acl-long.747.pdf)。
核验位置：§3; §4.1–4.3; §5; Table 1。

- 已有能力：人机共建并人工修订的长期多模态对话；包含QA、事件图摘要与对话生成，而非只有事实检索。
- 公平比较：可迁移跨会话、时间、说话人归属与无答案场景；必须注明所跑任务/类别/子集。
- 不可写成前人缺陷：不能把公开小子集等同全部基准，不能以 source evidence recall 冒充QA，不能说它没有因果/时间考察。

### 10. corbett1994bkt

Albert T. Corbett; John R. Anderson. **Knowledge tracing: Modeling the acquisition of procedural knowledge**. User Modeling and User-Adapted Interaction, 1994. DOI: 10.1007/BF01099821.

一手来源：[主记录](https://link.springer.com/article/10.1007/BF01099821)；[补充一手来源1](https://act-r.psy.cmu.edu/?post_type=publications&p=14344)。
核验位置：Abstract; ACT Programming Tutor model and empirical studies。

- 已有能力：对程序规则掌握概率持续估计，据此个性化安排练习，并以学生测验表现检验。
- 公平比较：应作为知识状态估计的前身或可集成组件；若比较预测效果，应使用同一学生划分、历史输入与未来作答终点。
- 不可写成前人缺陷：不能称教育历史模型只是静态分数，也不能说我们首次以证据驱动练习。治理状态正确不等于更好的概率校准。
- 版本/书目说明：出版社正式卷期/引用为1994；作者ACT-R站列1995。本文按出版社1994，保留差异，避免悄然混年。

### 11. piech2015dkt

Chris Piech; Jonathan Bassen; Jonathan Huang; Surya Ganguli; Mehran Sahami; Leonidas Guibas; Jascha Sohl-Dickstein. **Deep Knowledge Tracing**. Advances in Neural Information Processing Systems, 2015.

一手来源：[主记录](https://papers.nips.cc/paper_files/paper/2015/hash/bac9162b47c56fc8a4d2a519803d51b3-Abstract.html)；[补充一手来源1](https://papers.nips.cc/paper_files/paper/2015/file/bac9162b47c56fc8a4d2a519803d51b3-Paper.pdf)。
核验位置：§2–4。

- 已有能力：用循环神经网络表征作答序列和潜在知识动态，以真实学生后续作答预测评估。
- 公平比较：可在知识核接入预测器，但应独立评价AUC/校准/泄漏，不能用安排字段准确率替代。
- 不可写成前人缺陷：不能称神经知识追踪不建模历史或不做个性化。其目标未覆盖全部偏好/计划状态，不等于算法失败。
- 版本/书目说明：作者采用正式会议元数据Jonathan Bassen；arXiv 1506.05908检索条目显示Jonathan Spencer，不将两版作者混拼。

### 12. ghosh2020akt

Aritra Ghosh; Neil Heffernan; Andrew S. Lan. **Context-Aware Attentive Knowledge Tracing**. Proceedings of the 26th ACM SIGKDD International Conference on Knowledge Discovery & Data Mining, 2020. DOI: 10.1145/3394486.3403282.

一手来源：[主记录](https://arxiv.org/abs/2007.12324)；[补充一手来源1](https://arxiv.org/pdf/2007.12324)。
核验位置：§3; §4。

- 已有能力：单调注意力、上下文距离/衰减与Rasch正则问题表示，预测后续作答并分析可解释性。
- 公平比较：可检验遗忘、题目难度与知识证据动态；采用真实学生隔离、前视遮罩及相同训练资料。
- 不可写成前人缺陷：不能把所有KT称为只按最近一次答对或不考虑时间，也不能把注意力可解释性与完整事件追责视为同一终点。
- 版本/书目说明：KDD 2020及DOI由原论文首页ACM Reference Format核验；未从一手页面核实页码，故不填。

### 13. bull2010olm

Susan Bull; Judy Kay. **Open Learner Models**. Advances in Intelligent Tutoring Systems, 2010. DOI: 10.1007/978-3-642-14363-2_15.

一手来源：[主记录](https://link.springer.com/chapter/10.1007/978-3-642-14363-2_15)。
核验位置：Abstract and chapter bibliographic record。

- 已有能力：将机器中的学习者表示开放给学习者及支持者，讨论透明呈现、控制和学习用途。
- 公平比较：可用来界定记忆面板应让用户理解和控制什么；后续需实际检验可理解性和修正流程。
- 不可写成前人缺陷：不能把画像可见、学习者控制或支持元认知当作五核独创。本轮自动实验没有证明学习者使用收益。
- 访问边界：本次核验出版社书目与摘要，未获取付费章全文；不作其内部实现细节断言。

### 14. bull2016smili

Susan Bull; Judy Kay. **SMILI☺: a Framework for Interfaces to Learning Data in Open Learner Models, Learning Analytics and Related Fields**. International Journal of Artificial Intelligence in Education, 2016. DOI: 10.1007/s40593-015-0090-8.

一手来源：[主记录](https://link.springer.com/article/10.1007/s40593-015-0090-8)。
核验位置：Abstract and bibliographic record。

- 已有能力：提供描述、设计和比较开放学习者模型的框架，并针对学习分析等新场景修订。
- 公平比较：可组织界面可见内容、访问和交互的比较；运行审计与用户理解需要不同证据。
- 不可写成前人缺陷：不能把呈现状态等同真正开放可协商模型，也不能说之前没有系统的用户模型比较框架。
- 访问边界：本次核验出版社摘要与书目；未访问付费全文，不细述未读框架条目。

### 15. bull2016negotiated

Susan Bull. **Negotiated learner modelling to maintain today’s learner models**. Research and Practice in Technology Enhanced Learning, 2016. DOI: 10.1186/s41039-016-0035-3.

一手来源：[主记录](https://link.springer.com/article/10.1186/s41039-016-0035-3)。
核验位置：Abstract; Background; Negotiated learner modelling。

- 已有能力：讨论以协商方式维护多来源学习者模型准确性，并支持学习者反思。
- 公平比较：可迁移来源分解、争议提出与修正轨迹；自动可重放测试不能代替真人协商效果。
- 不可写成前人缺陷：不能声称此前模型不允许用户纠错，或纠错权首次由本系统引入。LearnFlow的贡献应是具体事件化实现与检验。
- 版本/书目说明：11为卷，10为文章号，非第10期。BibTeX使用eid。

### 16. rasmussen2025zep

Preston Rasmussen; Pavlo Paliychuk; Travis Beauvais; Jack Ryan; Daniel Chalef. **Zep: A Temporal Knowledge Graph Architecture for Agent Memory**. arXiv preprint, 2501.13956v1, 2025. DOI: 10.48550/arXiv.2501.13956.

一手来源：[主记录](https://arxiv.org/abs/2501.13956v1)；[补充一手来源1](https://arxiv.org/html/2501.13956v1)。
核验位置：§2.2.3; retrieval; evaluation。

- 已有能力：Graphiti记录系统时间与事实有效时间，支持边失效及图/语义检索。
- 公平比较：可迁移时间双轴与失效机制为可重建派生索引；分别评估历史事实查询与当前安排有效性。
- 不可写成前人缺陷：不能说通用记忆无时序治理。LLM抽取关系不自动获得教育状态写权；也不能把厂商不同版本分数并入本轮排名。

### 17. liu2024lost

Nelson F. Liu; Kevin Lin; John Hewitt; Ashwin Paranjape; Michele Bevilacqua; Fabio Petroni; Percy Liang. **Lost in the Middle: How Language Models Use Long Contexts**. Transactions of the Association for Computational Linguistics, 2024.

一手来源：[主记录](https://aclanthology.org/2024.tacl-1.9/)；[原论文](https://aclanthology.org/2024.tacl-1.9.pdf)。
核验位置：Abstract; multi-document question answering and key-value retrieval experiments。

- 已有能力：控制多文档问答与键值检索中的相关信息位置，观察到若干受测模型在中间位置表现下降。
- 公平比较：支持在组织方式实验中控制信息位置和顺序；应将分组、排序、篇幅分别干预。
- 不可过度推断：不能由该文断定所有模型必有同样效应，也不能据此认定本轮分组差异已被位置机制因果解释。
- 版本/书目说明：采用TACL 2024正式版本，不混用2023预印本发表年。

### 18. deepseek_thinking_mode

DeepSeek. **Thinking Mode**. DeepSeek API Docs, 发布日期未注明；访问2026-09-13.

一手来源：[主记录](https://api-docs.deepseek.com/guides/thinking_mode/)。
核验位置：Thinking Mode Toggle and Effort Control; Input and Output Parameters。

- 已有能力：官方文档说明thinking默认启用，提供enabled/disabled开关；OpenAI SDK通过extra_body传入thinking参数。
- 公平比较：用于说明本实验显式关闭thinking的API参数选择；是否实际发送、用量和返回alias须由本轮回执佐证。
- 不可过度推断：文档不是冻结模型权重或运行结果证明；不能从参数文档推断alias完全等价，也不能把请求温度0称为可重复的确定性输出。
- 版本/书目说明：页面未给出明确发布日期，year保持null；BibTeX不伪造发表年，记录访问日期。

## 从相关研究走向本文的可检验问题

以下是我们的研究设计推导，而非对单篇论文的负面事实断言。

| 系统责任 | 已有研究基础 | 本文需给出的实现证据 | 本轮结果能支持的范围 |
|---|---|---|---|
| structure | MemGPT的层次上下文；DeepTutor的计划与trace；Generative Agents的计划 | 稳定学习对象、路径/返回点与依赖来源；跨任务读取 | 返回点字段和组织方式的读取；尚非完整路径规划价值 |
| knowledge | BKT/DKT/AKT及DeepTutor弱点画像 | 自述、错误、正式测评的等级和来源区分 | 自述/正式测评反事实下的操作一致性；不等于预测校准 |
| human | MemoryBank个性化；OLM学习者控制 | 明确偏好、时长、支持期限；避免从错误推断人格 | 合成时长与支持有效性字段；不等于心理量表效度 |
| value | 通用记忆更新；Zep有效期；OLM协商 | 优先级取消/替代、目标适用范围 | 目标更新与时效读取；不等于动机干预效果 |
| practice | 知识追踪的作答史；DeepTutor闭环练习 | 有提示/独立、重做/迁移、缺失/错误区分 | 辅助条件受控的读出；稳定掌握是否定控制 |

这些能力应通过唯一 EvidenceEvent → reducer → KernelMutation → KernelState → Fact/Module/Claim 链提供。图、语义向量、摘要和时序索引可以作为可重建的读出结构；外部记忆框架的LLM编辑不自动获得五核权威写权限。具体权限、失效和纠错是否已完成以产品审计为准。

## 正文和实验必须保留的边界

- 现有768次调用是8道唯一题目、8个主题、6类反事实两侧形成的96条合成轨迹，四条件与两预算；不是768个独立学生或96道独立试题。
- 两档预算均保留必需来源，因此测的是在证据已提供时的读取与组合，不能用于宣称检索召回优势、完整五核形成有效性或SOTA。
- 请求alias deepseek-v4-flash、返回alias deepseek-flash；只保证实际记录，不保证固定权重。26个guided枚举错误进入严格主分母；单别名敏感性为事后分析，不替代预先冻结终点。
- 本轮动作任务存在天花板；不能用简单规则下动作正确率证明复杂教学决策，更不能证明学习增益。
- 将外部系统分数并表前，必须重跑相同任务、来源范围、底座、上下文预算、解析/别名规则与评分器；同时列记忆形成成本。方法综述可并列功能，不能伪装成同场成绩。
- 学习收益另需预先设计真实前后测、延迟保持/变式迁移、按学生或课程隔离及适当对照；这些本轮未做，也不以模拟学生或LLM judge替代。

## 借鉴实验方法（拟开展，不计入结果）

1. 依据LongMemEval分开核验形成/索引、检索和读出：端到端对照允许外部系统自行形成记忆；固定候选池对照仅测检索；等来源条件仅测表达与使用。不得把三种结果混成同一主分数。
2. 借鉴DeepTutor同骨干与同课程来源控制、多轮学习者情境，以及RAG/Memory组件移除；针对本文另冻结自述资格、辅助条件、取消、失效与跨课程归属的干预。若不用真人，持续称模拟协议。
3. 借鉴LoCoMo时间/归属/无答案与事件关系任务；教育扩展增加前视屏蔽、证据全字段、迁移资格及冲突时保留不确定性。新题目和情境应按主题簇划分，控制模板近重复。
4. 将五核组织、资格注释、时序索引、最终确定性输出约束独立作为因子；预先固定别名解析并重复读出，报告交互与成本，不预设五核每组都应胜出。

## 检索与未核实项

- Agent Reach当前版本v1.5.0；check-update在DNS失败后退出，无法确认是否有新版；未安装或升级。
- DeepTutor固定v1；Mem0/Zep固定2025原始预印本。没有把2026官网宣传分数当作原论文结果。
- BKT存在出版社1994与作者站1995差异，按出版社书目；DKT采用会议版作者名。未核实的页码和录用信息留空。
- OLM 2010、SMILI 2016只获取出版社摘要及元数据，没有声称阅读全文。其他方法描述来自已访问原论文相关段落/正文。

## 追加核验：DeepTutor v1 日期

arXiv摘要页Submission history明列v1为2026-04-10 17:57:00 UTC；固定v1 PDF首页边栏也标注10 Apr 2026。两处一手页面一致，因此保留JSON中的v1; 2026-04-10，未根据编号推测。[摘要页](https://arxiv.org/abs/2604.26962v1)、[固定PDF首页](https://arxiv.org/pdf/2604.26962v1)。
