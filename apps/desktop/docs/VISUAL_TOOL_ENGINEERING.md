# LearnFlow 图解与动画工具工程说明

## 目标与边界

图解和动画共享同一套受限 `VisualSpec`、确定性重放与 SVG 安全边界。模型不能提交 SVG、HTML、脚本、像素坐标或可执行表达式；它只能提供高层语义输入。布局、派生数值、时间线、质量门和降级由代码负责。

视觉产物不会直接写五核。查看、播放或回答动画内的预测题只属于当前界面交互，除非未来通过已登记的 `EvidenceEvent` 入口形成独立学习行为，否则不能视为掌握证据。

## 两级能力

### 通用结构视觉

`VisualSpec v3` 继续支持以下通用 abstraction：

- 计算机：协议序列、状态机、数据结构、代码追踪、张量形状流、系统结构。
- 数学：函数、概率分布、变换、推导、数学结构。

这些对象经过引用、有限数值、安全、重放和布局检查，但开放主题的模型计划只能标记为 `structural`。结构分不再等同于事实正确性，因而其质量分上限低于金标通过线。

### 可计算教学视觉

基础能力不足不能用“更长 prompt”掩盖。以下六类高层 semantic 由确定性编译器直接从输入推导结果：

- `matrix_operation`：输入矩阵 → 乘积、形状规则、焦点单元格点积。
- `graph_algorithm`：带权图 → Dijkstra 距离、前驱、确定顺序、最短路径和 relax trace。
- `natural_frequency`：总体、患病率、灵敏度、特异度 → TP/FN/FP/TN、阳性池与后验。
- `event_loop`：受限 JavaScript 日志、Promise 与 timer → 同步、微任务、任务的调度轨迹。
- `optimization`：平方距离目标、起点、学习率、步数 → 梯度、更新量和固定坐标轨迹。
- `convolution_trace`：小型输入矩阵、卷积核、步长与偏置 → 每个滑窗的逐元素乘积、求和、特征图、ReLU 与 2×2 最大池化。

模型和自然语言解析器都不能填写这些 semantic 的“答案字段”。结果由参考算法生成，并通过同一算法重新核验。精确命中时产物标记为 `derived_verified`；维度冲突、负权、未知异步结构或缺少必要参数时真实拒绝，不猜测。

## 生成管线

```text
用户请求
  → 保留原请求；省略表达优先从最近已验证视觉 artifact、其次从最近用户主题补充结构化有界锚点，并披露 contextEnriched/source
  → 从实际请求动态抽取主题词；无可恢复主题时 needs_input，模型零调用
  → 可计算领域三态
    → 参数完整：确定性 compiler + semantic proof（exact）
    → 只有概念、没有用户数据：明确标注教学示例（illustrative_example）
    → 已给部分参数但仍歧义：needs_input，不猜测
  → 非精确/长尾：provider 原生 JSON object 候选 VisualSpec
    → 本地只修复尾逗号或相邻容器间缺失逗号；不修改任何标量内容
    → 仍失败后至多一次结构化 model repair（仅 structural）
  → typed parser 与引用门
  → 请求主题充分性门：所有候选需主题覆盖；声明式过程必须由 semantic/帧覆盖，标题不能代替过程内容
  → deterministic replay
  → 高层 semantic adapter
  → 内部 SceneIR（唯一允许出现画布坐标的层）
  → 一次布局，多帧复用同一 geometry
  → 安全 SVG + scene manifest + quality report
```

### 声明式动画语法

确定性主题编译器负责可以从输入重新计算真值的机制；长尾主题不再要求模型直接手写帧、补丁或坐标。动画 Harness 另提供两种可复用的声明式宏：

- `process_storyboard`：模型只声明 3–12 个主题阶段、至少两个带引用的转移和一条连续路径。运行时要求恰有一个初始阶段，逐项验证 `from` 与上一步终态一致，再编译成受限 `state_machine`、`transition_state` 帧、初态、终态和 invariant。
- 声明式 `protocol_sequence`：模型只声明参与者和带唯一顺序的消息；运行时按顺序生成 `send_message` 帧和可重放终态。

`process_storyboard` 是 planner 内部 IR，不是新的持久化 VisualSpec 版本，也不是新工具。编译后只保存既有 VisualSpec v3 的 `state_machine` 或 `protocol_sequence`，因此旧 renderer、播放器、持久化读取和安全门可以直接复用。模型提供的阶段名称和因果关系仍只具有 `structural` 证据等级；只有专用真值编译器的结果可以标记为 `derived_verified`。

这形成三层泛化结构：

1. 视觉原语：节点、边、状态、消息、矩阵、曲线和稳定对象身份。
2. 声明式宏：把新主题的阶段/消息声明编译为受限时间线。
3. 真值编译器：对矩阵、图算法、概率、事件循环、优化和卷积等可计算机制重新推导并复核答案。

新增主题应优先复用前两层；只有存在可重算领域不变量且高频时，才增加第三层适配器。不得为每个课程主题增加专用工具或 renderer。

`SceneIR` 不属于模型协议。它包含面板、矩阵格、图节点与边、表格、频数树、比例条、代码区、队列、函数图、切线和箭头等已布局对象。动画帧只选择确定性 trace step，不携带可伪造的距离、后验或下一迭代点。

## Prediction gate

预测—揭示是帧元数据，不是伪造的状态 patch：

- 播放进入 gate 自动暂停。
- 下一步、End、滑块和自动播放都不能越过未回答 gate。
- 选择后才显示解释并允许继续。
- replay 清除已回答 gate，重新执行“先预测、后揭示”。
- reduced-motion 关闭自动播放，但保留 gate 约束和逐帧导航。

预测选择只保存在组件本地，不直接形成学习证据。

## 安全、真值与质量

- 禁止 `eval`、任意脚本、任意 SVG/HTML、悬空引用和非有限数值。
- 静态图和动画都运行领域真值检查；核心事实错误直接拒绝，不能用总分补偿。
- Dijkstra 的生产推导与独立 Bellman–Ford oracle 交叉核验；浮点改善使用严格大小关系，不能用固定 epsilon 吞掉真实更短路径。
- `structural` 只表示 schema、引用、重放、布局和 SVG 安全通过。
- `structural` 产物还必须单独通过请求主题充分性门；对声明式过程，结构分和标题都不能让“输入→处理→输出”等占位语义获得可用状态。
- `derived_verified` 表示输入已被确定性解析，结果由版本化编译器推导并复核。
- 持久化产物不能只靠 compiler 名称获得 `derived_verified`：读取时必须用 provenance 中的原请求重新编译，并逐字段比对 semantic、时间线、状态、文案与无障碍信息。
- `scene manifest` 记录 viewport、语义区域、稳定对象 ID 与 bounds；测试不再靠猜 SVG 字符串判断布局。
- 图边路由还执行解析几何门，检查曲线不得穿过非端点节点、权重标签不得遮挡节点或其他边；稠密图无法诚实排布时明确拒绝，不把表面 bbox 的 `0 collision` 当作成功。
- 动画每一帧的 SVG `<desc>`、屏幕阅读器文本与可见字幕只描述当前状态；全局总结不能越过 prediction gate 泄露未来答案。
- v3 的 schema、planner prompt 与 renderer 一起版本化。合法 v2 产物经过旧封闭 schema 和 provenance tuple 校验后显式迁移到 v3；v1 保持只读兼容。把 v3-only semantic、patch 或 compiler 声明伪装成 v2 会被拒绝。

## 精确匹配与失败语义

确定性能力优先于模型，以降低已知问题的延迟并提高成功率；但只在必需参数完整、语义唯一时启用。主题级 contains 匹配不再构成 fallback 依据：

- “TCP 四次挥手”不得降级成“三次握手”。
- “联邦学习投毒防御”不得降级成普通训练轮。
- Dijkstra 负权、矩阵内维冲突、无法可靠转为整数频数的 Bayes 请求直接拒绝确定性编译。
- JavaScript 只接受受限的顶层 `console.log`、`Promise.resolve().then` 与零延时 `setTimeout` 语句；函数声明、类、未知异步结构、注释或字符串中的伪代码均不会被正则误当成执行轨迹。
- 模型候选必须与请求分类出的 domain/abstraction 完全一致；不相关但 schema 合法的图也会被拒绝。
- 模型生成的长尾动画暂不允许 prediction gate，因为其文案和未来状态不能被重新证明；gate 只来自确定性编译器。

模型失败后，只有精确匹配且经过语义证明的模板允许产生降级产物；否则返回真实失败原因。

### 调用路径与预算

- Web 与 Desktop 共用 `visual-tool-execution.ts`、VisualSpec 编译器、验证器和 renderer；Desktop 不再返回空 `toolRuns` 后绕过视觉能力。
- Desktop 专用 `/agent/sessions/{session_id}/visual-plans` 只返回模型候选文本，并校验桌面令牌、learner 与 session ownership；它不接收 SVG，不执行代码，也不写学习证据。
- 可计算精确输入和教学示例均为零模型调用。长尾图解首轮/修复预算为 60/40 秒，动画为 90/60 秒；总重试次数固定为一次，不能用改写参数无限重试。只有显式视觉请求会把 Agent 总回合扩到图解 210 秒、动画 270 秒，普通 Tutor 仍保持原预算。
- 每次 Tool Run 记录 `requestedKind`、`effectiveKind`、`contextEnriched`、`generationSource`、`compileStatus`、`plannerAttempts`、`syntaxRepairApplied`、每次尝试的预算/耗时/结果/错误类型与 `outcomeStage`；运行轨迹同时显示编译、规划返回、标点修复、验证、限次修复、降级和渲染阶段，不能再用 nominal completed 代替真实成功率。
- 成功产物向 Tutor 只投影有界 `grounding`（摘要、帧标题、帧描述、非颜色状态线索、语义变化数），不回灌 SVG。Tutor 只能根据这份投影描述“动画展示了什么”，主题常识不能补成产物事实。
- 显式图解/动画意图在模型前确定性执行且每轮只允许对应的一类视觉调用；执行后从本轮工具面移除两类视觉工具和视频搜索，失败不能漂移到另一视觉形式或形成重复搜索回路。

## 金标验收

端到端金标由三张图解和四段动画组成：

1. 矩阵乘法：矩阵网格 + 形状约束 + 焦点点积 + 迁移题。
2. Dijkstra 静态图：带权图 + 距离/前驱表 + 路径与更新依据。
3. 贝叶斯自然频数：条件树 + 阳性汇流 + 真实比例条 + 后验公式。
4. JavaScript 事件循环：固定六区 + 稳定 callback token + prediction gate。
5. Dijkstra 动画：固定图与表 + settled/relax trace + prediction gate。
6. 梯度下降：固定坐标和曲线 + 稳定当前点 + 切线/更新箭头 + prediction gate。
7. CNN 卷积：输入矩阵与卷积核 + 逐窗乘加 + 特征图 + ReLU + 最大池化，所有数值由编译器推导。

每项必须满足：质量分不低于 85、`derived_verified`、核心真值全通过、零区域碰撞/越界、JSON 往返可重放。动画还必须满足稳定对象身份、固定 geometry、直接 seek 与顺序播放结果一致。参数变形和 mutation case 用于防止实现只记住七道题答案。

### 五个评估维度

| 维度 | 不再接受的替代指标 | v3 的直接证据 |
|---|---|---|
| 实用性 | “成功生成一张 SVG” | 七个真实教学任务是否包含读图所需的对象、公式、状态、迁移问题和无障碍描述 |
| 效率 | 只比较模型响应时间 | 可计算金标零模型调用；同时记录编译、验证、渲染时间和动画完成时间 |
| 成功率 | JSON 能解析 | 金标、参数变形、边界输入和 mutation case 同时通过真值、重放、安全、布局与泄漏检查 |
| 启发性 | 有动画或有提问 | 是否促成预测、解释、改输入和迁移；必须另测答题质量与学习迁移，不能由点击量推断 |
| 架构合理性 | 文件分层看起来整齐 | 版本化 semantic → reference derivation → trace → SceneIR → renderer → verifier，且每层可单测、可拒绝、可重放 |

此前的通用 v2 管线主要证明结构安全和可渲染，不能证明领域事实正确；v3 为五类可计算主题增加 reference algorithm、`derived_verified`、prediction gate、scene manifest 和显式失败语义。通用长尾模型计划仍保留，但最高只计为 `structural`，不能跨过金标事实线。

## 研究依据与取舍

工程项目提供的是架构先例，不是教学效果证明：

- [Vega-Lite 论文](https://idl.cs.washington.edu/files/2017-VegaLite-InfoVis.pdf)与[官方文档](https://vega.github.io/vega-lite/docs/)把高层声明式 spec 编译为低层数据流和渲染描述。这支持 LearnFlow 把模型边界停在教学 semantic，不允许模型直接提交 SVG、坐标或 callback。
- [Motion Canvas animation flow](https://motioncanvas.io/docs/flow/)用 generator/yield 描述显式时间顺序；[Manim Scene](https://docs.manim.community/en/stable/reference/manim.scene.scene.Scene.html)分离对象、动画和场景。LearnFlow 借鉴显式 timeline 和稳定对象身份，但不执行模型生成的 TypeScript/Python。
- [ELK 的算法分阶段设计](https://eclipse.dev/elk/documentation/algorithmdevelopers/algorithmimplementation/algorithmstructure.html)与[Layered layout](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html)支持把区域约束、节点放置、边路由、标签放置和压缩拆开。LearnFlow 当前用小型确定性 SceneIR 实现同样的职责边界，并以 manifest 检查区域归属、碰撞和越界。
- [Cytoscape.js layout API](https://js.cytoscape.org/#layouts)进一步说明图的语义元素和布局算法应可替换；LearnFlow 因安全、体积和可重复测试要求，暂不在服务端引入运行时布局插件。

教学论文约束了“何时该动画、怎样交互”，也提醒我们不要把交互本身当成效果：

- Mayer 与 Chandler 的[分段动画实验](https://doi.org/10.1037/0022-0663.93.2.390)支持学习者控制的短段推进，主要改善迁移而非简单保持；因此动画提供暂停、逐帧、重放和 reduced-motion，而不是强制连续播放。
- Mautone 与 Mayer 的[signaling 实验](https://doi.org/10.1037/0022-0663.93.2.377)支持用标题、结构线索和因果提示突出当前组织；因此每帧保留区域角色、当前状态和非颜色线索，同时禁止这些线索提前给出答案。
- Brod 等人的预注册研究[When Generating a Prediction Boosts Learning](https://doi.org/10.1016/j.learninstruc.2018.01.013)发现预测在特定任务上改善学习，且违反预期后的惊讶反应与学习相关；因此 gate 必须真实阻断 reveal 并立即给反馈，但只放在有意义的关键转折。
- Höffler 与 Leutner 的[静态图与教学动画元分析](https://www.leibniz-ipn.de/en/research/publications/instructional-animation-versus-static-pictures-a-meta-analysis)报告动画平均优势不大且高度依赖是否表征真实过程；因此矩阵结果和自然频数默认是图解，事件循环、Dijkstra trace 和梯度更新才使用动画。
- Hundhausen、Douglas 与 Stasko 的[算法可视化 meta-study](https://users.cs.duke.edu/~rodger/jflappapers/Hundhausen2002.pdf)以及 Naps 等人的[参与分类](https://doi.org/10.1145/782941.782998)都指出“学习者怎样使用可视化”比单纯看见什么更关键；其中 prediction 也存在耗时增加而后测无显著优势的反例。因此后续实验必须同时测迁移、错误预测、帮助水平和完成时间，不能以 gate 数或播放完成率宣称教学成功。

这些研究没有证明本实现已经提高学习效果。它们决定了架构和验收假设；真正的启发性仍需通过静态/动画、被动/分段、预测/不预测的对照实验来验证。

## 修改影响

本模块扩展视觉内部 schema、上下文 Harness、Desktop 规划桥接、编译器、renderer、播放器和测试，不改变三类主 Agent、五核语义、`EvidenceEvent`、Action Board capability 或既有视觉工具 ID。`convolution_trace` 是 VisualSpec v3 的向后兼容新增分支；旧产物与调用无需迁移。新增视觉产物仍由 `learning_design_agent` 所有，并保持只读教学产物边界。
