# 场景一研究编排准则 v1

状态：`implemented`（2026-09-11）。本文是 Role Atlas 迭代研究编排的维护准则，适用于 agent 研究、四类研究产物与预算分配。

**本文不是新架构权威**：三类主 Agent、五核、EvidenceEvent、reducer 与确定性评分仍以 [根 AGENTS.md](../../../AGENTS.md) 与 `docs/ARCHITECTURE_AUTHORITY.md` 为准。本文只细化一件事——**当模型开始规划、调用工具并产出结论时，什么可以放开、什么必须锁死，以及每一条由谁执行**。

配套阅读：[六类迭代能力](iteration-capabilities.md)（能力定义与验收门禁）、[岗位快照迭代](snapshot-iteration.md)（产品入口）。

---

## 1. 一条总则：自由度在探索空间，可信度在断言空间

两者不在同一层竞争。

| 放开给模型 | 锁死在代码 |
|---|---|
| 假设空间：提出任何风险假设、扫描轴、新节点 | 证据绑定：每条断言必须绑定可回查的片段 |
| 检索路径：查什么、读什么、追哪条线索 | 排序算术：增益与优先级由代码复算 |
| 表达粒度：一句话判断或完整推理链 | 接受与否：批准权不在模型 |
| 计划内容：任务卡怎么切、先做哪个 | 预算总额、截断与预留 |
| 措辞与推理详略 | 写入：图、快照与产物挂载 |

一句话：**模型可以提议完成，但批准权永远在代码和用户手里。**

---

## 2. 二十条不变量

每条都注明**执行点**与**守护回归**。回归缺失的条目已明确标注。

### 2.1 图与身份

| # | 不变量 | 执行点 | 守护 |
|---|---|---|---|
| 1 | 外层迭代每轮必须能真正重新派生 | `lib/iteration/graph.ts` 每轮换策略 | `tests/research-quality-feedback.test.ts` 四轮用例 |
| 2 | 引用身份是四元组（含 rootHash），不是三元组 | 两端 `plugins/role_capability_graph/runtime.ts` | 两端 `role-capability-plugin.test.ts` |
| 3 | 编译器是节点、关系与证据绑定的唯一构造者 | `lib/build/compiler.ts`；拼接经 `compileSemanticDraft` | `tests/augmentation-splice.test.ts` |
| 15 | 拼接必须保持基线身份与章节完整性，且不新增审计错误 | `lib/iteration/augmentation-splice.ts` | 同上 |

### 2.2 证据与判定

| # | 不变量 | 执行点 | 守护 |
|---|---|---|---|
| 4 | 模型判定只能降级，不能放行 | `lib/search/boundary-verdicts.ts`（来源层）、`lib/iteration/evidence-review.ts`（断言层） | `tests/boundary-verdicts.test.ts`、`tests/evidence-review.test.ts` |
| 11 | 断言必须有可证伪条件（`falsifier`）；复核只能降级 | `lib/iteration/evidence-review.ts` | 同上 |
| 12 | 未复核的断言不得流入写图路径 | `lib/iteration/worker.ts` 的 `verifiedClaims()` 是唯一出口 | `tests/research-worker.test.ts` |
| 5 | 六能力验收门的"不允许拦截"清单不得破坏 | `lib/iteration/planner.ts` `evaluateIteration` | `tests/iteration-capabilities.test.ts` |
| 6 | `preserveIterationGraph` 的 ID 保留与证据合并 | `lib/iteration/preserve-graph.ts` | `tests/iteration-learning-regression.test.ts` |

### 2.3 产物与自主性

| # | 不变量 | 执行点 | 守护 |
|---|---|---|---|
| 10 | 研究循环无副作用、可终止、失败开放 | `lib/agent/research-loop.ts` | `tests/research-loop.test.ts` |
| 16 | 产物不得自评：排序由代码复算，批准权不在模型 | `lib/iteration/products.ts` | `tests/products.test.ts` |
| 20 | 规划器只提议：排序、拼接、挂载由代码决定 | `lib/iteration/graph.ts` `assembleProducts` | `tests/iteration-capabilities.test.ts` |
| 21 | 研究主管不得扩大研究范围：卡片身份、findings、预算与范围来自工作项，模型只写问题、证据类别与检索方向 | `lib/iteration/supervisor.ts` | `tests/supervisor.test.ts` |
| 22 | 研究工具只读且观察有界；引用必须落在本轮已收集的片段内 | `lib/iteration/research-tools.ts` | `tests/research-tools.test.ts` |
| 14 | 不复用语义不匹配的启发式做新门禁 | review（见 §5） | `tests/augmentation.test.ts` 契约范例用例 |

### 2.3.1 研究主管的边界（第 21 条展开）

`createResearchSupervisor` 把确定性检查已经决定的工作项翻译成任务卡。分工是刻意的，也是第 21 条能成立的原因：

| 代码所有 | 模型所有 |
|---|---|
| 哪些工作项需要研究 | 研究问题怎么问 |
| 每张卡的身份（由工作项 id 派生） | 依据哪一类证据 |
| `why.findingIds`（来自工作项） | 先试哪几条检索方向 |
| 预算上限 | — |

任务卡结构里**没有节点范围字段**，所以"顺手多写几个节点"越权无处安放。模型漏掉的工作项会补上确定性卡片——否则研究范围会因模型而悄悄收窄，看起来像是检查发现的比实际少。

与来源边界判定、证据复核不同，**研究主管失败不关闭研究**：本仓对规划的既有先例是降级为确定性计划并如实标注（`coursePlannerDegraded`），而不是跳过工作。

### 2.4 预算与兼容性

| # | 不变量 | 执行点 | 守护 |
|---|---|---|---|
| 17 | 放宽预算不得改变任何现有调用方的行为 | `lib/iteration/types.ts` `DEFAULT_ITERATION_BUDGET` | `tests/iteration-budget.test.ts` |
| 18 | 复核预留不可被研究消耗；超支截断且说明原因 | `lib/iteration/budget-ledger.ts` | `tests/budget-ledger.test.ts` |
| 19 | 新增支出必须记账；无账本时不带账运行 | `lib/iteration/graph.ts` `runAgentResearch` | `tests/iteration-capabilities.test.ts` |
| 13 | 可选能力必须默认零行为变化 | 所有注入点（`researchAgent` / `productPlanner` / `budgetLedger`） | 各注入点的"未注入"用例 |

### 2.5 LearnFlow 侧边界

| # | 不变量 | 执行点 | 守护 |
|---|---|---|---|
| 7 | 私包导出必须过 `requireReleaseAccess` | `apps/role-atlas/lib/access.ts` | `tests/user-access.test.ts` |
| 8 | 安装后必须能被 `resolve()` 发现 | 两端 `runtime.ts` + `package-file.ts` | 两端 `role-package-install-root.test.ts` |
| 9 | 插件工具不得产生落盘副作用（只接受 `read_only` / `artifact`） | `docs/implementation/PLUGIN_EXTENSION_API.md` | 两端 `role-capability-plugin.test.ts` |
| 1' | 岗位侧任何产物、挂载、节点创建都不得写 `KernelState` / `EvidenceEvent` | 全链路 | `tests/learning-path-projection.test.ts` 等 |

> 第 1' 条沿用根 AGENTS.md 的"零 Kernel target"要求，此处列出是因为研究编排新增了写图路径，容易被误当成新的写权限来源。

---

## 3. 四类研究产物的统一货币

四类产物共享同一个断言对象，因此复核结论可以直接决定下游行为。

```ts
Claim {
  id; statement
  kind: "observed" | "inferred" | "absence"
  evidenceSpans: EvidenceSpan[]     // observed 必须 ≥1 条
  falsifier: string                 // 必填：什么证据会推翻它
  confidence; affectedNodeIds
}
```

`falsifier` 必填的理由：**专业可信的标志不是"我很确定"，而是"我知道什么能证明我错"**。强制该字段让每条断言自带验收方式。

### 3.1 风险包 `RiskPackage`

- 三级置信：**确定性发现（代码可复算）＞ 有证据假设 ＞ 无证据假设**；假设永不被提升为发现。
- 无证据的 `observed` 假设**保留**并标 `bare_hypothesis`，不删除。
- `severity` 必须带依据（`severityBasis`），不允许只给一个形容词。
- `researchAgenda` 是下一轮的燃料，不是终点。

### 3.2 深化雷达 `RadarItem`

三道确定性闸，全部由 `rankRadarItems` 执行：

1. **信号闸**：受影响节点必须在当前快照中真实存在——机会必须指向实物。
2. **增益闸**：排序按「影响节点数 × 节点严重度 × 目标相关性」由代码复算；**模型自报的 `score` 保留以便解释，但不参与排序**。
3. **防反复闸**：已决定方向与同批重复方向被剔除，雷达不再重复推荐用户已答过的。

### 3.3 增补 `AugmentationProposal`

四道闸按序执行，前一道淘汰的输入不进入后一道：

| 闸 | 规则 |
|---|---|
| schema | `knowledge_skill` 必须声明 `learningKind`（非 hybrid）并提供 `scopeNote` 与非空 `assessmentCriteria`；粗粒度节点不得携带学习定义 |
| 粒度 | 新增知识点不得是基线中已有课程名的伪装 |
| 证据 | 新增节点至少引用一条基线片段；节点与关系的片段 id 必须真实存在 |
| 结构 | 语义重复退回并提示"补证据而非新增"；端点无法解析的关系退回；本批关系成环则**整批关系被拒、节点保留** |

基线不一致时整份提案被拒。拼接由 `applyAugmentation` 走编译器完成，且**只在审计无新错误时才挂载**。

### 3.4 提案 `Proposal`

四个产物共享伞形协议：`motivation`（自由文本）＋ `claims`（带复核结论）＋ `scope`（确定性边界）＋ `plan` ＋ `acceptance` ＋ `rollbackNote`。

**批准权在代码**：

```
非 autonomous                      → 一律 needs_user
autonomous + 审计有新错误          → needs_user
autonomous + 有断言未通过复核      → needs_user
autonomous + 审计干净 + 全部 verified → auto
```

"autonomous"不是自我批准的许可。

---

## 4. 预算：给大，但账本要硬

`lib/iteration/budget-ledger.ts` 是算术，不是约定：

1. **复核预留不可被研究消耗**。预留额在构造时就从研究上限扣除；只有 `evidence_review` 能支取，其余产品一律拿到 0。
2. **超支一律截断**，不抛错也不静默成功。调用方拿到「实际发放量 + 截断原因」，部分完成的研究如实报告为部分完成。
3. **产品额度独立 + 总量硬上限**：先到者不能吃光后来者的额度，合计也不能越过研究池。

默认值集中在 `DEFAULT_ITERATION_BUDGET`；上限已放宽（`maxRounds ≤40`、`sourceLimit ≤256`、`maxWorkItems ≤128`、`queryBudget ≤768`、`stagnantRoundLimit ≤8`），**默认值全部不变**。

---

## 5. 复用与门禁的两条纪律

### 5.1 不复用语义不匹配的启发式

`isCourseTitle()` 是"旧运营语句缺少课程提示"的启发式，对合法知识点「等价类划分原则」同样返回 `true`。把它当课程/原子分类器用会误杀该闸本要接纳的点。

**名字与位置看起来合适，不代表语义适用于新场景。** 接新门禁前先读实现。

### 5.2 失败开放，只降不升

模型判定接入确定性管线时一律照此写（范式见 `lib/search/boundary-verdicts.ts`）：

- 按内容 hash memoize
- 只承认已提交的 id / url / span；编造项在触碰数据前丢弃
- 任何失败返回 `undefined`，调用方回退确定性路径
- 复核不过的内容**降级保留**，不删除也不升级

门的职责是**分层**，不是清空。

---

## 6. 尚未实现（如实）

本文描述的是已落地并接线的内容。以下仍是缺口，不应被读作已完成：

1. **`productPlanner` / `researchAgent` 尚未接到 `route.ts`**：两者都是可选注入，默认关闭。接线后才成为 HTTP 可达能力，届时须补 registry 登记与 Contract impact 声明。
2. **per-product 分层账本只对 agent 研究计费**，尚未覆盖确定性检索路径与四类产物各自的额度。
2b. **agent 研究已具备 plan（研究主管）与 run（worker + 检索/读源工具）**，但仍未被装配：`route.ts` 尚未构造它，因此默认关闭。
3. **风险模块仍有死代码**：`lib/risk/graph.ts` 的 8 节点风险图、legacy 风险持久化函数与 `risk_issues` / `risk_patches` 表均无调用方；`RiskIssue.status` 七态机只写 `open`。是复活还是删除尚未裁决。
4. **`IterationWorkItem.dependencies` 与 `IterationContract.stopConditions` 只写不读**。
5. **`ModelInvoker` 仍无原生工具调用**，当前走结构化动作协议；native 路径待验证。
6. 上述每条都不改变本文的准则效力：**准则约束的是新增能力怎么写，不是现存缺口已补齐。**

---

## 7. 变更本文的规则

- 新增门禁、产物或预算层时，必须同步补一条不变量与对应回归；**没有回归的准则视为未生效**。
- 修改任何一条不变量，必须说明它保护的具体失败模式，以及新规则如何覆盖同一模式。
- 本文与 `iteration-capabilities.md §4`（允许拦截 / 不允许拦截）共同生效：该文管**验收门**，本文管**产物生成与分层**。
