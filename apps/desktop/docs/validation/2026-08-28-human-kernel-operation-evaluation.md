# Human 核操作测评

日期：2026-08-28
目标：验证学习者明确提出节奏、呈现、负荷、挫败和支持请求时，Human 状态能否同轮、安全、可过期地改变；同时验证系统不会从普通错误和自我评价中推断人格或固定学习风格。

## 1. 正向覆盖

| 用户操作 | 类型化状态 | Tutor 影响 |
|---|---|---|
| “讲慢一点” / “这些我会了，快进” | `pace_adjustment=slower/faster` | 调整单轮步幅，不修改知识掌握 |
| “用图示” / “给代码” / “来个例子” | `format_request=visual/code/example` | 优先相应表征 |
| “拆成步骤” / “只说重点” / “换种讲法” | `format_request=steps/concise/alternative` | 调整结构或讲法 |
| “信息量太大” | `cognitive_load=reduce_chunk_size` | 缩小本轮信息块 |
| “我很挫败，先缩小任务” | `frustration=acknowledge_and_reduce_scope` | 承认困难并缩小范围，不做心理诊断 |
| “把关键点再说一次” | `support_need=repeat_key_point` | 重述关键点 |

每轮最多保留三个去重指令，避免一个长句无限扩张上下文。事件在本轮 ContextPacket 组装前写入，并带 learner/project/checkpoint/session scope 与 client event id；只有精确匹配的 ContextPacket 可以消费，不能串到同项目另一对话。

## 2. 否定样例

以下输入不得触发 Human 写入：

- “我不会这道题”
- “我不懂反向传播”
- 一次答错、低分、跳过或停顿
- “我可能是视觉型学习者”
- “我数学天赋不行”

前两类属于 Knowledge/Practice 的待验证观察；后两类不能直接固化为人格、能力或学习风格。系统只接受可执行的当前请求，例如“这一轮用图示”。

## 3. 生命周期与记忆边界

- 临时状态 TTL 为 8 小时。
- 过期状态从 kernel head、facet state 和 Agent ContextPacket 同时移除。
- TTL 字段和当前适配值不形成长期 MemoryFact/Module/Claim。
- Human 原始敏感内容不进入模型；ContextPacket 只给出安全的教学适配指令。
- 普通错误不能借由 Human 事件提升或降低 Knowledge/Practice 掌握结论。

## 4. 当前没有自动覆盖的情况

这些不是“测试通过”，而是刻意暴露的产品缺口：

1. 语音语速、表情、鼠标轨迹和生理信号没有可信 adapter，因此不自动推断负荷或情绪。
2. “暂停一下”“今天先到这里”等休息/终止意图尚未建成独立的 session support 状态。
3. 同一轮互相冲突的明确请求目前按有限规则顺序和三项预算裁剪，没有面向用户的冲突确认器。
4. 隐含情绪或委婉表达不做自动推断；如果产品要支持，应先做显式 UI 控件或让 Tutor 以非诱导问题确认。
5. 临时适配过期后不会跨设备继续生效；长期偏好必须由学习者明确确认并走独立的可纠正画像事件，不能由本事件自动升级。

## 5. 建议的下一步

- 在输入栏增加“慢一点 / 少一点 / 换种呈现 / 暂停”轻量显式控件，直接形成同一类型化事件。
- 对冲突请求给出一行澄清，例如“这一轮优先图示还是最短代码？”，不让模型私自决定永久偏好。
- 为暂停与恢复新增零掌握语义的 session-level EventContract，并设明确恢复锚点。
- 对任何更敏感的 Human 信息保持知情、可见、可撤回和最小上下文原则。

## 6. 自动化覆盖

- 前端规则：`frontend/server/human-adaptation.test.ts`
- 事件 scope、同轮写入与 TTL：`backend/tests/test_learner_state.py`
- Memory Graph 不巩固临时 Human 状态：`backend/tests/test_memory_graph.py`

最终命令与完整结果记录在 `docs/validation/2026-08-28-agent-platform-evaluation.md`。
