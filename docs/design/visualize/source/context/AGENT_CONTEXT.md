# Visualize 开发 Agent 长期 Context

文档：0.1.1；基线：VisualSpec 0.1.0；设计状态 Proposed；日期 2026-09-06。

## 项目目标

为现有 DeepSeek V4 Flash 教育 Tutor 补足可交互教学视觉，覆盖计算机专业群。已有知识库与画像，接入并裁剪使用；不另建一份冲突画像。

主链：诊断 → Plan → Spec → 验证/模拟 → Render → 教学检查 → Artifact → 状态回流 Tutor。

## 不可破坏的不变量

1. 程序化结构视觉优先；模型不输出任意前端代码，文生图不承载精确公式/算法真值。
2. Primitive + Pattern + State/Transition/Interaction 组合；避免每知识点一个硬编码组件。
3. 领域状态由已注册模拟器产生；schema 合法不等于语义正确。
4. 强制 validator 由服务端注册表决定；模型与客户端不能签发 ready/verification。
5. Spec、Trace、ViewState、LearningState 分离。动画中间帧不是算法事实。
6. v0.1 参数变更 reset_run；回退用快照重放；事件幂等且检查 revision/run/state_version。
7. Tutor 回答绑定提问时 snapshot；不能读取默认参数冒充用户当前图。
8. 相关用户画像进入 Planner；交互次数不能直接证明掌握。
9. 可访问性、错误恢复、验证和回流是 MVP 必需项。
10. 未注册能力返回 unsupported/降级，不发明 API、模拟语义或数值。
11. Schema、registry、adapter、样例、测试与本文版本同步变更。
12. 本包是设计与参考样例，不是已经上线的 Runtime；32 领域是规划覆盖，不是现成模拟器。

## 按任务读取

主文档：[技术设计](../计算机专业群教育智能体-Visualize系统技术设计.md)。

| 开发任务 | 读取内容 |
|---|---|
| 了解全局 | 主文档 §1–5、§21–22 |
| 实现 DSL/编译 | §6、§9–11；[schema](../schemas/visualspec-0.1.schema.json)；三个 examples |
| 实现 Renderer | §10、§12、§17、§19 |
| Tutor 集成 | §13–15；[Skill](../skills/visual-pedagogy/SKILL.md) |
| 新领域包 | §4.5、§8 对应领域、§20；先核实能力是 planned 还是 production |
| 测试/发布 | §11、§16–19、§21.4；[校验报告](../validation/validation-report.md) |

一次只加载相关段落与契约，不把全专业群文档塞进每次模型调用。动态状态由代码维护，并附原始 trace 引用以便核验。

## 首批实现与验收

先实现 BFS、二次型梯度下降、密度/面积三条完整链路。Golden 值：

- 梯度下降 x0=-4, α=.75, center=2：x=-4,5,.5；loss=36,9,2.25。
- BFS 菱形图：queue=[a]→[b,c]→[c,d]→[d]→[]；d 只入队一次。
- Uniform(0,.5)：density=2；P(.1≤X≤.2)=.2。

完成定义：默认/边界/非法输入；有 oracle；用户可操作；当前状态可问 Tutor；能降级、重载回放、键盘操作；记录性能与成本。不要仅以截图好看或 JSON 可解析结束任务。

## 变更纪律

明确任务涉及的文件与责任；新增能力先检查复用；涉及字段语义需 ADR 与迁移；运行相应回归。保留既有有效内容，不因单个任务重构全部系统。不在用户对话中暴露内部 stack trace 或未验证判断。


## 教学动画研究后的增补

按需读取 [四项研究核验](../research/代码驱动教学动画-四项工作核验与设计增补.md) 与主文档 §25。

- PresentationPlan 是编译侧拟定结构，不是 v0.1.0 的新根字段。
- 检查对象生命周期和过渡中间过程；合法教学重叠不应被统一拒绝。
- RenderDiagnostics 定位对象/时间段；局部修复不得偷偷改变参数、数学、状态和评分。
- 教学视频可复用真值与表现计划；交互 Runtime 仍为默认主路线。
- TeachQuiz 等代理指标不等于真人学习；论文成本和吞吐不作为本项目承诺。
- 尚未实现/复现上述新增模块，不能将文档决策报告成已上线能力。
