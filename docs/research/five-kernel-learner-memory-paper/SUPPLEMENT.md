# 补充材料 S1 论文主张与证据索引

本材料把“源码中存在”“本轮真实执行”“模型读取结果”和“真实教学效果”分开。原生15项不是15名学生，768次调用也不是768个独立主题。下文只报告保存的实际产物。

## S1.1 五核分别能力的原生证据

协议与预声明案例位于 [PROTOCOL.md](../../../evals/five_kernel_capabilities/PROTOCOL.md) 和 [cases.json](../../../evals/five_kernel_capabilities/cases.json)。正式逐项断言见 [native-02 aggregate](native-capabilities/native-02/aggregate.json)，原始事件和消费者返回见 [native.jsonl.gz](native-capabilities/native-02/native.jsonl.gz)。

| 核 | 三个实际案例 | 观察到的行为 | 仍未验证 |
|---|---|---|---|
| Structure | 有效返回 过期返回 确认路径 | 有效锚点进入未完成学习阶段；过期不再使用；确认路径进入真实路径覆盖层 | UI自动导航 路径优化质量 |
| Knowledge | 不懂 自述解决 正式错误 | 保留卡点原文；自述解决要求小检查；正式错误为needs_review | 诊断准确率 正向稳定掌握 概率校准 |
| Human | 8分钟 25分钟加小步支持 过期支持 | 35分钟默认计划分别约束为8分钟与20分钟；过期后新计划为35分钟 | 心理负荷测量 偏好真实效用 |
| Value | 优先项替换 过期 长期目标修订 | 当前值更新摘要；旧值失效；路径确认 目标正文修订 归档同步 | 多目标优化 动机干预 |
| Practice | 有助成功 独立新题 原题重试 | correct_with_support；verified_once；重试仍为guided/retry，最终待执行阶段保留撤助检查建议 | 真正执行教学 迁移成功 学习增益 |

最终每核3/3，共15/15个声明案例通过，66条案例字段断言及每例的来源门通过。共形成38 Events、55 Mutations、78 Facts/Nodes及5 Attempts。其中15条事件是同学习者、异项目、当前有效的干扰优先项；15个目标作用域均未引用其ID或正文。该设置检查异项目干扰，不宣称等同跨学习者、所有HTTP权限或安全攻击验收。

5条评分事件 session_id 实际为空，按原生概念API限制保留。路径API是学习者全局作用域，不伪装为检查点级或会话级路径隔离。Human临时控制走 Mutation/State/指令投影，0 Fact是该路由的设计，不能用缺Fact自动判为失败。

## S1.2 版本与写入权限

本轮原生执行从917b8a0创建隔离工作树，运行前冻结219个来源文件及协议/驱动，运行后hash不变。只读源码审计时主仓已更新至055d31a；审计引用的24个文件与917b8a0核验工作树逐字相同，见 [跨版本比较](sources/source-version-comparison.json)。这不表示两个提交的所有文件相同。主模型实验仍冻结于a9375aa，不能把所有结果统称为同一最新版。

真实共享实现与消费者证据索引：

- [learning_runtime.py](../../../packages/learning-core/src/learnflow_core/learning_runtime.py)：确认目标/路线、自述观察、正式作答归约、迁移等不同分支。
- [memory_graph.py](../../../packages/learning-core/src/learnflow_core/memory_graph.py)：证据等级、事实形成、替换和模块触发。
- [planning_guidance.py](../../../packages/learning-core/src/learnflow_core/planning_guidance.py)：来源控制、分钟与小步支持、准备语和计划摘要。
- [learner_state.py](../../../packages/learning-core/src/learnflow_core/api/learner_state.py)：真实路径、画像和观察入口。
- [phase3.py](../../../packages/learning-core/src/learnflow_core/api/phase3.py)：正式概念提交和重试条件。
- [learning_tasks.py](../../../backend/app/services/learning_tasks.py)：规划端有作用域读取及计划生成消费。
- [review.py](../../../backend/app/services/review.py) 与 [memory_worker.py](../../../backend/app/services/memory_worker.py)：复习门与长期Claim资格目前并非同一阈值。

完整源码行号和来源hash见 [只读能力审计](sources/learnflow-five-kernel-capability-evidence.md) 与 [机器收据](sources/learnflow-five-kernel-capability-evidence.json)。该只读审计本身没有重跑所列历史产品测试；真实新增执行依据S1.1，不把阅读测试源码写成测试通过。

普通概念结果不升级长期掌握；review要求最近失败后至少两次独立合格成功、跨度72小时及验证变式；显式transfer归约允许一次无辅助通过、输入置信字段至少0.9的迁移事件写stable；Claim使用至少两次verified及限定文字。这是按源码发现的一致性限制，未因此观察到真实误判学生掌握。图1的教育边界应按正文这些具体实现限制理解。

## S1.3 等信息读取及统计口径

完整协议和模型回执保持在 [既有研究](../education-memory-counterfactual/REPORT.md)，本轮未改动或重跑模型：

- [formal aggregate](../education-memory-counterfactual/formal-01-aggregate.json)：768响应、8组及配对差异。
- [输入审计](../education-memory-counterfactual/input-audit.json)：192组等信息检查、768输入hash、必需来源交付。
- [评分与事后敏感性](../education-memory-counterfactual/results-audit.json)：26次guided枚举错误的单别名诊断。
- [冻结正式源码与响应](../education-memory-counterfactual/artifacts/formal-01.tar.gz)：完整复核材料。

正文表4是严格主分数，表5是看过结果之后的别名敏感性分析。只读源码审计材料里“gated下未优于flat”的表述仅指严格分数；本稿以主文并列的两套口径为完整结论。不能忽略别名归一后低预算持平、高预算略高的事实，也不能把事后结果替代预先冻结终点。

每组96条轨迹、48对，只有8道唯一题和8个主题簇。分组因素保留了所有kernel字段；资格注释增加确定性解释；所有组都保留来源/归属/时序过滤。两预算必需来源全部交付，所以64次支持识别正确但时长为空，是研究模型读取组合约束的失败，不是已经复现生产规划器失效。

旧v4的64,260条件及LoCoMo派生召回只作背景证据，数值来源为 [v4报告](../education-memory-v4-upgrade/REPORT.md)。其0/1,152是目标Fact形成可用性口径，不是外部问答得分；本文不与官方Mem0/A-MEM的LLM-judge或QA分数比较。

## S1.4 失败保留与验证记录

原生native-01能力断言15/15，但重开审计失败，exit2。唯一差异是同一学习路径上下文被序列化为键顺序不同的JSON字符串；解析后对象相等。修复仅规范展示序列化，并增加校准测试，之后native-02重新冻结并从头执行，exit0。输入、产品、阈值和能力断言未调整。01不并入成功分母，见 [原始失败报告](native-capabilities/native-01/REPORT.md) 和 [完整诊断及旧源码](native-capabilities/delivery-audit-and-failed-source.tar.gz)。

集成核验执行了 `pytest evals/five_kernel_capabilities evals/education_memory_counterfactual`，97项通过，其中新验证器24项、既有反事实73项。出现pytest-asyncio现有配置/弃用提示，不影响本次通过状态，没有为通过而删断言或跳过关键案例。

文稿采用bundled运行时制作。初次渲染缺少中文字体，未作为交付；后通过临时Fontconfig加载可读字体，并重新渲染。图形直接取冻结数值、颜色可区分，未绘制虚构独立重复误差棒。最终逐页检查及artifact hash见交付验证收据。未执行无关全量产品、前端或生产部署检查。

## S1.5 研究复用建议

这套材料可用于复核教育状态契约、改进变量拆解及复现模型读出。若重编码平面输入或逐核移除，应重新冻结协议并维持同来源信息；若新增最终约束器因子，应区分无约束模型输出与产品执行结果；若引入外部算法，必须实跑官方实现并统一数据、模型、预算和调参权限。以上尚未执行，不计入论文结果。
