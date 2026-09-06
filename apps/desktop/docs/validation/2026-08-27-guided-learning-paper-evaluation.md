# 文件驱动带领学习与纸张评测

日期：2026-08-27
注册表：`2026-08-27.6`

## 评测目标

1. Skill 是否按文件选择、带锚点阅读、文件内练习、独立验证推进。
2. 当前文件工具是否精确、answer-free、有 scope，且不会滥读五核与工作区。
3. 纸张是否支持多层嵌套、坏数据恢复和删除中间节点。
4. 讲义、练习、来源是否可滚动、可作为子纸打开，Safari 类布局是否可用。
5. 文件使用是否保持 EvidenceEvent 与五核边界。

## 自动化用例

| 层 | 用例 | 预期 |
| --- | --- | --- |
| Registry | 新 Skill、Tool、Capability、v6 runtime 对齐 | 无漂移 |
| Skill runtime | 三次有效输入推进到 `verification_ready` | 状态确定、无 LLM 判定 |
| Agent runtime | 当前纸精确读取一次 | ToolMessage 回灌，不重复调用 |
| Context | 普通讲解不默认读取画像；复习问题仍读取 | 最小充分上下文 |
| Practice | 当前练习观察不含答案 | 答案隔离 |
| Source | learner-owned 来源纸返回 provenance 和 trust boundary | 不执行来源指令 |
| Evidence | source opened/attached 与文件阅读零 Kernel mutation | 不误报掌握 |
| Paper tree | 多层祖先、坏父引用、重复 ID、环、删除中间纸 | 可恢复且不丢子树 |
| Frontend | TypeScript tests 与生产构建 | 通过 |

## 人工交互用例

- 从主对话打开讲义，再从讲义中的来源打开来源子纸。
- 在来源纸选中文字追问，确认新纸继承主对话与祖先文件上下文。
- 在练习纸滚动到末题并提交，确认答案在提交前不可见。
- 删除中间讲义纸，确认来源/追问子纸仍可从树状视图进入。
- 选择“讲义与练习共学”，确认 Tutor 每轮只给一个锚点或问题，正文不重复整份文件。
- 观察工具卡和流式正文，确认工具状态先展示、最终正文逐字到达且不混入旧草稿。

## 结果

### 自动化

- 后端完整回归：`200 passed`。
- 前端完整回归：`124 passed`，其中包含新增的纸张树恢复、祖先上下文和删除中间纸用例。
- 前端生产构建：通过。
- 注册表与 runtime：`learning_file_study`、`read_active_learning_file`、Action Board capability 和 generated manifest 对齐到 `2026-08-27.6`。

### 真实浏览器验收

使用本地正式 API、Vite 页面和 Playwright 完成以下路径：

1. 从项目来源打开 GitHub 来源纸，来源 API 返回 200；63 个 chunk 使用单一选择器与前后导航，没有生成 63 个并列按钮。
2. 来源纸的唯一滚动容器为 `overflow-y: auto`，`scrollHeight=1608`、`clientHeight=354`；真实鼠标滚轮后 `scrollTop=1170.5`。
3. 在来源纸点击“选中追问”后生成子追问纸；纸张关系树显示 `资料纸张 -> 来自另一张纸`，祖先链没有丢失。
4. 从项目文件总览打开“自注意力 QKV · 动态检测”，再放入当前对话纸张；嵌入纸的题头只有“练习 / 标题 / 选中追问”，不显示 `.lfexercise`。
5. 练习纸的唯一滚动容器为 `overflow-y: auto`，`scrollHeight=3633`、`clientHeight=354`；真实鼠标滚轮后 `scrollTop=1200`，可继续滚到最大值 3279。
6. 带领学习的方法选择器可见“讲义与练习共学”，并和 `guided_learning` 状态绑定。

### 未冒充已验证的部分

- 本次 Playwright 隔离浏览器身份显示“待配置模型”，因此没有用真实供应商执行一轮在线模型回答；工具卡先于正文、正文增量流式和超时失败路径由 agent runtime 自动化测试覆盖。
- 浏览器中没有实际删除刚创建的中间纸，以免污染验收项目；删除后子纸重挂由纯函数单元测试覆盖。
- 没有提交正式练习答案，避免给当前 learner 写入虚假学习证据；Attempt、判题和 EvidenceEvent 链继续由现有后端回归测试覆盖。
