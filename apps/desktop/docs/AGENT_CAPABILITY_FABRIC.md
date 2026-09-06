# LearnFlow Agent 感知与行动能力总表

这份文档回答一个问题：产品里已经存在的对象，怎样真正成为 Agent 的眼睛、手和可恢复工作空间。

## 一分钟逻辑

```text
页面与 Session
  -> Tutor 判断 free / explain / learn / plan
  -> 按 capability 读取 ContextPacket、学习路径、概念图和当前任务
  -> Tool 执行搜索、视觉生成、路线提案或学习 Skill
  -> 学习者确认有副作用的提案
  -> EvidenceEvent -> deterministic reducer -> 五核与 Memory Graph
  -> 下一轮重新读取最新投影
```

LearnFlow 只有三类主责任接口：Tutor 控制交互；Learning Design 生成路线、内容和评估规格；Practice 验证提交与迁移。Skill 是可编排的教学流程，Tool 是一次可调用能力，Workbench 是 Tool 和对象出现的页面空间。它们都不能成为第四个主 Agent。

## Agent 的感知空间

| 感知对象 | 正式入口 | 进入什么上下文 | 当前状态 |
|---|---|---|---|
| 五核状态与长期记忆 | `vnext_five_kernel_profile_reader` -> `/api/learner-state/context` | 每轮按 `global_tutor / learning_task / learning_plan` 选择有预算 ContextPolicy | 已接入；正式后端不可用时才显示离线演示回退 |
| 精确路径定位 | `vnext_learning_path_exact_reader` | 先按稳定 ID、标题、别名读取官方/个人节点；未命中时只返回进入模糊检索的指示 | 已接入 |
| 模糊路径检索 | `vnext_learning_path_fuzzy_reader` | 仅在精确未命中后做确定性混合排序；保留歧义和 graph gap，永不携带 mastery | 已接入 |
| 四类学习图对齐 | 非模型可见兼容调度器 + Alignment Projection | 显式连接课程路径图（含个人覆盖层）、个人概念图、来源知识领域和已确认路线；保留 gap | 已接入 |
| 已确认长期路径 | `active_learning_path_plan` | `learning_plan` ContextPacket 的 Structure 热头与 Value 目标 | 已接入 |
| 个人概念学习图 | `personal_concept_graph_reader` | Knowledge 节点内部历程 + Structure 节点间关系 | 已接入 |
| 原子学习任务与 Skill 子状态 | `vnext_learning_task_runtime` | 正式 AgentSession、SkillRun、LearningTask、当前步骤、循环次数和 learner-reply 边界 | 已接入；浏览器只保留投影/离线回退 |
| 页面、选区与纸张分支 | `selection_followup_context` | 主对话、祖先纸和当前纸的有界分支上下文 | 已接入 |
| 外部计算机知识来源 | `computer_knowledge_search` | 分层、不可信 Evidence Bundle；规范和官方来源优先 | 已接入 |

ContextPacket 是只读投影，不是第二份记忆。它必须公开 scope、策略、证据、冲突、省略项和 token 预算。Tutor 不允许直接读取数据库表拼接“全量画像”。

## Agent 的手

| Capability | Tool | 谁决定 | 副作用与确认 |
|---|---|---|---|
| 搜索计算机知识 | `computer_knowledge_search` | Learning Design | 只读，无五核写入 |
| 生成静态学习图解 | `learning_diagram_generator` | Learning Design | 共享 VisualSpec，确定性 SVG，无掌握证据 |
| 生成逐帧学习动画 | `learning_animation_generator` | Learning Design | 共享 VisualSpec 时间线，确定性 SVG 帧，无掌握证据 |
| 执行原子学习任务 | `vnext_learning_task_runtime` | Tutor + 确定性 Skill runtime | 流程事件可恢复；完成不等于掌握 |
| 形成长期路线提案 | `vnext_learning_path_planner` | Learning Design 的确定性图规划器 | 只生成 proposal，LLM 只解释 |
| 形成个人路径节点候选 | `vnext_personal_path_node_proposer` | Tutor 在确认 graph gap 且取得来源后调用 | 只生成 proposal；重复检查；不改 mastery |
| 确认、修订或归档长期路线 | `vnext_learning_path_plan_manager` | 学习者 | 点击确认后写 Structure + Value 事件，保留版本历史 |
| 添加个人路径节点 | `vnext_personal_path_node_runtime` | Tutor 提案，学习者确认 | 图谱缺口先联网研究，确认后写个人覆盖层 |
| 记录概念自述与关系 | `concept_self_report_gateway` | 学习者明确原文 | 写 Knowledge/Structure 的 unverified 事件，禁止 mastery inference |
| 修改明确资料 | `vnext_five_kernel_explicit_editor` | 学习者 | 按核路由到 profile、concept、plan 或 memory gateway |
| 纠正、撤回或归档 Claim | `learner_memory_manager` | 学习者 | 原历史不删除，当前有效版本更新 |
| 提交复习与纠错变式 | `deterministic_assessment` | Practice | `/review` 统一提交由服务端在 `evaluate_review_attempt / evaluate_transfer_variant` 间分派；幂等重放不含答案 |

任何 Tool 如果需要改变学习者状态，只能提出或追加已登记 EvidenceEvent。唯一直接 KernelState writer 仍是 `five_kernel_reducer`。

学习任务队列也是对象 ACI，而不是一组前端按钮：`LearningTask.available_actions` 来自证据重建后的状态机，卡片展示阶段进度并返回原学习现场；前端不能跳过练习、独立验证或复习转交门。

## Skill 怎样成为真正流程

Skill 不是 prompt 模板，而是绑定 Tutor 状态的、可循环的确定性教学剧本。当前首批 Skill 绑定 `guided_learning`：每个 Skill 自己声明第一步、允许的转移、需要学习者回答的步骤、提示循环和验证交接。模型只能在当前步骤中生成表达，不能跳过 learner-reply gate 或自行宣布完成。

```text
guided_learning
  -> selected_skill
  -> current_skill_step / visible substate
  -> learner reply or support loop
  -> next deterministic step
  -> Practice verification handoff
```

因此：Tool 是一步动作；Skill 是把若干动作、对话和验证组织成可恢复流程；Workbench 是流程所处空间；Event 是发生过什么的权威记录。

## 长期学习路径闭环

1. Tutor 识别跨多个任务、阶段、真实产物或发展方向的目标，进入 `learning_plan`。
2. Context API 使用 `learning_plan` policy，优先读取 Structure、Knowledge、Human、Value，并带入活动长期路线。
3. 精确 Reader 先查稳定 ID、标题和别名；只有未命中才进入模糊 Reader。歧义交给学习者选择；明确 graph gap 才联网搜索并形成个人节点 proposal。
4. Path Planner 沿硬/软前置关系生成目标、路线、阶段里程碑和时间范围；自报掌握只调整以后验证顺序，不删除前置。
5. Tutor 解释取舍，页面展示“尚未写入”卡片。
6. 学习者点击确认后，Plan Manager 写入：
   - Structure：活动路线、目标节点、里程碑、路径位置和返回锚点。
   - Value：与该路线绑定的明确长期目标。
7. `/learning-path` 用不同视觉标记显示规划目标、里程碑、路线节点和路线边；归档保留历史并撤出活动上下文。
8. 后续规划对话重新读取活动路线，围绕偏离、调整、下一阶段和项目化建议继续，而不是每次重新生成一条无状态建议。

长期路线是柔性导航对象，不是强制课程表，也不证明任何节点已经掌握。

## 五核具体改写协议

五核不是只有“行为自动归约”这一种入口。学习者可以明确改写，但每个核的方法不同：

| 核 | 学习者可直接做什么 | 实际写入 | 明确禁止 |
|---|---|---|---|
| Knowledge | 修改知识背景原文；提交具体概念接触、误解、题目或理解自述；纠正 Claim | `profile_updated` 或概念 observation；Claim correction | 自述直接升级 mastery |
| Structure | 提交阻碍、推动、类比、联想关系；确认/修订/归档长期路线；管理个人节点 | concept relation 或 path plan events | 用结构关系替代概念掌握结论 |
| Human | 修改每周投入、偏好形式和支持需求；纠正或归档不准确记忆 | `profile_updated` + learner correction | 推断人格、医学状态或固定学习风格 |
| Value | 修改关注方向；确认职业/研究方向；确认或归档长期路线目标 | `career_goal_confirmed`、Value claim 或 path plan events | Agent 替学习者确认长期目标 |
| Practice | 纠正/撤回已有 Claim；提交可检查题目、代码或项目产物 | graded attempt、artifact、retry、transfer events | 靠自述新增正向能力结论 |

原始 EvidenceEvent 不被覆盖。所谓“修改”是新证据、纠正、替代、撤回或归档；Memory Graph 通过版本和边解释当前认识为何变化。

## 产品对象到权威对象的映射

| 产品对象 | 运行权威 | 五核关系 |
|---|---|---|
| Conversation / Paper | 工作区与消息历史 | 本身不等于学习证据；选区只提供分支上下文 |
| Tutor Mode | Session/浏览器事件投影 | 是交互姿态，不是 Kernel |
| Learning Task | 正式任务队列 + Skill runtime | 完成是流程里程碑，验证事件才改变 Knowledge/Practice |
| Learning Skill | 注册表 + 确定性步骤机 | 决定教法流程，不直接写 Kernel |
| Learning Path Graph | 官方 DAG + 个人事件覆盖层 | Structure 导航；自报状态不是 Knowledge mastery |
| Long-term Path Plan | 版本化计划事件 | Structure 路线 + 学习者确认的 Value 目标 |
| Personal Concept Graph | ConceptAnchor 只读重建投影 | Knowledge 管节点内部，Structure 管节点间边 |
| Module / Claim | Memory Graph 版本投影 | 可纠正长期认识，不替代原始 EvidenceEvent |
| Project | 真实产物、来源、关卡和工作区 | Structure/Value 定位，Practice 由真实产物与验证形成 |

## 当前已用与仍待深化

已经形成真实闭环：唯一 vNext Agent Turn Graph、正式五核 ContextPacket、按 mode 选择 policy、正式
Session/SkillRun/LearningTask、四类学习图显式对齐、路径 Reader、图谱缺口搜索、个人节点确认、长期路线
proposal/确认/归档、路径图目标投影、概念自述、Claim 修订和正式任务队列。固定 Agent 评测覆盖规划
读取、图缺口研究、“不知道”支架、Claim 冲突、工具失败、项目来源约束和任务完成/掌握分离。

仍需后续深化但不能用假实现掩盖：项目创建仍只是规划态中的 project seed；长期路线还需要转成可确认的阶段任务集合；Practice 正向证据需要更多代码执行器与项目验收；星图布局可继续升级，但视觉实现不得改变路径与证据权威。
