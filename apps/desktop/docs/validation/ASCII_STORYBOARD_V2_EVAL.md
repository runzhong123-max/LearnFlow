# ASCII Storyboard v2 设计与验收

日期：2026-08-31

## 决策

学习图解与动画的 storyboard 主呈现降级为逐帧 ASCII，不再要求模型同时完成教学建模、几何布局和 SVG 代码生成。这里的“降级”是渲染介质降级，不是语义降级：稳定对象、关系、分组、初始状态、类型化变化和逐帧断言仍由版本化合同承载。

执行链固定为：

```text
独立教学讲解
  -> Skill 建立语义 VisualStoryboardContext
  -> Tool 确定性重放完整逐帧状态
  -> ASCII Designer 只设计画布与实体锚点
  -> Tool 验证对象覆盖、锚点、尺寸、控制字符、重放与断言
  -> 可暂停、可前后步进的 ASCII 动画
```

Designer 可以自由选择树、队列、栈、矩阵、泳道、时间线或组合布局，但不能返回或修改实体目录、关系目录、状态操作和断言。失败时 Tool 只提供明确标记的通用状态清单，不把兜底冒充为定制动画。

## 研究依据

- Larkin 与 Simon（1987）指出，有效图解的价值来自空间分组降低搜索成本、支持感知推理，而不是来自图形表面的华丽程度：[Why a Diagram is (Sometimes) Worth Ten Thousand Words](https://onlinelibrary.wiley.com/doi/10.1111/j.1551-6708.1987.tb00863.x)。
- Tversky、Morrison 与 Betrancourt（2002）提出动画的 congruence 与 apprehension 原则：外部表示必须贴合概念结构，并且变化速度与复杂度必须可被学习者把握；离散步骤与交互控制比连续播放更可靠：[Animation: Can It Facilitate?](https://www.tc.columbia.edu/faculty/bt2158/faculty-profile/files/_Morrison_Betrancourt_AnimationCanitfacilitate.pdf)。
- Hundhausen、Douglas 与 Stasko（2002）的算法可视化元研究显示，学习成效更依赖学习者对可视化的主动参与，而不是被动观看动画：[A Meta-Study of Algorithm Visualization Effectiveness](https://users.cs.duke.edu/~rodger/jflappapers/Hundhausen2002.pdf)。
- `svgbob` 与 `ditaa` 证明 ASCII 可以先作为人可读、版本友好的结构源，再按需转成图形；本实现当前保留 ASCII 本体，不在验证后再引入新的几何失败域：[svgbob](https://github.com/ivanceras/svgbob)、[ditaa](https://github.com/stathissideris/ditaa)。
- `asciinema` 的 asciicast v2 把终端变化建模为带时间的离散事件，说明文本画面与独立播放时间线可以分开表达：[asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/)。

## 十个固定上下文

`frontend/server/visual-storyboard-cases.ts` 固定覆盖：哈夫曼树、快速排序分区、BFS 队列、TCP 三次握手、CNN 卷积/ReLU/池化、梯度下降、矩阵乘法单元格、二分查找、JavaScript 事件循环、联邦学习一轮。

离线确定性验收为 10/10：所有上下文均能重放、通过断言、产生 ASCII 初始帧与状态变化帧，并且不包含 SVG、HTML、ANSI 控制序列或可执行内容。质量分 84 仅代表结构验证等级，不宣称审美质量。

真实 MiMo 设计验收另行记录 provider 结果、耗时和失败分类。初始 12000-token 调用在哈夫曼案例中耗尽推理预算并返回空 `content`；最小 API 探针证明接口与解析正常，因此 ASCII Designer 与一次修复共享 720 秒总预算，首轮最多 420 秒，单次输出上限 32768 token。该预算调整不放宽任何 Tool 验证门。

第一轮完整真实评测为 5/10：快速排序、BFS、TCP、梯度下降和矩阵乘法通过；失败分别暴露持久对象被折叠、画布超宽和结构字符集不兼容。修复不按主题增加模板，而是统一扩大到 160×40 文本画布、接受常见文本框线字符，并在主画面遗漏仍存对象时追加“状态对象台账”，产物同时标记 degraded。

通用修复后的第二轮在 9 个已完成案例中通过 8 个；梯度下降供应商调用超过新总预算，但该评测进程仍加载旧的“双 720 秒”代码，因而被人工终止。最终代码已增加共享总预算回归测试。随后快速排序用最终代码单例复测通过，用时 15.961 秒；哈夫曼复杂树单例复测通过，用时 99.106 秒。由此当前证据是：确定性语义与显式降级 10/10 稳定，模型自由布局质量可达预期，但单次成功率和延迟仍有供应商方差，不能宣称 10/10 模型首轮成功。

## 失败语义

教学讲解在视觉调用前已经独立提交。ASCII Designer、供应商、语法、对象覆盖或尺寸验证失败，都只能使视觉增强进入显式 degraded/explanation-only 状态，不能撤销讲解、改写学习证据或切换成另一种视觉形式。
