# 复现与证据边界

本轮为研究评测代码，不修改产品写回、schema、五核权威或教学通过条件。Contract impact：none（仅新增隔离研究 harness）。旧 v4 正式结果不变。

## 固定来源

原生形成与正式读取的产品代码基线为 `a9375aa37f4575384394d595ede2395b07d9c7a2`，在独立 worktree 中运行。报告产出期间主仓有其他提交，因此不能把主仓后续代码等同于这次被测版本。正式 manifest 保存原生代码与实验源码的逐文件 SHA256；在历史基线 worktree 放入本目录对应实验代码后复核。

入口位于 `evals/education_memory_counterfactual/`：

- `generate.py`：执行计算机题目的 Python/SQL oracle，形成冻结 cases；不是学生真实代码。
- `formation.py`：每病例独立子进程、内存 SQLite、封网，通过原生 API/注册事件形成状态，不读取日常数据库。
- `representation.py`：来源验证、等信息分组/平面输入、资格注释；同事件记录一起选择。
- `reader.py`：真实配置模型，显式关闭 DeepSeek V4 thinking，固定输出额度，调用前 fsync 预约，失败不重试。
- `verifier.py`：独立核验真实事件与 Attempt，独立解释研究约定中的控制条件；不调用产品规划器。
- `run.py`：冻结、输入与源码审计、按实际响应计分及反事实分析。

这套共同读取器是研究仪器，不等于生产 Tutor、讲义和 Practice 已全部接入同一读取接口。

## 运行顺序

在基线 worktree 中，使用带项目依赖的 Python。先设置 `TIKTOKEN_CACHE_DIR` 为已下载 `cl100k_base` 的本地缓存目录；该文件 SHA256 应为 `223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7`。不能把此预算代理称为 DeepSeek 实际 tokenizer。

```bash
python -m evals.education_memory_counterfactual.generate --output /tmp/cf-cases.jsonl
python -m evals.education_memory_counterfactual.formation --repo "$PWD" --cases /tmp/cf-cases.jsonl --split formal --output /tmp/cf-formation.jsonl
python -m evals.education_memory_counterfactual.run freeze --repo "$PWD" --config-repo /path/to/configured/LearnFlow --output /tmp/cf-frozen --cases /tmp/cf-cases.jsonl --formations /tmp/cf-formation.jsonl --split formal --budgets 2200 8000
python -m evals.education_memory_counterfactual.run audit --repo "$PWD" --output /tmp/cf-frozen
python -m evals.education_memory_counterfactual.reader run --repo /path/to/configured/LearnFlow --jobs /tmp/cf-frozen/transport.jsonl --output /tmp/cf-frozen/responses.jsonl --max-calls 768 --concurrency 4
python -m evals.education_memory_counterfactual.run analyze --repo "$PWD" --output /tmp/cf-frozen
```

`reader` 会消耗实际模型用量；没有有效配置时明确失败，不能用离线规则回答替换。先单独 smoke，再做开发集。本轮正式配置和历史调用不受后来修改默认配置影响，以 manifest 与每次请求回执为准。失败的预约不能在同一结果路径重试；不同版本开发运行必须另建目录。

离线复核不需要新模型调用：解开存档，使用对应源码重算 audit/analysis。历史 `dev-01` 因默认推理模式与配置数字类型 hash 不一致而终止，官方比较成绩被拒绝计算；INCIDENT 与原始回执保留，不应把它包装成记忆消融结果。

## 可验证与不能推断

- 四组实际消息中的规范记录一致，资格注释是明确额外因子；只允许合法来源，并保留全部失败分母。
- 96条轨迹是48对、8个主题簇；768不是学生数。主题均由作者生成，没有新增人工标签、教师盲评或学生实验。
- 稳定掌握是固定否定控制；其高正确率不能当学习收益。下一步动作是公开操作约定，不代表普适最优教学。
- 低预算若保留全部关键来源，只能分析背景负担与组织效果，不能分析关键来源漏召回恢复。
- 受帮助/独立是合成声明；自述/测评是事件通道对照，时序/目标是序列交换，并非所有条件都属于单字段消融。
- 概念评分原生缺少 session 参数的限制逐条保留，不能声称完整 session 隔离。异项目/未来过滤是已实现的读取机制检查；未设计跨学习者反事实则不外推其效果。
