# 图解与动画轻量播放器验收

## 产品变化

默认卡片只展示作品主题、教学阶段、画面、当前说明与播放控制。生成来源、参数、数据/导出、带快照追问、改编和反馈统一进入「更多」，不主动展开。计算作品和 SVG 分镜复用同一个播放器外壳；末帧主按钮变为重播，减少动态效果模式下仅复位。

删除重复的来源徽标。仅去掉与 HTML 当前说明完全相同、且绑定到 `/state/title` 或 `/state/narration` 的文字元素；保留混合视图的状态表及其他教学文字。原始状态和 JSON 不变，SVG 元数据保留当前说明。

计算矩阵在宽卡片中并排，在窄卡片中横向查看；保留单元格坐标、当前窗口、未计算标识、焦点对象和宽矩阵的最小可读宽度。注册 softmax 运算的输出用概率柱展示，保留类别顺序、原始精度提示及数组/元素 ID；不把最大值当作有效识别结论。

Web 与桌面共同引用 `VisualPlayerChrome`、`VisualizeArtifact.css`，移除两个宿主重复的 VisualSpec 样式。

Contract impact：无外部契约变化。PresentationContext 的可选属性仅用于客户端显示；没有新增工具、事件、schema、数据库迁移或五核写入规则。现有作品可直接采用新显示。

## 已执行且通过

- Web、桌面 `npm run build`；已有大 chunk 提示仍存在，本次没有引入第三方依赖。
- Web `visualize-composition-golden.test.ts`、Web/桌面 `visualize-runtime.test.ts`：合计 13 项通过。覆盖重复文字去除、混合图保留、概率数值与焦点、矩阵几何、现有维护作品的全帧渲染。
- Web 后端 `test_visual_workspace.py`、`test_architecture_registry.py`：23 项通过。
- 桌面后端同一组：22 项通过。
- `python3 scripts/check_shared_contracts.py`：136 个共同事件契约一致。
- 隔离浏览器页面：CNN 数值动画与 DNS SVG 分镜，1200px 和 390px 视口。检查默认隐藏追问、去除重复说明、播放/暂停/重播、减少动态效果复位、观看位置恢复、精确快照追问、改编版本、参数重算后的反馈与重开、暂停任务继续、已发布任务状态及页面无横向溢出。
- `git diff --check`。

浏览器使用已有编译结果和隔离 host 模拟，不调用线上模型，不写用户聊天或作品。未重新执行真实模型生成、整仓全量测试、桌面安装或 seeded demo；本次修改不涉及这些运行流程。

## 发布结果

应用提交 `0999997` 已推送到 `origin/main`，线上前端镜像为 `learnflow-frontend:visual-ui-0999997`。发布目录 `/opt/ceg/releases/learnflow-visual-ui-0999997` 保存之前的镜像引用、配置链和回滚覆盖文件。只切换 `learnflow-frontend`；其余 5 个容器的 ID 经核对保持不变。桌面源码同步，未安装替换桌面应用。

镜像内插件装配检查确认 `educational_visuals@1.0.0` 的 6 项工具。切换后前端 HTTP 200、重启数 0；公网首页及 `/assets/index-eKcg-4l7.js`、`/assets/index-CG_JXby9.css` 均返回 200，HTML 引用与镜像内容一致，CSS 含新播放器样式。公网 `/api/architecture/validate` 为 valid=true。
