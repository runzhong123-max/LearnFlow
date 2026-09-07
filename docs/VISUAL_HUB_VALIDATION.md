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
