# 典型工作任务转换

工作任务转换是 Tutor 所属的项目创建前工作台。独立入口为 `https://w2ltask.learnflow.club`，同一 Web 宿主也提供 `/convert`。它复用 LearnFlow 账户、后端和共享学习契约；不创建第四类主 Agent，也不建立另一套学习者状态。

## 四个缺口及实现

| 缺口 | 实现与权威 |
| --- | --- |
| 学习候选必须先有项目 | `WorkTaskConversion` 是 learner 所有的持久化草稿。澄清和生成不创建 Project；确认后才通过已有正式对象服务创建项目与任务。旧项目内讯飞 API 保持兼容。 |
| 岗位任务和来源在跳转时丢失 | Role Atlas/Graph Hub 按固定 release 读取具体任务节点，签名任务引用、包版本、snapshot 和 root hash；转换后端校验用户 subject，派生来源，不接受客户端伪造“已验证”引用。接续会保留任务、来源、对话及候选。 |
| 实验、实践只是通用阶段或单个固定案例 | `work_task_designs.py` 编译维护的专业类比设计，包含材料、基线/变化、交付标准、环境和阶段验收。暂未覆盖的领域生成待审核方案，不能冒充可执行项目。旧 `support-ticket-import` 版本与哈希保留。 |
| 网页只会跳转，客户端不能真实导入 | 短期、用户和方案版本绑定的 ticket，经 `learnflow://conversion` 在主窗口预览，再选择目录确认导入。登录恢复、重复导入恢复、路径/大小/哈希/符号链接/禁止覆盖校验由桌面适配器控制；不自动执行命令。最低桌面版本 0.3.0。 |

## 共享契约与职责

共享 Python 实现在 `packages/learning-core/src/learnflow_core/work_task_conversion*`、`work_task_designs.py` 与 `api/work_task_conversions.py`。两端保留薄兼容导入；共享网页组件在 `packages/learning-client/src/work-task-conversion/`。Web `/convert` 是专用页面，桌面主窗口承接已确认的实验/实践方案。

`learnflow.work-task-conversion.v1` 保存任务说明、来源、对话、版本、内容哈希、生成状态及候选；`learnflow.work-task-design.v1` 和编译器 `1.0.0` 固定专业设计。新增的 learner 所有草稿、版本、幂等操作和接续票据表为增量表；现有项目、学习任务、事件 payload 和五核 schema 不变。

Tutor 负责澄清意图与接续控制，`learning_design_agent` 负责候选设计边界，`practice_agent` 继续拥有正式评估责任。编译器与转换网关登记为服务端流程基础设施，不直接向模型暴露写入权限。三个 Action Board 能力为 `prepare_work_task_conversion`、`generate_work_task_conversion`、`handoff_work_task_conversion`。

操作通过 `record_event()` 登记以下事件，kernel targets 均为空：

- `work_task_conversion_created`
- `work_task_conversion_brief_updated`
- `work_task_conversion_generation_changed`
- `work_task_conversion_handoff_created`

这些事件不推断掌握、独立完成或长期偏好。正式项目沿用现有 Roadmap、Checkpoint、LearningTask、Session 和项目工作流入口；设备回传仍是操作报告。

## API 与状态

Role Atlas 的「典型任务」详情标题区在关系雷达和事理流程视角均提供「转为学习任务」入口，与总雷达节点卡片复用同一交接函数。私有项目按当前对话的固定 projectVersionId 与 snapshotId 查找 ready/published 制品，不依赖推荐发布版本；没有可用制品时复用现有 prepare API 编译私有、metadata 制品，以源版本 SHA-256 形成稳定版本号，重试复用，不调用 publish 或更改市场可见性。编译失败阻止跳转，切换任务/对话/版本取消旧交接；服务端仍校验 ownership、节点及签名来源。Contract impact：仅补齐既有岗位准备与转换能力的 UI 接线，无 API/schema、注册表版本、主 Agent 或五核语义变化。

所有 `/api/work-task-conversions` 路由要求当前 learner 身份与现有 CSRF/来源校验。列表和详情只能看到自己的草稿。修改传 `expected_revision`，生成和接续传 `expected_root_hash` 与 `confirmed: true`；`client_action_id` 幂等键防止重复操作。岗位包同一签名 launchId 在同一 learner 下也幂等。

| 路由 | 用途 |
| --- | --- |
| `POST /`，`GET /`，`GET /{id}` | 创建、列出、恢复草稿 |
| `POST /{id}/messages` | 有预算的任务澄清，模型建议必须有用户原文依据；离线可直接编辑说明 |
| `POST /{id}/brief` | 修订任务说明，清除旧候选并更新版本 |
| `POST /{id}/generate` | 接受固定版本的生成请求并立即返回；GET 轮询恢复状态 |
| `POST /{id}/handoff` | 接续新/现有 Tutor 对话、创建学习项目或签发桌面接续票据 |
| `GET /handoff/{ticket}` | 同一账户的接续预览，不创建项目 |
| `POST /handoff/{ticket}` | 用户确认后幂等消费，创建正式项目 |

外部工作流运行期间不保持长事务；持久化生成租约能让中断显式失败并允许重试。旧版本迟到结果不得覆盖新任务。讯飞密钥只在服务端通过既有受保护配置读取，代码、浏览器与交接票据不携带密钥。

学习候选必须通过现有结构/依赖验证。用户可选择步骤，但至少保留三步及全部必要依赖。讨论保留候选与来源；正式创建经现有候选确认服务。实验/实践选择必须显式匹配某个维护的设计，不能仅因关键词相似便声称覆盖业务验收。

## 长对话的来源接续

会话保存交接时的 learner、session、project、checkpoint 作用域，Tutor 通过已有工作区只读入口，每轮获得有界的任务摘要、已选步骤、未决问题和固定来源。该数据在历史消息窗口之外以用户数据消息传给模型；切换项目或作用域不一致时不注入。原候选与哈希保留用于追溯，不能把摘要当作系统指令或掌握证据。两端 Python 与 Node 运行路径都消费同一投影契约，详见 `WORK_TASK_CONVERSION_CONTEXT.md`。

## 专业设计的适用边界

初始设计包括数据导入质量、服务接入与幂等交付、故障调查与可逆恢复。设计公开匹配依据和边界；明确支持的参数（例如重复数据保留首条/末条、SKU 大小写）会改变材料、结果和哈希；冲突条件被拒绝，未解释的业务限制保留为待审核项。

实践阶段按接手工作、带教操作、变化条件和独立验收递进。未来材料与最终答案留在私有固定设计中，前一阶段合格才解锁。独立验收阶段关闭提示和工程代理帮助，已有辅助记录不会因重试被抹去。验收器的执行合格只是该项目产物符合规则，不自动升级为知识掌握。

`domain-draft` 为长尾领域产生结构化方案、交付/验收映射、材料缺口和专业审核问题。它允许带入 Tutor 讨论，明确禁止创建可执行项目和桌面导入。扩展新的专业领域时，维护者应同时添加领域材料、反例、确定性验收器、独立变式和回归测试，再发布编译器版本。

## 部署与验收

DNS 添加 A 记录 `w2ltask` 指向现有实例公网 IP。cohost Compose 的 `WORK_TASK_HOST` 默认 `w2ltask.learnflow.club`，加入同站身份返回白名单和后端 CORS；Caddy 对此主机复用身份网关，页面重写到 `/convert`，API 指向既有后端，自动管理 HTTPS。Role Atlas 正式部署使用 launch proxy，必须一起发布 `launch-proxy.mjs` 与挂载的 `task-launch-core.mjs`，不能只改应用路由。

转换页面设置 `Referrer-Policy: no-referrer`。现有 Caddy 未启用 access log；新增日志时必须过滤接续票据路径，后端和端侧也应遮蔽票据。签名岗位 token 通过 URL fragment 进入页面，接受后清除，不能作为外部来源 URL。

验收覆盖：两端共享契约漂移、registry 绑定和零核事件、草稿 ownership/并发/过期/重试、讯飞真实 adapter 的 stub transport 验证、任务选择依赖、正式项目接续、签名节点与包完整性、专业参数化/阶段锁定、桌面文件安全与恢复、网页和桌面构建。浏览器实测需使用隔离测试账户和数据库；不能用生成内容代替真实调用或导入证据。

发布不等于在用户设备上安装客户端。应用安装替换、日常数据迁移和额外云服务购买不包含在代码集成中。

### 本轮独立验收记录

2026-09-08：浏览器使用独立临时数据库真实调用已配置讯飞工作流，40.5 秒返回 3 个学习步骤；生成后 KernelMutation 数量仍为 0。随后成功接续新的 Tutor 对话并确认创建正式学习项目。实验方案的网页生成、390px 移动端排版（无横向溢出）及云端票据到桌面原子导入已执行验证。macOS 0.3.0 调试应用已构建并验证 URL scheme，未安装用户应用；Windows/Linux 原生运行尚未验证。

当前统一域名集固定为 learnflow.club 下各站点；修改 WORK_TASK_HOST 为其他域名时，还需同步身份返回白名单与学习空间跳转映射。

前端 Vite preview 的 `allowedHosts` 从 `frontend/src/site-auth.ts` 的统一站点列表派生，仅允许明确登记的主机。发布验收除了匿名登录跳转，还必须向前端携带真实 `Host: w2ltask.learnflow.club` 请求 `/convert` 及页面引用的 JS/CSS，检查页面与资源均成功返回；未知主机仍应返回 403。匿名 302 只验证登录网关，不能证明登录后的页面可用。
