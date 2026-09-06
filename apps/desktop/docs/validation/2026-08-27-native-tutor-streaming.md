# Tutor 原生流式与输入响应验收

日期：2026-08-27

## 改动目标

- 发送后立即确认学习者输入，不让 Session、SkillRun、五核与工作区同步阻塞页面反馈。
- 直接消费模型供应商的原生增量，而不是等待完整回答后再用定时器切块。
- 保持 Agent 的 observe / decide / act 流程可见；工具轮、重试和校验回退不会把临时前导语混入最终回答。
- 最终持久化仍受终态 verifier 约束，临时草稿不构成消息或学习证据。

协议实现依据：

- OpenAI Responses Streaming Events：`response.output_text.delta` 与函数参数增量。
  <https://developers.openai.com/api/reference/resources/responses/streaming-events/>
- OpenAI Chat Completions Streaming：`choices[].delta.content` 与按 index 聚合的 `tool_calls`。
  <https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events/>

## 自动化验证

```text
npm test
  108 passed, 0 failed

npm run build
  TypeScript + Vite production build passed
```

新增回归覆盖：

- Chat Completions 文本增量与分片函数参数重组。
- Responses 语义事件、函数调用生命周期与失败事件传播。
- 模型先输出工具前导语再决定调用工具时，页面收到 `text_reset`，最终正文不混入前一轮草稿。
- `AgentTurnTrace` 记录真实首字延迟和总耗时。

## 真实浏览器验收

环境：Playwright headed Chromium，正式后端与页面均使用本仓最新代码；模型为本地已配置的 `mimo-v2.5`。

测试问题：`请用约六百字分步骤解释反向传播，并给一个最小数值例子。`

观测结果：

| 指标 | 结果 |
| --- | ---: |
| 用户消息显示 | 54 ms |
| 输入框清空 | 54 ms |
| 正文首字 | 约 8.0 s |
| 回合总耗时 | 约 16.6 s |
| 可见内容增量更新 | 142 次 |
| Agent 决策 / 工具 | 1 轮 / 1 次 |
| 浏览器 warning / error | 0 / 0 |

页面在正文前先呈现“正在读取学习状态与当前作用域”和五核读取工具结果；正文从约 8.2 秒开始连续增长，
而不是在 16.6 秒完成后才出现。最终回答完整收束，发送控件恢复可用。

## Contract impact

- `AgentTurnTrace` 新增向后兼容的可选 `timings`。
- 流式联合类型新增 `text_reset`，用于撤销当前模型轮的临时草稿。
- 没有新增 Tool、Skill、Event、数据库迁移或 Kernel writer。
- 五核写入链、确定性教学策略和正式消息持久化边界保持不变。
