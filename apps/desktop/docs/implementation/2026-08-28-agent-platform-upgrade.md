# LearnFlow Agent 平台七项升级实现说明

日期：2026-08-28
范围：视觉工具、教学 Skill、账号与模型凭据、人因适配、学习来源与代码纸张、本地 Agent Broker、架构真实性与代码质量。

## 1. 总体边界

本轮没有新增第四类主 Agent。所有用户侧控制仍由 `tutor_agent` 承担，教学内容与视觉候选由 `learning_design_agent` 负责，正式作答、判题和纠错反馈由 `practice_agent` 负责。

```text
用户输入 / UI 操作 / Tool 结果
  -> Tutor Turn Graph 或确定性产品 Runtime
  -> 产物、候选方案或带 scope 的 EvidenceEvent
  -> five_kernel_reducer
  -> KernelMutation -> KernelState -> Memory Graph
```

图解、动画、文件解析、讲义/习题生成、本地 Agent 运行和代码草稿运行都不能直接证明掌握。只有登记过、带 learner/project/checkpoint/session 归属的正式学习证据才可能进入 reducer。

## 2. 图解与动画：同一对象底座，两个专用 Tool

模型可见接口拆成：

- `learning_diagram_generator`：生成一个稳定、可检查的知识状态图。
- `learning_animation_generator`：生成可重放的状态变化时间线。

两者共享 `VisualSpec v2`，而不是分别维护 SVG 模板和动画脚本。核心对象是有限节点、语义关系、初始状态、typed patch、invariant、final state、provenance 与 quality。模型只填写候选结构；解析、引用校验、预算、布局、重放和 SVG 清洗由确定性运行时完成。

计算机知识优先识别调用序列、状态机、数据/张量流、内存布局、树图、并发时间线和分层系统；数学知识优先识别数轴/坐标、函数变化、线性变换、矩阵形状、几何约束、概率分布、微积分过程和证明步骤。动画重放失败时明确降级为图解，并返回 `degradedTo=diagram`，不再用静态图冒充动画。

实现入口：

- `frontend/server/learning-visual-spec.ts`
- `frontend/server/visual-spec/`
- `frontend/src/VisualArtifact.tsx`
- `docs/VISUAL_TOOL_ENGINEERING.md`

## 3. 输入栏能力与教学 Skill

`ComposerCapabilityPicker` 将方法和工具分成两个紧凑、键盘可用的选择器：

- 方法只在带领学习态可用，值直接来自 `LearningSkillId`。
- 工具使用 `TutorToolChoice`，并根据对话资料、状态和能力禁用不可用项。
- 选择器不复制 Skill 状态机，也不伪造用户输入推进流程。

教学方法由正式 `SkillSpec v2 + SkillRun` 驱动。每一轮最多发生一次确定性子状态迁移；Tutor 只能渲染当前步骤、选择允许的只读工具并提出下一个真实学习动作。支架预算、循环上限、验证入口、项目/关卡/任务/session 归属和 checkpoint 任务复用均由 Runtime 控制。Skill 运行本身只产生零 target 生命周期事件；正式 Attempt 或明确的人因适配事件才进入五核。

实现入口：

- `frontend/src/ComposerCapabilityPicker.tsx`
- `backend/app/services/learning_skill_runtime.py`
- `backend/app/services/tutor_service.py`

## 4. 密码账号与按账户模型凭据

账号系统采用：

- Argon2id 密码散列；旧 scrypt 登录成功后原位升级。
- HTTP-only 会话、空闲/绝对过期、`auth_epoch` 全会话失效、CSRF token、Origin/Sec-Fetch 校验和数据库速率限制。
- `account_number` 是稳定展示编号，不替换数据库主键；Ryan 被迁移为 `account_number=0` 和 `admin`。
- 模型 API Key 以 AES-256-GCM、服务端 KEK、每账户 AAD 加密。浏览器与管理员列表永远拿不到解密值；管理员只看到是否已配置。
- Vite Tutor Runtime 通过仅服务端可持有的 bridge token，结合当前登录 cookie/Bearer，按请求解析该账户的 key。生产环境缺 bridge 或缺账户 key 时失败关闭，不回退到全局 key；本地开发保留显式迁移回退。
- API Key 测试是当前账户自己的操作；账号、凭据和学习者数据都做 ownership 校验。

上线前必须以部署秘密提供 `LEARNFLOW_AUTH_SECRET`、凭据 KEK 和 runtime bridge token，并在 HTTPS 后设置 Secure Cookie。任何 `.env`、密钥或数据库都不提交仓库。

实现入口：

- `backend/app/services/auth.py`
- `backend/app/api/auth.py`
- `backend/app/db/database.py`
- `frontend/server/account-model-credential.ts`
- `frontend/src/AuthGate.tsx`
- `frontend/src/AccountModelSettings.tsx`

## 5. 人因核：同轮显式适配，不做人格推断

浏览器只从学习者的明确表达提取有限类型：

- `pace_adjustment`
- `format_request`
- `cognitive_load`
- `frustration`
- `support_need`

类型化信号在 Tutor 装配本轮上下文前，通过 `vnext_human_adaptation_requested` 写入正式事件链，因此可以同轮改变讲解步幅、呈现形式和支持方式。状态有效期为 8 小时；过期后从 head summary、facet state 和 Agent ContextPacket 中同时消失。原文不进入长期 Human Module，普通答错、“我不会”“我不懂”和低分也不会被推断为情绪、能力或固定学习风格。

实现入口：

- `frontend/src/human-adaptation.ts`
- `backend/app/api/learner_state.py`
- `backend/app/services/learning_runtime.py`
- `backend/app/services/five_kernel_context.py`

## 6. 学习来源格式与代码纸张

首批面向高职、本科和项目学习的格式：

| 类别 | 格式 | 处理方式 |
|---|---|---|
| 教材与讲义 | PDF、DOCX、PPTX | 按页、段落/表格、幻灯片抽取，保留来源位置 |
| 数据与实验 | XLSX、CSV | 按工作表、单元格/行抽取，保留公式与坐标 |
| 通用文本 | TXT、Markdown、RST | 严格解码和分段 |
| 编程学习 | IPYNB、常见源代码与配置文件 | Notebook 按 cell；代码按语言和代码段渲染，不执行 |

上传阶段执行扩展名、MIME、magic、OOXML 结构、压缩预算、文件/文本预算和秘密检测。宏 Office、归档、可执行文件、伪装二进制、损坏容器和超预算文件直接拒绝。解析结果只成为带 provenance 的领域来源，不等于学习者已掌握。

代码纸张提供多文件标签、草稿、行号、语言标签以及 stdout/stderr/result 分区。当前正式提交只允许单文件；多文件提交按钮明确禁用，避免假装已支持项目级判题。

实现入口：

- `backend/app/services/file_formats.py`
- `backend/app/services/chunker.py`
- `frontend/src/SourceFilePage.tsx`
- `frontend/src/CodePaperWorkbench.tsx`

## 7. Tutor 调用本地 Agent

本地代码 Agent 作为 Tutor 所有的 `local_agent_broker` 工具，不是第四个主 Agent。用户先链接项目工作区并选择已登记 Profile，首次确认后才在隔离副本中运行；第二次确认才允许把选中的 diff 应用回真实工作区。

- Codex adapter 固定使用参数数组，不通过 shell，也不接受任意命令模板。
- 快照排除 `.git` 内容、`.learnflow`、密钥、符号链接、缓存和构建目录，并记录包含/跳过清单及 SHA-256。
- Agent 看不到学习数据库、五核或正式学习对象。
- 网络与主机读取边界无法证明时显示 `unmanaged`，不能伪装断网或沙箱。
- 真实工作区 hash 变化会把结果标记为 stale；删除和移动逐项确认。
- 运行、测试成功和 diff 都是操作审计，不是学习证据。

实现入口：

- `backend/app/services/local_agent_broker.py`
- `backend/app/api/local_agent.py`
- `docs/DESKTOP_WORKSPACE_SECURITY.md`

## 8. 真实性与工程治理

注册表发布项现在有 `implemented / optional_unimplemented / deprecated` lifecycle 和可解析 implementation binding。`GET /api/architecture/validate` 分开报告 schema 与实现校验，只有二者同时通过才返回 `valid=true`。没有真实入口的 workflow、studio 或资源能力保留稳定 ID 但标为未实现，不再进入 available capabilities。

代码执行默认和生产环境失败关闭。只有显式开发配置 `trusted_local_process` 才允许主机进程，并返回未隔离声明。正式提交在执行不可用或没有确定性规则时不创建 Attempt、EvidenceEvent 或 KernelMutation。

Seeded demo 的固定 `safe_average` 练习使用独立的确定性 AST 合约判题器：只解析语法树并检查既定实现约束与固定样例，不导入、不执行学习者代码，也不复用通用代码执行入口。判题结果显式返回 `execution_performed=false`；普通代码题在没有正式沙箱时仍然失败关闭。

本轮同时把视觉规划、账号凭据、Human 信号和 Composer 能力从大型入口文件中拆成独立模块，减少 flag 组合与嵌套职责。仍需后续治理的热点和上线条件记录在对应测评报告中。

## 9. Contract impact

- 架构注册表版本：`2026-08-28.6`。
- 数据库迁移：账号编号、角色、会话 epoch、加密凭据 envelope 与限流状态；旧学习者主键和外键不变。
- 新的视觉 Tool ID、Human EventContract、SkillRun 状态字段均保持旧客户端可降级读取。
- Seeded demo 的 AST grader 作为 `seeded_demo` 的内部实现 binding 登记，不扩大通用代码执行能力。
- 五核仍只有 `five_kernel_reducer` 一个直接 writer。
