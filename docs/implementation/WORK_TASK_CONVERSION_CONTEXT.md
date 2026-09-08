# 工作任务转换的持续对话上下文

Contract impact：`learnflow.work-task-conversion-context.v1` 是现有已确认交接的只读投影。增量扩展 `/api/learner-state/agent-workspace-context`，不新增学习者权威、事件写入、Kernel 或数据库表；旧客户端可以忽略 `work_task_conversion` 字段。两端注册表以 2026-09-08.3 版本登记 reader、投影、前端消息适配器和既有工作区 API 绑定。

转换接续的首条消息会随历史窗口退出，不能承担长期固定来源的职责。共享 `agent_observations.read_work_task_conversion_context()` 在每轮读取正式 `AgentSession.context_summary.work_task_conversion`，首先验证 learner/session/project/checkpoint 的归属和固定交接范围。没有 session 不读取转换，另一个会话不借用它；会话后来移入别的项目时不重新解释旧交接。新交接保存创建时的 `scope`；旧交接只在转换表的 learner/session/project/root_hash 均匹配时恢复，否则不注入。

`work_task_conversion_context.conversion_context_projection()` 是两端唯一投影算法，输出转换与候选版本、工作任务描述、验收标准与限制、选中步骤、固定岗位包/来源标识和未决项。用户验收与限制先于生成步骤分配预算；每类最多 12 项、每项 80 字符，超出部分计入省略量。未决项合并 acceptance_review 与 constraint_review，兼容维护方案的 input_text 和旧草案的 requirement，applied 项不再列为未覆盖要求。正文最多使用 3500 个 JSON 字符，最多保留 12 个步骤、8 个来源、12 个未决项；序列化投影至多 10000 字符，省略量显式报告。来源标识和哈希完整保留或整体省略，不截成另一个标识。完整候选、文件、测试、答案、来源正文和对话历史不进入该投影。完整数据仍通过 `detail_ref` 指向的现有 learner-owned API 读取，并要求 root_hash 一致；该引用不是新增模型可执行工具。

Web 与默认云桌面的 Node Tutor 使用共享 `work-task-conversion/context.ts` 验证 workspace scope，把有界数据放到标准 user 消息中，位于最新真实用户消息之前。它独立于 18 条历史限制，作为不可信任务数据而非系统指令或掌握证据，内容中的 XML 起始符转义。工作台观察只保留转换引用，避免在 system 上下文重复正文。TS 不生成另一份摘要，正式后端仍是投影来源。

本地桌面和云桌宠使用 Python Tutor，两端 `tutor_service._generate_tutor_reply()` 调用同一个只读 reader 和 message helper。原始 `session_handoff` / `recent_project_reference` 不再重复嵌入整个转换候选；有界数据通过独立 `HumanMessage` 保留，不受通用 prompt 压缩或历史窗口影响。旧会话消息保留原文，不修改历史。

验收入口：两端 `tests/test_conversion_context.py`，覆盖真实 workspace API 的账号/会话/项目隔离、项目迁移、旧绑定兼容、有界输出与 Python provider 长历史；两端 `server/agent-runtime.test.ts` 验证 Node provider 超过 18 条消息仍有固定转换上下文；共享 `context.test.ts` 覆盖错误 schema/scope、超限和分隔符转义。
