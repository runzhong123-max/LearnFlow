# Visual Hub 首批验收记录 · 2026-09-07

## 已执行且通过

- Web 后端：`venv/bin/python -m pytest tests/test_visual_hub.py tests/test_visual_workspace.py tests/test_visualize_composition.py tests/test_architecture_registry.py -q --disable-warnings`，29 passed。
- 桌面后端：同一命令，29 passed。
- 共享工作流：`node --experimental-strip-types --test packages/learning-client/src/visuals/workflow.test.ts`，6 passed。覆盖维护 HTML 原样复用和明确模板按钮零次模型调用；既有 fresh / repair / resume 黄金流程继续通过。
- 两个前端分别 `npm run build` 成功。仍有原有的 chunk 体积、Vite 配置兼容性和桌面动态导入提示。
- `python3 scripts/check_shared_contracts.py`：两端共享 144 个事件契约，检查通过。
- `git diff --check` 通过。

## 浏览器验证范围

用临时 Vite 页面挂载实际共享 `VisualPluginArtifact`（不是重新制作的假播放器），host 读取由正式 `compile_work` 生成的测试 fixture。真实 API 的认证、保存、读取、幂等和跨用户隔离由上面两端后端测试验证。

五份作品各自执行播放/暂停或单步、参数/起点控制。四个数学演示合计 22 组边界数值检查；Dijkstra 对 6 个起点 × 12 个可选边权，使用独立 Bellman–Ford 松弛核对全部距离，72 组通过。共 94 组数值检查；没有作品脚本 pageerror。

五份作品均检查 736px / 360px、明暗主题、横向溢出并保存截图；实际查看了导数、线性变换、贝叶斯和 Dijkstra 截图。窄屏图内字体由 13px SVG 单位放大，最终贝叶斯截图已复核。宿主 DOM 跨域访问被阻止，伪造外部 resize 消息被忽略；减少动态效果下操作为离散一步且不会自行前进。

截图在本地 `output/playwright/visual-hub/`（不提交生成图片）。预览中的 favicon 404 与 React DevTools 提示不是作品错误。旧有界面浏览器会话的最终截图曾超时；新的无界面会话截图成功，交互验证不依赖该超时截图。

## 尚未覆盖

- 没有调用付费模型进行线上端到端生成测试，没有部署或操作生产学习者数据。
- 未执行全仓无关测试或 seeded demo；本次验证针对 Hub、共享视觉工作流、两端注册表与构建。
- 226 个 planned session 只有选题，不具有成品质量声明。既有 15 个 VisualSpec 模板保持原验证范围；训练模型版 CNN 的参数资产尚未接入。
- 维护 HTML 的局部参数暂不跨打开持久化，也不支持在此 builder 内让模型编辑脚本。


## 第二批与查询页面 · 2026-09-07

新增 50 份交互 HTML，总库 70 份。两个后端上述四组测试分别 30 passed；两个前端构建成功，共享契约检查通过。纯模型测试覆盖 50 × 3 组边界输入，以及排序、分页、置换、背包穷举、MST、Huffman、概率归一化与梯度差分黄金检查。

浏览器挂载实际共享 VisualHubPage / InteractiveHtmlPlayer，fixture 来自正式 preview_work；50 份均打开并改变参数，50 份画面状态变化，无 pageerror，360px 无横向溢出。另验证查询、分页、哈夫曼预览。抽查树、卷积矩阵、PCA、注意力、Raft 和调度画面；大屏 SVG 高度限制为 300px，避免主控制被过高画布推走。页面展示不等于对所有算法/输入完成形式证明。

未进行生产部署、付费模型调用或生产账号导航测试；宿主页面接入由两端构建和注册表检查覆盖。首批记录中的 226 个 planned 是当时快照，当前状态以 curriculum.json 及 ready work_refs 为准。

## 树图布局与展示精简

共用 VisualSpec 图渲染改为有根有向图分层、无根图环形，边连接节点边界，标签决定节点宽度；B+ 叶链不改变根与叶的层级。状态表默认折叠，删除视图重复标题；独立首批 HTML 限制展示尺寸。9 份 batch2 树图作品增加 1.1.0 版本，窄屏在画布内横向查看，旧 1.0.0 仍可读取；Gallery 按 ID 展示最新版本，仍为 70 份作品。

两端 Hub 测试各 3 passed，图布局黄金测试 2 passed，两端构建、共享契约检查通过。浏览器抽查 B+ 树、虚拟内存、BFS、哈夫曼、贝叶斯在 1100/390px 的展示，无 pageerror，已实际查看截图。算法状态未改动。Contract impact：无新 API/事件/五核语义，旧作品版本引用保留。
