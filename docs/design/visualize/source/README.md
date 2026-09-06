# 计算机专业群教育智能体 Visualize 设计包

文档版本 0.1.1；VisualSpec 保持 0.1.0。

从 [完整技术设计文档](计算机专业群教育智能体-Visualize系统技术设计.md) 开始。覆盖 32 个领域、每领域两个代表性教学案例，以及架构、DSL、验证、交互回流、接口、Skill、测试和实施路线。

开发 Agent 首先读取 [长期 Context 入口](context/AGENT_CONTEXT.md)，再按任务读取对应章节。

| 文件 | 用途 |
|---|---|
| [完整技术设计](计算机专业群教育智能体-Visualize系统技术设计.md) | 团队规范与实施基线草案 |
| [四项研究核验与增补](research/代码驱动教学动画-四项工作核验与设计增补.md) | TeachMaster、Code2Video、LAVES/LASEV、OmniManim 的采用建议与边界 |
| [领域路由候选](context/domain-routing-catalog.json) | 32 领域的机器可读设计索引，能力均为 planned |
| [VisualSpec Schema](schemas/visualspec-0.1.schema.json) | 应用层 JSON Schema；还需语义/注册表校验 |
| [梯度下降](examples/gradient-descent.visualspec.json) | 定量参数 + 状态播放 + 预测题 |
| [BFS](examples/bfs.visualspec.json) | 离散算法状态与多视图 |
| [密度与面积](examples/density-area.visualspec.json) | 概率测度与交互图形 |
| [Skill 草案](skills/visual-pedagogy/SKILL.md) | 教学规划工作流，可集成到既有 Agent |
| [参考校验](validation/validate_examples.py) | 三模型参考数值、schema 与边界检查 |
| [校验报告](validation/validation-report.md) | 本次实际校验结果和未验证范围 |

这是技术设计与契约交付包，不是已完成的产品代码。文中 simulator 1.0.0 是拟定接口版本；生产 Renderer、完整 registry、DeepSeek 接入及教学实验按 Roadmap 实施。
