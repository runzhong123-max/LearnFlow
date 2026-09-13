# 五核原生能力契约核验 v1

目的：确认五个状态维度是否由真实事件形成、被真实只读消费者使用，并保持证据等级边界。本核验是作者编写的 15 个合成契约情境，每核 3 个；既不是随机学生样本，也不是等信息表示消融、传统记忆基准、SOTA 比较或学习效果实验。不得用通过率推断五核优于其他表示。

## 冻结与执行

`cases.json` 冻结操作、时间和独立字段不变量。运行前写 `freeze.json`，固定 HEAD、协议、案例、驱动、校验器及实际核心/后端 Python 源文件 SHA256；`runs/`、缓存和输出不入源哈希。随后顺序运行所有案例，每例新建内存 SQLite。结果失败也保留，不能更改条件后覆盖原运行。结束复核来源哈希，独立校验全部形成/消费输出。负例测试在正式运行前通过；测试不计入 15 个能力案例。

仅基础 Learner/Project/Roadmap/Checkpoint/Session/ConceptQuestion 是直接创建的合成环境。事件、Attempt、Mutation、State、Fact、Node 均由现有正式 API 或注册事件网关形成。判题是固定闭合选择题 `len(range(3))` 的答案 `3`，执行当前确定性概念提交 API；不是学生编程能力、真实课程考试或自然语言判题实验。子进程移除模型凭据、关闭合成 worker，审计钩子拒绝网络和文件数据库。固定事件/消费时间；ORM `created_at` 可能仍来自实际时钟，不用于时效判断。

## 15 个预声明情境

| 核 | 案例 | 必须实际观测到的行为 |
|---|---|---|
| structure | anchor_active | 当前返回请求进入有来源的控制，并进入待执行学习阶段 |
| structure | anchor_expired | 9 小时前的临时返回请求不再成为当前返回控制 |
| structure | path_confirmed | 正式路径确认 API 返回活动路径和路由，Structure/Value 同时形成确认状态 |
| knowledge | gap | 原始不懂陈述形成 Knowledge Fact；当前阻碍带回原文，无长期掌握 |
| knowledge | resolved | 后续“解决了”替换当前阻碍，只触发验证自述解决；无长期掌握 |
| knowledge | evaluated_error | 真实错误 Attempt 形成 needs_review 和正式错误反馈，不形成掌握或 Human/Value 推断 |
| human | minutes | 当前 8 分钟请求使真实离线计划不超过 8 分钟 |
| human | support_cap | 当前 25 分钟 + 小步请求共同约束为不超过 20 分钟，并保留正式独立验证阶段 |
| human | expired | 9 小时前的时间和支持请求均不再缩短新计划 |
| value | priority_updated | 新当前优先级替代旧优先级；计划摘要引用新目标；不声称重排课程 |
| value | priority_expired | 9 小时前的临时优先级不再成为当前优先控制 |
| value | goal_lifecycle | 正式确认、修订、归档路径时，目标状态同步变化，原始事件保留 |
| practice | supported | 有帮助答对保留辅助等级、correct_with_support；规划要求撤助后独立检查 |
| practice | independent | 新题无帮助答对仅 verified_once；仍要求独立变式/理由检查，不宣称稳定掌握 |
| practice | retry | 相同原题再次请求 none，正式 API 根据历史改为 retry/guided；不能升级为独立或迁移 |

默认临时控制窗口 8 小时；查询时刻固定 2026-09-01T12:00:00Z。有效操作在 11:00–11:40，过期操作在 03:00；不做历史快照跨未来状态重放。所有案例另建同 learner 的隔离项目并实际注入一个优先级干扰，核验目标 scope 消费不引用该事件。长期路径 API 是 learner 全局路径，不能伪称其具有 checkpoint/session 粒度。

## 实际消费与独立判定

调用 `build_five_kernel_context` 的默认 `checkpoint_tutor` 和 `learning_plan`，保留完整返回；调用生产 `_scoped_planner_context`、`compile_planning_guidance`、`_fallback_plan`，保留按核投影及真实计划。路径场景保留每次正式 API 返回和相应真实 KernelState 投影。固定 35 分钟、未完成四阶段的离线计划用于观测约束执行，不冒充已执行教学行为。

校验器不导入 reducer、规划决策函数或旧实验 expected helper。它检查预声明字段/缺失/包含关系，并独立验证 Event→Mutation→Fact/Node 引用、learner/project/checkpoint/session 所有权、Fact 的 predicate/value 确实存在于源 Mutation 的相应短/长期键。JSON 序列化可能重排字典，故不按序重建 fact_ordinal；仍检查 ordinal 为非负且同 mutation 唯一。教学控制按原始事件/归约指令的 source、scope、时间和有效期核验。来源和关键断言均成立才算整例通过，空输出不通过。

教学指令 `teaching_directives` / `teaching_preferences` 设计上不直接形成 Fact；保留对应 Event/Mutation/State 视为其真实控制路线，不能把零 Fact 记成失败。正式概念 API 当前不接收 session 参数，原生评估 Event/Attempt 的 session_id=null；保留并单列这一 scope 保真限制，不手工补全。

所有案例都检查无普通事件产生稳定掌握；这是负向合同约束，不是正向稳定掌握校准能力。主要结果按核报告案例分母和具体失败，汇总总数仅作完整性核验。预算报告是产品默认估计器的记录，未实施公平预算性能比较。无移除核组、无随机化、无统计显著性主张。

## 未测能力

不测真实学生学习增益、教师盲评、真实长期使用、稳定掌握正例、间隔复习正例、真实迁移/产物验证、任意语言理解、完整个人概念图推理、多跳检索质量、原文长尾召回、遗忘/巩固策略、Module/Claim 合成质量、敏感信息全攻击面或跨端/UI 浏览器交互。这些限制必须进入报告。
