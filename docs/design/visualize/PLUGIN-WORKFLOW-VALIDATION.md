# 图解与动画插件验收 · 2026-09-07

本次为本地插件重构，覆盖 Web 和 Desktop 两个宿主。没有推送、部署、安装替换桌面应用或迁移日常数据库。设计与接口见 [PLUGIN-WORKFLOW.md](./PLUGIN-WORKFLOW.md)。

## 实际执行且通过

| 检查 | 结果与范围 |
| --- | --- |
| Web 后端相关回归 | 45 passed：私有工作区、registry、运行时、组合计算、课程维护库、模型桥接 |
| Desktop 后端相关回归 | 44 passed：同一共享实现及端侧注册绑定 |
| Web 前端相关回归 | 168 passed：Agent 宿主、插件授权、视觉意图、旧产物兼容、计算渲染与 4 个工作流黄金用例 |
| Desktop 前端相关回归 | 160 passed：宿主、插件授权、视觉意图、旧产物兼容与计算渲染 |
| 最新控件路由补充检查 | 共享工作流 4 个黄金用例通过，含继续、取消、作品库和维护作品的动画按钮；此数量包含在上方 Web 用例集合中 |
| 两端前端构建 | `npm run build` 通过；保留既有 bundle size / Tauri dynamic import 提示 |
| 共享契约 | `python3 scripts/check_shared_contracts.py` 通过：core 0.2.1、136 个共同事件契约 |
| Desktop sidecar 资源探针 | 30 个注册源码路径全部解析到端侧或允许的共享源码目录；构建脚本语法检查通过 |
| diff 检查 | 本任务路径 `git diff --check` 通过 |

两个工作区后端黄金案例同时覆盖：认证、跨用户隔离、固定 project/session scope、零五核变更、并发幂等、检查点版本冲突、精确复用、旧版本保留、参数运行、快照反馈、取消后禁止发布、未完成任务检索，以及正文/课程元数据检索。

前端和后端回归命令（在各宿主对应目录运行）：

```bash
# backend/ 使用 venv/bin/python；apps/desktop/backend/ 使用 ../../../backend/venv/bin/python
venv/bin/python -m pytest tests/test_visual_workspace.py tests/test_architecture_registry.py tests/test_visualize_runtime.py tests/test_visualize_composition.py tests/test_visual_library_curriculum.py tests/test_visual_planner.py -q

node --experimental-strip-types --test server/agent-runtime.test.ts server/plugin-api.test.ts server/tool-capability-catalog.test.ts server/learning-visual-spec.test.ts server/visualize-runtime.test.ts server/visualize-composition-golden.test.ts
# 根 frontend/ 另包含共享工作流黄金案例
node --experimental-strip-types --test ../packages/learning-client/src/visuals/workflow.test.ts
npm run build
```

## 三个真实模型黄金案例

使用真实 Node Tutor 宿主、真实插件加载器、认证 FastAPI 接口、临时 SQLite 和合成账号。模型为 `deepseek-v4-flash`。没有触碰日常账号、对话或数据库；临时服务已停止。下表是修复后的一次本地观测，不是延迟 SLA 或广泛成功率。

| 请求 | 结果 | 模型调用 / 耗时 |
| --- | --- | --- |
| 前文讨论 CNN，随后要求动画并直接复用维护案例 | 恢复前文主题，精确选中 `deep_learning.cnn.mechanism@1.0.0`，42 帧，维护来源确认 | 1 次 / 1.74s |
| 从零构建矩阵转置、矩阵乘法、展平、softmax 动画 | 保留 A=[[1,2],[3,4]]；B=Aᵀ，B@A=[[10,14],[14,20]]；展平与 softmax 正确；12 帧，无重复输入/输出向量或占位标量展示 | 1 次 / 6.77s |
| 从零构建 DNS 缓存未命中的 SVG 分镜 | 独立 SVGStory builder，5 场景；根与 TLD 回复递归解析器，下一跳查询由递归解析器发起，最终响应与缓存顺序人工审读通过 | 1 次 / 5.19s |

CNN 和矩阵所有帧在 720/300 宽度运行渲染检查，诊断为空。DNS 的结构检查不证明协议真值，因此额外人工逐条审读节点、消息边、阶段和说明。

第一轮真实调用发现并修正了：复用偏好被误识别为新主题；同一个当前数组槽重复放入输入/输出区域；未计算的标量占位值被展示；消息转介被画成服务器间直接响应。修复落在通用主题恢复、能力字段说明与构建器提示约定，没有增加 CNN/DNS 专属关键词路由或整份 Brief 硬门禁。

原始本地证据位于 `/private/tmp/lf-plugin-live/retest-mtqzaxss/`，包含报告、源规格、保存后的运行、模型调用记录和内容审读；没有随源码提交模型凭据或数据库。

## 浏览器交互验收

浏览器使用真实预编译 CNN 数据及模拟宿主接口的 UI harness。这是交互/协议验收，与上面的真实后端联测分别记录。

已通过：直接打开保存步骤且不重复计算；播放速度/步骤/焦点恢复；SVG 快照追问；暂停后保留父作品与失败原因；发布后隐藏继续/取消；个人改编绑定原版本；stride=2 参数重算后反馈指向正确运行及第三状态；携带旧运行引用的聊天卡重开后仍恢复新运行。

脚本 `/private/tmp/visual-plugin-ui-check.js`；手机截图 `/private/tmp/visual-plugin-ui-mobile.png`。

## 未执行与保留边界

- 未执行全仓测试、seeded demo 或桌面原生安装包构建：本轮按用户要求聚焦少量黄金链路与相关回归，未改变 demo、原生窗口或分发安装行为。
- 未做生产环境验证、推送或部署：遵守本轮本地重构要求。
- 目前实际安装 VisualSpec 和 SVGStory 两种构建器；SVG 是可逐步播放的结构示意，未声称是物理模拟或算法证明。Manim、任意代码沙箱和生图 API 未包含在本次交付。
- 15 个已有维护案例及其课程、问题、别名和教学元数据继续可检索。私人作品按版本复用/改编，不自动升级为公共维护案例。

Contract impact：新增插件的宿主产物授权、私有作品表、`manage_visual_workspace` capability 和零 target 的 `visual_workspace_changed` 事件。四个插件扩展点、三类主 Agent、五核证据链不变；旧聊天产物继续可读。上线将新增表，回退时可停止加载插件并保留产物数据，不需要删除旧表或重写学习状态。
