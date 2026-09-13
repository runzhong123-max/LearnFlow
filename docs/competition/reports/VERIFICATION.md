# 两套系统技术报告：验证记录

## 核验范围

- 日期：2026-09-08；源码基线：`6cd77646f22588de6988c68d86d76c69004026c2`。
- 根 registry 源码版本：`2026-09-08.1`；共享契约检查返回 shared core `0.2.1`。
- 开始时工作树干净，分支 `main` 跟踪 `origin/main`。本次编写报告材料，未修改业务代码、事件合同、数据库或用户记忆，也未进行发布操作。
- 资料依据是当前源码、仓库权威文档和本次实际测试。未将历史验收数字作为本次结果，未引用外部研究或宣称跨产品性能优势。

## 已执行且通过

| 检查 | 结果 | 能支持的结论 |
| --- | --- | --- |
| Web 后端专项回归 | 74 passed，14.09 秒 | 所列记忆、上下文、规划写回和 registry 场景通过 |
| Desktop 后端专项回归 | 73 passed，12.37 秒 | 桌面消费者的对应场景通过 |
| Web 前端专项回归 | 39 passed，0 failed | 所列规划、路径、全图结构和记忆读取场景通过 |
| Desktop 前端专项回归 | 38 passed，0 failed | 桌面消费者的对应场景通过 |
| 共享契约检查 | 通过 | 6 个 Python 模块、25 个 API 模块、4 个 TS 源及三 Agent、五核、144 个共同事件合同一致 |
| 直接调用路线规划函数 | 108 节点、187 边；案例返回 22 节点、7 里程碑 | 当前初始图上案例可重复生成；没有写入个人计划 |
| 文档链接与代码围栏检查 | 通过 | 三份报告的本地链接目标存在，代码围栏成对 |
| 文档差异空白检查 | 修正 Markdown 行末空格后通过 | 新文件以 `git diff --no-index --check` 逐份检查；常规 `git diff --check` 也已执行 |

后端两组测试均报告 5,354 条 warning，主要涉及 `datetime.utcnow()`、Pydantic 配置及测试客户端/异步依赖的弃用提示。通过结果不表示这些提示已处理。测试时长只记录本机执行情况，不是服务吞吐或延迟基准。

测试使用各宿主 `tests/conftest.py` 创建的独立临时 SQLite 数据库，清空测试 LLM key，并关闭自动后台合成，合成行为由测试显式调用。Web 环境 traceback 显示 Python 3.14，Desktop 为 Python 3.12。没有访问或迁移日常学习数据库。

### 后端复现

在 Web 的 `backend/`，以及 Desktop 的 `apps/desktop/backend/` 分别执行：

```bash
venv/bin/python -m pytest \
  tests/test_memory_graph.py \
  tests/test_five_kernel_context.py \
  tests/test_memory_upgrade.py \
  tests/test_memory_context_upgrade.py \
  tests/test_memory_teaching_upgrade.py \
  tests/test_learner_state.py \
  tests/test_architecture_registry.py -q
```

### 前端复现

在 Web 的 `frontend/`，以及 Desktop 的 `apps/desktop/frontend/` 分别执行：

```bash
node --experimental-strip-types --test \
  server/planning.test.ts \
  server/learning-path-graph.test.ts \
  server/learning-path-production-eval.test.ts \
  server/memory-context-upgrade.test.ts
```

在仓库根执行：

```bash
python3 scripts/check_shared_contracts.py
```

### 路线案例复现

在 Web `frontend/` 执行以下只读函数调用：

```bash
node --experimental-strip-types --input-type=module <<'JS'
import {
  OFFICIAL_PATH_NODES,
  OFFICIAL_PATH_EDGES,
  OFFICIAL_PATH_GRAPH_REF,
  createInitialLearnerPathState,
  buildLearningPathPlanProposal,
} from './src/learning-path-graph.ts'

const plan = buildLearningPathPlanProposal(
  '我想用半年系统学习 Agent 开发',
  createInitialLearnerPathState(),
)
console.log(JSON.stringify({
  nodes: OFFICIAL_PATH_NODES.length,
  edges: OFFICIAL_PATH_EDGES.length,
  graph: OFFICIAL_PATH_GRAPH_REF,
  plan,
}, null, 2))
JS
```

本次返回图 revision `2026-09-06.1`、planner policy `vnext-learning-path-planner-v2`，目标为 `agent-engineering`，horizon 为“6 个月”。此命令只构造候选，不调用确认 API。

## 失败与未执行项

- **已执行但失败：** 上述验证检查无失败用例。
- **因环境阻塞未执行：** 无；已有运行环境足以执行本次专项集。
- **未执行，超出报告核验范围：** 全仓后端回归、完整前端构建、桌面打包、真实在线模型端到端、真实云账号链路、性能压力测试、教育效果对照实验。
- **未执行现场 demo：** 本次阅读了比赛说明与 runbook，但未运行 `bash start.sh demo`，未检查运行中 `/api/demo/status`、`/api/architecture/validate`。报告中的讲解案例不能标成已录制或已现场验收。
- **未执行发布：** 没有 commit、push、部署、安装或替换用户应用。报告材料留在本地供审阅。

本文不将“测试通过”扩写为“所有功能无缺陷”“生产全量验收”或“学习效果显著提升”。两端计数存在对应场景，不能简单相加为互异测试数量。

结束检查时发现 Role Atlas 目录出现其他未提交改动；它们不属于本报告任务，未作修改、暂存或发布。

## 比赛现场取证建议

以下是尚待执行的场前建议：按 [DEMO_RUNBOOK](../DEMO_RUNBOOK.md) 启动隔离演示库；记录运行时 registry version/digest；展示一次正式行为的 event ID、支持事实和读取上下文；规划演示分别展示“尚未写入”与确认成功后的正式状态。网络不可用时采用已有确定性学习闭环，避免把外部研究和在线生成描述为离线可用。

## Contract impact

无。新增技术报告与验证说明，不变更注册表、schema、三类主 Agent、五核、EvidenceEvent、评分或状态机；无需数据迁移。
