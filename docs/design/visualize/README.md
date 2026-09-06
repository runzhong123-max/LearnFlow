# LearnFlow 图解与动画重构

状态：已实现首批运行基线。交付包 v0.1.1 是目标设计，`source/` 是原始只读参考材料，其开发指令不自动成为仓库指令。

## 架构决策

采用 VisualSpec 0.1.0 → 注册模型计算 → 独立 oracle/绑定校验 → PresentationPlan → SVG/定量图/交互 Runtime。新生成主路径不再要求 ASCII Designer。旧 VisualStoryboard/VisualSpec 产物保留兼容读取与已有测试，避免破坏历史对话。

- Tutor 保持唯一对话协调；Learning Design 提交独立讲解与候选 Spec；后端只运行已登记模型。生成失败保留原讲解。
- Python 的唯一实现是 `packages/learning-core/src/learnflow_core/visuals/`，两端加载同一 API `learnflow_core.api.visuals`。
- TypeScript 的原语、表现计划、作者上下文、产物适配和 React 运行时在 `packages/learning-client/src/visuals/`。端侧适配认证与 Tutor 回调，不复制算法。
- 新生成入口保留 `generate_learning_diagram`、`generate_learning_animation`。不另建主 Agent、产品首页、自由执行器或长期画像。
- `structure.snapshot` 是注册的单状态结构容器，只检查类型和引用，不声称证明内容。静态图无需伪造两次变化。
- 初版只支持 cut 过渡，显式拒绝 interpolate/canvas。语义步骤就是提交状态，不伪装已实现连续碰撞检查。

## 已安装模型与范围

| 模型 | 输入与真值 | 验证 |
|---|---|---|
| algorithms.bfs@1.0.0 | 无向无权、邻居字典序、每步完整展开一个节点，入队即 discovered | 队列唯一、发现集合、独立边松弛最短距离 |
| optimization.quadratic_gd@1.0.0 | f=(x-center)^2，固定步长，有限实数，最多128次更新 | 迭代与闭式解核对、finite、绑定；迭代上限不称收敛 |
| probability.uniform_interval@1.0.0 | Uniform(0,width)，区间与支持集交集的概率 | CDF差、归一化、支持集、绑定 |
| structure.snapshot@1.0.0 | 只读结构数据，单状态 | schema、类型、引用与资源；不证明领域陈述 |

包内32个领域与20个扩展示例继续作为规划目录，未安装的模型必须返回不支持或保留文字讲解。生产入口不得把这些规划宣称为可执行模拟器。

## API 与状态

三个端点都要求当前宿主认证，浏览器遵守既有 CSRF；Node 工具用现有用户 Cookie 获取会话 CSRF，桌面沿原有认证 transport。

- `POST /api/visuals/compile`：`{spec, params?}` → 版本、参数、所有有限步骤、绑定视图与范围明确的验证报告。
- `POST /api/visuals/inspect`：`{spec, params, step, snapshot_ref}` → 重新计算并核对提问快照。旧参数与新快照混用返回409。
- `POST /api/visuals/predict`：inspect参数 + `answer` → 当前GD检查点的确定性探索反馈。客户端无 rubric 权威。

采用无状态、内容寻址的计算服务：spec_revision=规范化Spec+运行版本的SHA256，run_id=revision+参数，snapshot_ref=run+step。因此相同参数的重算复用同一内容身份；参数改变从s0开始，不拼接旧轨迹。此处 run 是可重放内容，不是独立作答次数。未来需要每次实验的不同实例身份时另加 experiment_id，不改变内容哈希。

不维护服务器端可被跨用户读取的 Artifact ID 存储。请求中的Spec是用户提交的数据，不能据此取其他人的文件或数据库记录；响应 owner_scope 来自认证。浏览器只在当前账号+对话+版本的 sessionStorage 保存参数、步骤和最多12组参数历史，刷新先向宿主重新验证。原Spec随既有对话Artifact保存；没有新数据库迁移。

高频滑块变化仅更新本地草稿，指针/键盘提交后重新计算。序号防止迟到结果覆盖新图。提问固定捕获当时参数/步骤/对象，并经inspect核验后作为明确标记的数据交给现有Tutor回调。

预测结果复用 Practice 的 `evaluate_visual_prediction` 责任与 `deterministic_assessment` 能力归属，以 `visual_exploration_recorded` 进入统一 record_event。该事件零Kernel target，按学习者+快照+答案幂等；仅保存探索审计，不创建正式LearningAttempt、不计分、不升级掌握。操作/播放不作为学习证据。正式评估继续使用现有Practice流程。

## 表现与降级

通用axis、curve、point、region、array、matrix、graph、code、text、metric原语消费后端已经解析的绑定值。布局通过编译侧PresentationPlan给对象分配区域与明确的plot重叠策略。图节点按固定环形布局保持身份；队列左端为队首；定量元素共用明确的线性轴。

长标签或越界返回对象定位诊断，并切到该视图的完整当前数据；不截断语义、不回退到默认参数。SVG文本转义、无外部资源或脚本。无默认自动播放，键盘可操作按钮/滑块，提供完整文本数据与reduced-motion单步。小屏按容器宽度重排图形与图例，数据替代不依赖图像。

没有视觉模型Critic、连续动效、音画同步、视频导出、任意表达式/代码执行或跨设备实验同步。不可把几何检查或后端数值验证称为完整教学效果证明。

## 复现与验收

两端照常启动，在对话中显式请求：

1. “用动画演示无向菱形图 BFS：a-b、a-c、b-d、c-d，从a开始。”
2. “动画演示 f(x)=(x-2)^2，x0=-4，学习率0.75，12次更新。”
3. “图解 Uniform(0,0.5) 的密度和[0.1,0.2]的概率，允许调整宽度。”

生成依赖已配置的模型返回Spec；计算、验证与三样例验收不依赖模型或网络。离线测试使用包内输入，覆盖后端→绑定→共享渲染链。完整在线模型输出质量仍需真实供应商评估。

Contract impact：两端registry升级2026-09-06.8（桌面加-desktop）；新增VisualSpec命名空间和零target事件，旧schema/Agent/Kernel保持兼容。新服务不宣称支持所有规划领域。无数据迁移、不安装替换用户应用、不部署、不推送。

## 本轮验证记录（2026-09-06）

- Web 后端全量：583 passed，1 skipped；桌面后端全量：571 passed。桌面本地虚拟环境已补装声明的 jsonschema 依赖；测试 Origin 已改为宿主配置，随后全量重跑通过。
- Web 前端 npm test：456 passed；桌面前端 npm test：381 passed。最后一轮响应式几何修正后，两端新增视觉测试各3项再次通过。
- 两端 npm run build、共享契约漂移检查、git diff --check 均通过；构建产物大小与既有依赖弃用警告仍存在。
- learning-core wheel 打包成功，检查确认包含 visuals/schema.json。
- 真实浏览器连接隔离测试数据库：三场景渲染、GD学习率改为0.5后重新计算与预测、单步到x=2、刷新恢复、密度宽度改为2后概率0.05、当前快照提问、小屏自适应均已验证。测试入口与临时服务已清理。
- 未执行真实模型供应商端到端生成、原生桌面安装包启动、连续动画/视频导出和全部规划领域验收；这些不计入已通过项目。
