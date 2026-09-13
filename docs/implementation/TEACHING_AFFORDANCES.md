# 教学回答的追问与重点引用

Contract impact：registry 2026-09-13.4 / 2026-09-13.4-desktop 新增 `teaching_affordances_v1` 只读表达契约。正式 Tutor 的成功回复增量返回可选 `message_id`；既有 reply、Markdown、三类 Agent、五核、评分、SkillRun 与事件 schema 不变。无需数据库迁移。

## 交互

- 简单讲解和带领学习的成功回答完成后，用一次有界模型调用同时生成三个具体追问与 0–3 个重点候选。正文先显示，整理阶段最多等待客户端 10 秒；服务端模型调用最多 8 秒，不重试。失败、无模型或不合格候选不影响正文，不显示伪造的通用问题。
- 三个提示放在正文外，采用现有绿色系、小字号、透明背景和细分隔线。点击在当前纸张发送 `请直接解释：<问题>`，作为明确解释请求保留在记录中。带领学习沿用现有 `direct_explanation_requested` 判定，不把点击当作答题尝试；本地投影同样保留当前步骤。
- 重点使用正文原色与 1px 淡绿色下划线，悬停才强调；支持键盘聚焦。只选理解必要的概念或关键因果判断，允许没有，不能为了填满名额标普通词。
- 点击重点沿用 `open_selection_followup`：子纸张顶部引用原文，保留来源消息和父纸张，用户可继续输入追问。相同来源消息、父纸和原文重复点击复用已有纸张。主对话与祖先纸张上下文沿用既有装配器；不自动创建教学任务或执行练习。

## 数据与来源

共享生成与候选校验：`packages/learning-core/src/learnflow_core/teaching_affordances.py`。
共享前端校验、Markdown 文本节点转换、引用查重与样式：`packages/learning-client/src/teaching/`；Web/Desktop 同时接入。

`POST /api/agent/sessions/{session_id}/teaching-affordances` 首先检查会话 ownership。可选 `message_id` 必须属于当前会话、为 assistant 且正文完全一致，随后才可读取或补充该条消息的元数据。浏览器生成的新回答尚未入库时不传该 ID，返回的元数据与正文一起走既有消息保存入口。正式 Tutor 传真实消息 ID，由接口保留原元数据并增量保存。相同正式消息重复请求复用结果。没有原文相同就猜测消息身份的回退。

元数据版本为 `learnflow-teaching-affordances/v1`，包含 `sourceText`、`followUps`、`highlights`。前端恢复时重新验证版本和完整原文；旧消息无元数据仍正常显示。重点必须是唯一出现的连续原文，重复、重叠、虚构或过长片段被过滤。Markdown 仅替换普通文本节点；代码、公式、HTML、链接、图片及其子节点不插入交互。跨格式节点的候选不强行拼接。

生成使用当前账户模型配置，缺失时沿用宿主模型配置；凭据不返回、不保存到元数据。接口无工具执行、EvidenceEvent 或 Kernel 写入。点击产生的后续教学回合仍走原 Tutor/事件入口，生成、阅读和引用不是掌握证据。

## 验证范围

候选校验、来源版本绑定、Markdown 保护、纸张去重、解释请求分类、无模型降级、API 来源/会话/用户隔离、缓存和元数据保留均有回归。双端前端构建、教学与纸张测试、后端回归及共享合同检查适用。

视觉验收使用真实 Markdown 组件和共享样式的临时浏览器预览，覆盖三个提示、公式/代码、引用点击和窄屏布局；该预览不是完整带登录应用的端到端验收。离线 mock 证明接线和约束，不证明模型候选的语义质量。未进行在线模型质量评测，也未运行 seeded demo（本次未修改其闭环）。

### 2026-09-13 验收记录

- Web 后端全量：1147 passed，2 个既有 skipped；桌面后端全量：1161 passed，5 个既有 skipped。
- 两端 `npm test` 均通过；新增/更新后的 `test:teaching` 分别 48、9 项通过。
- 两端 `npm run build`、`python3 scripts/check_shared_contracts.py`、`git diff --check` 通过。构建仍有已有大分块与桌面混合动态导入提示。
- 浏览器组件预览验证了三个追问回调、引用原文、重复点击仍为两张纸、Tab/Enter 打开引用、390px 窄屏长句自然换行。预览源文件已移除，截图保留于本机 `output/playwright/teaching-affordances-*.png`。
- 本轮本地实现与提交，不推送、不部署；未使用日常数据库，未运行在线模型质量评测或 seeded demo。
