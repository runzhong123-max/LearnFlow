# 设计包参考校验报告

日期：2026-09-06。结果：**45 项检查通过**。

环境：Python 3.12；jsonschema 4.26.0；Draft 2020-12。检查不调用 DeepSeek，不运行浏览器，不连接真实系统。

## 实际执行

- Draft 2020-12 metaschema
- schema + registry + all-step bindings: bfs.visualspec
- schema + registry + all-step bindings: density-area.visualspec
- schema + registry + all-step bindings: gradient-descent.visualspec
- GD default golden x/loss
- GD recurrence alpha=0.05
- GD recurrence alpha=0.25
- GD recurrence alpha=0.5
- GD recurrence alpha=0.75
- GD recurrence alpha=1
- GD recurrence alpha=1.1
- BFS diamond golden queue
- PDF golden density/mass
- PDF boundary width=0.2
- PDF boundary width=0.5
- PDF boundary width=2
- reject unknown model
- reject unknown version
- reject extra script field
- reject unknown primitive
- reject dangling binding
- reject invalid default
- reject off-step default
- reject duplicate parameter
- reject duplicate element
- reject missing view order
- reject unknown slider target
- reject future initial step
- reject future checkpoint
- reject unknown check
- reject invalid model dependency
- reject unsafe property
- reject NaN
- reject invalid primitive key
- reject BFS unknown start
- reject BFS truncated trace
- reject PDF invalid interval
- PDF outside support has zero mass
- BFS unreachable node omitted from distances
- BFS singleton terminates
- 32 domain sections
- routing catalog matches 32 domain IDs
- routing catalog does not claim production capability
- 64 representative domain cases
- Markdown fences and local links

## 范围与限制

Schema metaschema、三个示例、默认与选定边界的参考模拟、所有生成 step 的数据绑定、若干非法变异，以及文档结构/本地链接已检查。梯度下降用闭式解核对迭代，BFS 用独立距离松弛核对，均匀分布用 CDF 差核对区间概率。

该脚本是三样例参考检查器，并非通用 DSL 编译器。它不完整验证所有学科数学、所有参数组合、图形拓扑、标签布局、视觉正确性、浏览器隔离、可访问性、供应商 schema 子集、事件协议、评分与真实学习效果。未执行生产 E2E；其余能力按主文档 Roadmap 实现。
