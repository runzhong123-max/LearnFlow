# 教学可视化 Hub

> 当前状态（2026-09-08）：当前地图全部 226 个待做条目已补齐；69 个已有作品升级，迪杰斯特拉保留并复核，共 296 个可交互作品。完整范围、验收和维护命令见 [全量补齐记录](VISUAL_HUB_COMPLETION.md)。下文保留初版及接口演进记录。

Hub 是 learning_design_agent 所有的维护内容目录，复用现有 visual_content_library / retrieve_learning_visual，不增加第四类 Agent，通过 Web 与桌面 `/visual-hub` 提供轻量查询与展示页面。

## 内容边界与进度

首版自编覆盖地图有 41 个模块、123 章、246 个 20–40 分钟 session。方向通过 module_ids 复用模块；每个模块有先修依赖、章节与 session。研究方向是入门地图，不代表穷尽所有研究生课题或院校课程。职业方向是学习建议，不是就业资格声明。ACM CS2023 与 MIT 课程是领域覆盖参考，具体章节和 session 是本项目的教学拆分；没有把它们冒充官方课程表。

每个 session 的 visual_candidates 是待策划的问题；planned 不能被描述为成品。首批交互作品：函数变换、割线与导数、二维线性变换、贝叶斯与基率、Dijkstra。原有 VisualSpec 维护库继续提供 CNN 等作品。此前对话中训练模型版 CNN 尚未搬入本库；根仓禁止提交模型权重，不能把旧 CNN 机制模板称为那个训练模型版本。

## 接口和 Agent 使用

- `POST /api/visuals/hub`：认证后的内部只读目录，参数 query、module_id、offset、limit（1..50），返回模块/方向索引和分页 session；无学习者资料。
- `POST /api/visuals/catalog`：现有插件检索入口，新增 curriculum_sessions（至多 5 条），ready 作品进入 templates；planned 只帮助选题。
- `POST /api/visuals/template`：按精确 id/version 读取维护作品。
- `workspace start_job -> publish -> read`：正常的有归属、幂等、不可变版本保存。interactive_html 的 source 是固定版本与摘要引用，必须 reuse，不能提交任意脚本或伪装成从零生成。
- 从零生成和个性化改编继续走 VisualSpec / SVGStory；维护 HTML 仅原样复用。画面内参数可自由改变并立即计算，目前这些局部参数不跨打开保存，不自动回写学习状态。

Agent 根据学习目标和适用范围选作品，不能仅因关键词命中替换用户具体输入。主 Tutor 保留对话控制；目录和作品均不是学习掌握证据。

## 构建和运行

共享 Python 模块 `visuals/hub.py` 加载 `hub/curriculum.json` 和 `hub/works.json`。静态作品放在 `hub/works/`；manifest 固定 SHA-256。包安装包含 JSON 和 HTML。新增版本需要更新作品、摘要、session 关联和实际验收记录，不允许用户生成内容自动晋升公共维护库。

共享 React `InteractiveHtmlPlayer` 在 Web 和桌面两个消费者中使用 iframe `sandbox="allow-scripts"`，不授予 same-origin、表单、弹窗、下载或导航权限。文档 CSP 禁止外部连接和资源；postMessage 只接受该 iframe 的有限高度，不执行消息中的动作。HTML 只来自服务器已登记作品，模型输出不会直接送到 srcDoc。

## 维护顺序与质量

先补基础数学，再按模块先修顺序推进专业核心；就业与研究方向从核心模块分叉。每个候选在制作时必须明确一个问题、主要画面、有因果意义的操作、适用范围与验证依据。按模块逐批发布，不按文件数量衡量质量。

每批只设少量黄金案例，但验收包括：关键数值独立核对、参数边界、真实按钮操作、窄屏和主题检查。必须实际查看截图。新作品在完成这些检查前留在 planned/draft；ready 指维护版本通过其明确范围内的验收，不是任意输入都正确。

版本升级保留旧 source 引用的可读取性：新版本新增 manifest 项和不同文件，不覆盖旧版本；不能在生产移除仍被私有 revision 引用的资产。

Contract impact：新增内部只读 Hub 端点和维护专用 interactive_html builder；沿用私有作品、插件引用与 visual_workspace_changed 零核事件契约。两端 registry 同步登记，旧 VisualSpec/SVGStory 读写不变。无数据库迁移、无五核语义变化、无新增掌握写入。

现有 15 份 VisualSpec、首批 5 份 HTML 和新增 50 份 HTML 共形成 70 个可检索作品版本。完整新增清单见 [第二批作品](VISUAL_HUB_BATCH2.md)。未关联 ready 成品的选题仍为 planned。插件 search 返回少量 curriculum_sessions 给 Agent 作为选题上下文。用户点击精确模板版本时直接读取和保存，不再要求模型重选一次。

## 查询与展示页面

侧栏“图解与动画”在工作区内打开 `/visualize`（别名 `/visual-hub`）。关键词、课程模块和形式筛选后分页展示；点击作品读取维护版本，不调用模型、不创建私有副本。预览只保留主题、参数、画面与主要播放控制。原有插件保存/从零生成入口不变。

- `POST /api/visuals/gallery`：认证、只读；query/module_id/kind/offset/limit，分页只返回 ready 作品。
- `POST /api/visuals/preview`：认证、只读；固定 id/version，返回已登记 HTML 或 VisualSpec bundle，拒绝任意路径/脚本。
- 共享 `VisualHubPage` 由两个宿主的 runtimeFetch 接入认证与 CSRF；没有新数据库或学习证据写入。
- 第二批源码位于 `hub/authoring/`，`python3 scripts/build_visual_hub_batch2.py` 重建资产与摘要；`node scripts/test_visual_hub_models.cjs` 核对数值。当前脚本用于本批未发布版本，发布后的修订必须使用新版本和文件，不能覆盖既有引用。

Contract impact（本批）：新增 visual_hub 工作台及两个只读 API 绑定，两端 registry 升至 2026-09-07.8。沿用 retrieve_learning_visual 和 learning_design_agent；既有 API、事件、五核语义向后兼容。

Web 与桌面都把 Hub 作为工作区内的标签页渲染：地址仍为 `/visualize`（保留 `/visual-hub` 别名），经现有 AuthGate，未开放匿名 API。此前 Web 的侧栏跳转到不带侧栏与标签栏的独立页面，标题因此无法与其他功能页面共用同一条左边界；现改为在应用内打开同一标签页。两端共用 `packages/learning-client/src/visuals/VisualHubPage.tsx`，页面使用与其他功能页相同的页面框（标题与内容同一条左边界）、只按语义保留边界线，搜索、重试、翻页、关闭等动作改为图标按钮。Web registry 2026-09-07.9 的页面绑定、路由与 API 全部不变，无事件、五核或数据库变更；`Contract impact`：无契约变更，仅为承载方式与视觉一致性。

公共维护库修正（registry 2026-09-07.10）：`/visualize` 与别名无需登录。gallery/preview 仅开放已登记维护作品；preview 允许有界参数重算，拒绝任意 spec，固定 public:maintained 展示 scope。公共播放器不执行个人预测写回或要求完成预测才能播放。生成、私有 workspace、compile/inspect/predict 继续认证，无五核或数据库变更。
