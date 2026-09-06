# 动态习题与检测引擎

## 一分钟逻辑

```text
Tutor 识别当前原子学习任务需要练习或检测
  -> dynamic_practice_loop（Playbook）
  -> Learning Design 依据 target skill / purpose / difficulty 提出候选题
  -> dynamic_practice_generator（受限 Tool）
  -> 确定性静态门：schema、答案、重复、scope、答案安全
  -> ConceptQuestion 练习文件（uncalibrated，生成不等于掌握）
  -> 学习者正式提交
  -> Practice Agent 确定性判题
  -> LearningAttempt + EvidenceEvent
  -> Knowledge / Practice；显式反思才可补充 Structure / Human
  -> 纠错、同构变式、间隔复习
```

## 为什么这样设计

自动出题需要把“测什么”先表达为认知或能力蓝图，再按题目模型生成实例；模型生成文本不是有效性本身。[Automatic item generation 综述](https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2023.858273/full)把流程概括为知识/技能、认知模型、题目模型与算法化生成。认知诊断领域也要求显式维护题目—技能关系，而不是只把答对率当作能力；参考 [DINA 与 M-matrix 的 AIG 研究](https://www.jstage.jst.go.jp/article/jbhmk/50/2/50_131/_article)。

题目通过 schema 不等于具有经过验证的测量效度。因此每个自动生成题都标记为 `psychometric_status=uncalibrated`，并将“题目质量检查”与“学习者作答评估”分离。真实题目质量仍需要内容专家、试测、项目分析或 IRT 等后续证据；参考 [自动题目质量与效度研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC10700404/)。

互操作和实现参考 [1EdTech QTI](https://www.1edtech.org/standards/qti) 的题目/响应分离、[PrairieLearn Elements](https://docs.prairielearn.com/elements/) 的参数化与答案组件，以及 [nbgrader](https://nbgrader.readthedocs.io/en/stable/user_guide/creating_and_grading_assignments.html) 的答案/测试隔离。代码排序题采用 Parsons 类任务；自适应 Parsons 的教育研究显示，可以根据学习者表现改变支架，但本实现仍把策略选择交给确定性 Playbook，而不是模型分数推断，参考 [Adaptive Parsons Problems](https://dl.acm.org/doi/10.1145/3501385.3543977)。

## 当前题型

| response schema | 适合的计算机任务 | 判定方式 |
|---|---|---|
| `single` | 概念辨析、复杂度、协议语义、安全边界 | 唯一索引完全匹配 |
| `multi` | 多条件成立、漏洞成因、系统性质 | 答案集合完全匹配 |
| `judge` | 定义与反例、命令/配置断言 | 二元索引匹配 |
| `ordered_blocks` | Parsons 代码排序、协议时序、算法步骤、运维流程 | 完整排列匹配 |
| `exact_text` | 标识符、短命令、确定术语、短结果 | 规范化文本匹配 |
| `numeric` | 复杂度计数、分页地址、调度时间、张量形状数值 | 数值与显式容差 |
| `code_output` | 程序输出、SQL 结果的规范文本 | 已验证输出匹配 |
| `trace_table` | 循环/递归、数据结构状态、调度、并发交错、张量 shape 流 | 二维状态表匹配 |

题目设计提示还覆盖：数据结构状态跟踪、算法复杂度、SQL 结果、网络协议时序、操作系统调度/分页、并发交错、安全漏洞判断和测试用例设计。主观作文、开放架构设计与无法确定性验证的代码题不进入当前正式检测；它们可作为对话练习，但不能复用本评分契约。

## Tool、Skill 与 Agent 边界

- `dynamic_practice_generator`：根据蓝图物化新题集。
- `similar_practice_generator`：保持 `target_skill`、关键步骤与认知要求，改变数字、变量、情境或表面表达；`radical_features` 记录保持项，`incidental_features` 记录变化项。
- `practice_quality_inspector`：只读静态质量报告，不评分学习者。
- `dynamic_practice_loop`：Tutor 所有的 Playbook，组合生成、作答、纠错、变式与复习。
- Learning Design Agent：提出题目候选，不决定题目通过、学生得分或掌握。
- Practice Agent：正式提交后的确定性评分、纠错与复习交接。

三个 Tool 都有稳定 schema、scope、幂等键和可展示 ToolRun。生成工具只有在 `guided_learning + formal LearningTask + checkpoint` 同时成立时才暴露。后端重新验证 learner ownership，不能信任前端或模型提交的 scope。

习题候选的模型输出预算按题量有界增长（当前上限 7,000 tokens），避免推理模型在固定的小配额内只完成推理而没有产出完整 JSON。同一正式学习任务在一个 Tutor 回合内只允许执行一次同类昂贵生成；模型仅修改标题、难度等表面参数重复调用时，Harness 会确定性拦截并要求它使用已有观察或透明结束。这两个约束同时保证产物完整性和回合时间预算。

## 事件与五核

| 行为 | 事件 | 核 |
|---|---|---|
| 生成动态题集 | `practice_file_generated` | 无 |
| 生成同构变式 | `practice_variant_generated` | 无 |
| 检查题目质量 | `practice_quality_inspected` | 无 |
| 打开/拖入纸张 | `learning_file_opened/attached_to_chat` | 无 |
| 正式概念题提交 | `concept_attempt_evaluated` | Knowledge + Practice |
| 明确填写“某概念卡住我” | 同一正式提交事件中的显式反思 | Structure 短期卡点 |
| 明确选择“某种帮助这次有效” | 同一正式提交事件中的显式反思 | Human 短期支持偏好 |

答错、不会、跳过和缺失输入仍必须区分。一次正确只形成一次验证证据；未校准题不能单独提升稳定掌握。同构变式只有在独立正式作答并通过迁移契约后，才可能产生更高等级证据。

## UI 与流式协议

工具开始时服务端发送 `tool_started`，页面显示名称、运行状态和读秒；完成时发送 `tool_completed`，练习文件卡可直接打开或拖入纸张。供应商正文增量以可撤销草稿通过 `text_delta` 实时呈现；模型转入工具调用、重试或终态校验回退时发送 `text_reset`，再继续下一轮。只有通过 verifier 的最终正文会持久化，临时草稿不形成消息或学习证据。纸张只存文件引用，打开时再次做 ownership 和答案安全检查。

纸张树的左侧是主对话每条输入/输出缩略；第一层纸张按 `sourceMessageId` 放在对应消息附近。纸张上的追问或文件继续用 `parentSheetId` 形成子树；无法定位来源的文件进入“工作台文件与未定位纸张”区。这样树展示的是上下文继承关系，而不是另一份对话权威。
