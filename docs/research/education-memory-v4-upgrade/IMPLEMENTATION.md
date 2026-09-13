# 教育记忆升级：实现与启用边界

本轮把四种读取机制加入两端共享的 `learnflow_core`，并以九种配置组合做对照。共享包为 0.2.6，读取契约为 `relevance-budget.v4`。所有变化都在读取侧；相似度和模型输出不能写成掌握证据。

## 已实现的机制

| 机制 | 实现 | 教育用途 | 代价与限制 |
| --- | --- | --- | --- |
| 有来源的原文读取 | `memory_source.py` 校验 Fact→Mutation→Event 的关联、内容、时间和 ownership；只读取允许的原始字符串；保留 hash 与范围 | 避免压缩事实丢掉错因、前提和限定语 | 不是任意事件正文回读；不合规来源回退到既有 node_text。该开关也扩大候选扫描，因此不能解释成纯原文单因素 |
| 紧凑学习经历 | 使用既有 episode 收集器，把 observation 上限降到 1；完整保留任务、结果、辅助、独立性、时间、来源和限制 | 在有限上下文中交付“何时、在何种帮助下做到了什么” | 会舍弃额外观察；最新经历优先，不能为了装入旧成功而跳过新的失败 |
| 语料级 BM25 | 在调用者完成权限过滤的候选集合上重新计算词法排序 | 缓解旧候选窗口先截断、后排序造成的遗漏 | 额外 SQL 扫描最多 4096 行；并非无限数据库索引 |
| 混合候选 | 词法排序与本地预训练向量排序用 RRF 融合，再走共同过滤和装包 | 为同义表达与零词面交集提供候选入口 | 模型是 thenlper/gte-small，不能预设中文教育增益；有加载、推理和缓存开销 |

混合模型只使用本地完整文件。缺依赖、模型缺失或分词器不完整会显式失败。正文按 510 token 窗口、64 token 重叠编码，使用最大窗口余弦；门槛 0.35、RRF k=60、最多 80 候选。内容缓存按模型、用途和正文 hash 建键，不保存跨请求候选 ID、权限集合或检索结果。

所有配置共用既有 scope、Human 原文保护、时间与来源检查。控制字段、正文和必要诊断进入同一字符估算预算。这里的“预算”不是实际模型账单 token；向量模型输入也有单独的硬上限。

## 现在如何启用

新机制目前是 Python 调用级能力。产品内置策略仍默认 `enable_source_text=False`、`enable_compact_episodes=False`、`candidate_mode="legacy"`，没有新增 UI 切换或 HTTP 参数。仅设置模型路径不会启用混合检索。

调用方可以复制现有策略，再将这个策略传给原有 `build_five_kernel_context()` 调用：

```python
from dataclasses import replace
from learnflow_core.five_kernel_context import CONTEXT_POLICIES

policy = replace(
    CONTEXT_POLICIES["checkpoint_tutor"],
    enable_source_text=True,
    enable_compact_episodes=True,
    candidate_mode="hybrid",
)
# 在现有、已带 learner/project/checkpoint/session 的调用中传入 policy。
```

使用 hybrid 还需在该 Python 进程中安装兼容的可选推理依赖，并设置 `LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH` 为完整本地模型目录。模型权重不随本次源码提交。选择哪些配置进入产品默认行为，应依据本轮实际结果及后续真实教学验证另行决定。

## 契约与验收

权威写入链继续是 `EvidenceEvent → reducer → KernelMutation → KernelState → Fact/Module/Claim`。本轮没有新增学习者状态维度、第四类主 Agent、数据库迁移或独立画像权威。Web 和 Desktop 注册表共同声明新增策略字段，继续引用同一个运行实现。

两端全量回归、独立实验核验器、共享契约和前端构建的真实记录见 [validation.json](validation.json)。Desktop 语义全量回归使用独立临时环境；不是对用户已安装应用的替换。回归通过也不能替代实验结果、教师评价或学生学习收益。

原始评测输出按运行目录保留，最终排名只采用通过全量条件、来源 hash 和逐条核验的完整运行。语义模型文件身份与实际执行身份分别记录，避免把“配置了模型”误写为“实际运行了语义检索”。
