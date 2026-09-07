# 内部教学可视化 Hub v1

Hub 是 learning_design_agent 所有的维护内容目录，复用现有 visual_content_library / retrieve_learning_visual，不增加第四类 Agent，不增加面向学习者的导航页面。

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

现有 15 份维护模板已关联到相应 session，和首批 5 份 HTML 作品共形成 20 个可检索作品版本；其余 226 个 session 的候选仍为 planned。插件 search 返回少量 curriculum_sessions 给 Agent 作为选题上下文，前端不会为此新增目录面板。用户点击精确模板版本时直接读取和保存，不再要求模型重选一次。
