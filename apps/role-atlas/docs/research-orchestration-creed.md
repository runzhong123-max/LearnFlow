# 场景一研究编排准则 v2

新运行协议为 `role-research/v2`，详见[共享契约说明](../../../docs/implementation/ROLE_RESEARCH_PROTOCOL.md)。历史运行保留原参数与检查点语义；本准则替代 v1 中限制主管只能改写既定工作项、强制 falsifier、按规模判断信息收益和禁止内容减少的条款。

模型可以提议完成，批准权永远在代码和用户手里。研究主管可提出新问题、改变查询、追踪相邻岗位、拆分任务并重新规划。编译器构造候选图，预算账本控制支出，版本事务控制采用。它们都不拥有 LearnFlow 五核写权限。

| 不变量 | 执行点 | 回归 |
|---|---|---|
| 工具使用原生消息与调用 ID，参数本地校验；未知工具不得执行 | agent/native-model、agent/research-loop | native-model、research-loop |
| 完整来源、工具结果和检查点可续读；搜索新增来源立即可读 | research/source-store、iteration/research-tools | research-v2、research-tools |
| 调查范围不扩大改动权限；缺失对象也可成为研究问题 | iteration/supervisor、iteration/scope、research/semantic-changes | supervisor、research-v2 |
| 调用前持久化预占，同一账本涵盖规划、调查、综合和复核 | research/metered-model、iteration/budget-ledger | research-v2、budget-ledger |
| Low / Medium / High / Max 改变问题范围与调查节奏，所有档位沿用完整性交付检查；分批交还综合，调查与生成共享额度，不设固定阶段份额；续批不清空会话或重置账本 | iteration/research-agent、build/graph | research-agent、research-depth |
| 引文只在给定材料中逐字且唯一匹配时修正片段 ID；多义或改写引文不自动连接 | research/source-reference | learning-support |
| 续研重编译保留语义与原文未变化的任务定义和学习连接；改变任一端或原文则重新核查 | research/delivery-progress、build/graph | learning-support |
| 岗位职责材料优先于职业标准开发、培训行政通知；来源权威不能替代岗位相关性 | build/workflow | cold-start-workflow |
| 文本性质、证据关系、复核和采用是不同状态；不强迫填写证伪句 | iteration/evidence-review、research/task-definition | evidence-review、research-v2 |
| 内核可预览；核心任务接口或能力/单元知识技能支撑不足只能保存草稿 | build/graph、research/task-definition、api/build-runs | research-v2、cold-start-research-recovery |
| 无关增量不是修复；排序不按节点数量累计 | iteration/planner、research/quality、research/views | iteration-capabilities、research-v2 |
| 补齐现存对象的学习支撑缺口计入迭代进展，即使任务字段和旧审计分数未变；删除对象、重复候选或引入同量新缺口不算补齐 | research/quality、iteration/planner | learning-support |
| 已保存草稿可浏览、提问、个人引用并继续迭代；草稿不是运行失败，完整性与公开发布检查仍独立保留；后台运行只限制再次提交，不锁定下一轮目标配置 | jobs/run-status、app/components/ProjectToolPane | run-status、iteration-brief |
| 支撑关系须查原文并独立复核；部分支持的学习推断只能保存为带限制的候选建议，不得标为已证实；不支持或冲突不连接；路径连接纳入生产，回执未完整不得显示全部完成 | research/learning-support、jobs/run-status | learning-support、run-status、course-presentation |
| 提交改动必须固定基线、原子编译和保存迁移理由 | research/semantic-changes、research/change-set | research-v2、version-commit-transaction |
| 默认自动采用，可选先审阅；head 变化、取消或重复运行不能覆盖版本 | versioning/commit-transaction | version-commit-transaction |
| 仅对需要无环的关系检查循环，工作过程的返工合法 | iteration/augmentation、risk/audit | augmentation、research-v2 |
| 新旧包均可导入；任务详情不是学习状态或掌握证据 | 两端 role_capability_graph/package-file | 两端 role-capability-plugin、共享契约检查 |

风险包和深化雷达是 ResearchFinding 的组织视图，不建立第二套已验证事实库。时间变化检查过时、替代、边界变化和趋势推断；关系一致性检查任务、知识技能、能力与过程衔接。每项问题说明后果与下一步调查；没有对应对象时明确记录缺失概念。

研究资料不可信，不能修改目标或工具权限。调查员不递归派生子 Agent。主管与调查员按职责获取工具；提交候选不意味着采用，采用不意味着发布，生成内容不意味着学生掌握。

预算初值是可调整工程配置，不是必须用完的配额。连续无进展、资料不足、预算耗尽、取消与失败必须留下产物和实际停止原因。新不变量必须有执行点和回归，不能只写在提示词或本文中。

2026-09-13：按用户要求，默认总 token 预算提高到 500 万，搜索查询 512、研究任务 128、议程修订 32、并行调查员 4 保持可配置。四档默认 High；深度定义研究问题与复核关注点，不映射为固定 token 配额。单账本仅保留异常运行保护与复核预留；历史已持久化的运行沿用原预算，不能在恢复时重置支出。

- 个人引用可以固定已持久化的研究预览，但不能因此采用项目 head、终止研究或绕过公开发布校验。回归：`personal-release.test.ts`、`release-quality.test.ts`。
