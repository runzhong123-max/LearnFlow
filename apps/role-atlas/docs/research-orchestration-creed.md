# 场景一研究编排准则 v2

新运行协议为 `role-research/v2`，详见[共享契约说明](../../../docs/implementation/ROLE_RESEARCH_PROTOCOL.md)。历史运行保留原参数与检查点语义；本准则替代 v1 中限制主管只能改写既定工作项、强制 falsifier、按规模判断信息收益和禁止内容减少的条款。

模型可以提议完成，批准权永远在代码和用户手里。研究主管可提出新问题、改变查询、追踪相邻岗位、拆分任务并重新规划。编译器构造候选图，预算账本控制支出，版本事务控制采用。它们都不拥有 LearnFlow 五核写权限。

| 不变量 | 执行点 | 回归 |
|---|---|---|
| 工具使用原生消息与调用 ID，参数本地校验；未知工具不得执行 | agent/native-model、agent/research-loop | native-model、research-loop |
| 完整来源、工具结果和检查点可续读；搜索新增来源立即可读 | research/source-store、iteration/research-tools | research-v2、research-tools |
| 调查范围不扩大改动权限；缺失对象也可成为研究问题 | iteration/supervisor、iteration/scope、research/semantic-changes | supervisor、research-v2 |
| 调用前持久化预占，同一账本涵盖规划、调查、综合和复核 | research/metered-model、iteration/budget-ledger | research-v2、budget-ledger |
| 文本性质、证据关系、复核和采用是不同状态；不强迫填写证伪句 | iteration/evidence-review、research/task-definition | evidence-review、research-v2 |
| 内核可预览，核心任务接口不足只能保存草稿 | build/graph、research/task-definition、api/build-runs | research-v2、cold-start-research-recovery |
| 无关增量不是修复；排序不按节点数量累计 | iteration/planner、research/quality、research/views | iteration-capabilities、research-v2 |
| 提交改动必须固定基线、原子编译和保存迁移理由 | research/semantic-changes、research/change-set | research-v2、version-commit-transaction |
| 默认自动采用，可选先审阅；head 变化、取消或重复运行不能覆盖版本 | versioning/commit-transaction | version-commit-transaction |
| 仅对需要无环的关系检查循环，工作过程的返工合法 | iteration/augmentation、risk/audit | augmentation、research-v2 |
| 新旧包均可导入；任务详情不是学习状态或掌握证据 | 两端 role_capability_graph/package-file | 两端 role-capability-plugin、共享契约检查 |

风险包和深化雷达是 ResearchFinding 的组织视图，不建立第二套已验证事实库。时间变化检查过时、替代、边界变化和趋势推断；关系一致性检查任务、知识技能、能力与过程衔接。每项问题说明后果与下一步调查；没有对应对象时明确记录缺失概念。

研究资料不可信，不能修改目标或工具权限。调查员不递归派生子 Agent。主管与调查员按职责获取工具；提交候选不意味着采用，采用不意味着发布，生成内容不意味着学生掌握。

预算初值是可调整工程配置，不是必须用完的配额。连续无进展、资料不足、预算耗尽、取消与失败必须留下产物和实际停止原因。新不变量必须有执行点和回归，不能只写在提示词或本文中。
