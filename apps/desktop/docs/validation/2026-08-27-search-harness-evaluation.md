# Search Harness v2 测评记录

日期：2026-08-27

对象：LearnFlow vNext Search Harness v2

注册表版本：`2026-08-27.5`

## 1. 结论

P0、P1、P2 的工程能力均已接通并通过确定性回归；六类真实联网场景在最终运行中全部返回非空证据。系统已经具备可发布的有界搜索 Harness，但无凭据公共 Jina 后端仍不适合作为正式环境的唯一主检索服务。

本次通过的是检索计划、工具边界、来源处理、降级、Agent 工具使用和证据包质量门槛；它不等于完整证明所有 Tutor 自然语言讲解都具有教学效果。

## 2. 评测方法

### 2.1 离线生产型基准

`frontend/server/search-evaluation.ts` 固定生成 120 个案例：

- 90 个意图案例：讲解、对比、排错、实现、研究、近期变化各 15 个；
- 15 个敏感信息清理案例；
- 15 个不安全 URL 案例；
- 另对 10 个可信目录主题和 30 组权威来源排序场景计分。

这是确定性、无网络的发布门禁，关注路由和边界正确性。

### 2.2 Agent 流程测试

端到端测试模拟模型三轮决策：

```text
search_computer_knowledge
→ read_web_evidence（必须命中本轮 allow-list）
→ 带精确 URL 的最终回答
```

测试同时验证页面摘录优先用于引用、读取结果保留不可信数据边界、终态校验不报错。

### 2.3 真实网络场景

`frontend/server/search-live-evaluation.ts` 覆盖：

1. 虚拟内存概念讲解；
2. PyTorch DataLoader macOS 卡死排查；
3. React 19 变化；
4. PPO 与 DQN 对比；
5. PyTorch SelfAttention 最小实现；
6. RAG 评测方法深度调研。

当前环境没有 Exa/Tavily/Jina Key，因此主后端为公共 Jina，辅以可信目录与公开垂直 API。

## 3. 实际结果

### 3.1 离线结果

运行命令：

```bash
cd frontend
npm run eval:search:offline
```

| 指标 | 结果 | 计数 |
|---|---:|---:|
| 意图准确率 | 100% | 90/90 |
| 计划预算受限率 | 100% | 90/90 |
| 隐私清理率 | 100% | 15/15 |
| 不安全 URL 阻断率 | 100% | 15/15 |
| 可信目录主题召回 | 100% | 10/10 |
| 权威来源 Top-1 | 100% | 30/30 |

搜索单测共 20 项通过，包含缓存、熔断、来源多样性、时效、覆盖缺口、引用审计和 allow-list 页面读取。

### 3.2 Agent 流程结果

`server/agent-runtime.test.ts` 共 33 项通过。新增场景确认：

- 模型能先搜索再读取页面；
- `read_web_evidence` 收到当前搜索候选 URL；
- 最终回答引用同一个精确 URL；
- 搜索之外的正式项目/文件来源不会被引用审计误杀；
- 两个搜索工具没有产生五核写入。

仓库级回归中，前端六组测试合计 120 项通过，后端全量 199 项通过；后端现有弃用警告未计为失败。

### 3.3 最终真实网络结果

运行命令：

```bash
cd frontend
npm run eval:search:live
```

最终汇总：

| 指标 | 结果 |
|---|---:|
| 非空场景 | 6/6（100%） |
| 平均证据覆盖 | 62.5% |
| 平均总延迟 | 2347 ms |

逐场景：

| 场景 | 意图 | 状态 | 结果数 | 覆盖率 | 延迟 |
|---|---|---|---:|---:|---:|
| 虚拟内存讲解 | explanation | ok | 2 | 75% | 4272 ms |
| DataLoader 排错 | troubleshooting | partial | 2 | 25% | 4204 ms |
| React 19 变化 | current | ok | 4 | 100% | 642 ms |
| PPO 与 DQN | comparison | ok | 2 | 50% | 4205 ms |
| SelfAttention 实现 | implementation | partial | 2 | 25% | 533 ms |
| RAG 评测调研 | research/deep | ok | 2 | 100% | 226 ms |

公共 Jina 在前两次调用中暂时失败，之后熔断；系统仍通过可信目录、官方页面和 arXiv 得到非空证据。Wikipedia 在该网络环境中也出现超时。所有失败均进入 Provider 诊断和覆盖缺口，没有被隐藏。

## 4. 测评驱动的修复留痕

第一次真实运行发现：

- “PPO 和 DQN 的差异、适用场景与失败边界”被“失败”一词误判为 troubleshooting；
- 无搜索凭据时，公共 Jina 被每个 facet 重复调用，概念场景主检索累计等待约 16.8 秒；
- 六个场景中只有五个非空。

随后修复：

1. 显式 comparison 词优先于一般失败词；
2. 无主 Provider 凭据时只发起一次合并主查询；
3. 主 Provider 暂时失败后不再执行缺口补搜；
4. 对比任务拆出两个主体并增加学术垂直来源。

修复后六个场景全部非空，比较意图正确，概念场景 Jina 尝试从五次降为一次。平均覆盖从第一次运行的 65% 变为 62.5%，原因是修正后的 comparison 使用了更严格的比较 facet，不能把旧的排错 facet 分数作同口径回归；该场景实际由空结果变为两条学术来源、50% 比较证据覆盖。

## 5. 通过与未通过边界

### 已通过

- P0：隐私、SSRF、防伪引用、Provider 状态、熔断、缓存、注册与零五核写入。
- P1：多意图 facet、混合重排、覆盖审计、候选搜索与页面读取分离、Agent 引用终态校验。
- P2：有界 deep 模式、研究垂直、研究简报、真实网络降级与测试入口。
- 前端生产构建。
- 后端架构注册漂移测试。

### 条件通过

- 真实公共网络下非空率达到 100%，但排错和实现任务只有 25% facet 覆盖；Tutor 必须按现有规则暴露缺口。
- 公共 Jina 与 Wikipedia 的可用性不稳定。正式部署需要配置 Exa、Tavily 或 Jina Key，并建立 Provider SLO。

### 尚未证明

- 自然语言回答的逐句引用蕴含；
- 多来源矛盾的语义裁决；
- 带真实学生的学习增益；
- P95 长时运行与多进程共享熔断；
- PDF 正文检索。

## 6. 回归命令

```bash
cd frontend
npm run test:search
node --experimental-strip-types --test server/agent-runtime.test.ts
npm run eval:search:offline
npm run eval:search:live
npm run build

cd ../backend
venv/bin/python -m pytest tests/test_architecture_registry.py -q
```

完整仓库回归结果应与本次提交的最终交付报告一起记录。
