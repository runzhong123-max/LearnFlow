# 工作任务到三类学习项目

## 对话入口与项目创建

沿用 `learning_task_conversion` 插件稳定 ID，界面名称为“工作任务转学习项目”。对话首先区分学习目的：

| 类型 | 对话应明确的内容 | 产物与执行边界 |
| --- | --- | --- |
| 知识学习 | 工作任务背景、需要理解的知识、学习目标与已有资料 | 保留既有讯飞转换、候选校验、学习任务确认流程 |
| 实验项目 | 要验证的问题、预测、预期现象、交付物和约束 | LearnFlow 生成任务书；桌面执行，记录预测、实现、验证与解释 |
| 带教实践 | 新人要接手的工作、当前基础、交付标准和允许的帮助 | LearnFlow 版本化案例、逐阶段材料、提示、交付和复盘；桌面执行 |

尚未明确类型时显示三类选择卡，不由模型静默选择。选择把结构化对象引用和文字放入输入框，用户可编辑后发送。实验、带教不调用讯飞知识转换流程。候选卡展示任务书；修改后必须重新准备候选与哈希，再确认。

`POST /api/project-guidance/prepare` 保存当前学习者的不可变候选。正式来源会话必须校验 ownership；没有正式会话时不伪造来源。确认动作绑定候选 ID、root hash 和幂等键，以一个事务创建正式 Project、Roadmap、Checkpoint、LearningTask、Session、工作台初始纸张和操作事件。重复确认返回同一项目，组合失败回滚。

Node Tutor 的 `confirm_project_guidance` 只返回待确认卡片。原生桌面 host 提供 `onConfirmProject`，由用户点击触发实际确认 API；Web 显示桌面提示。模型输出“确认”不会直接创建项目。服务端确认 API 负责身份、scope、hash、幂等和事务；它不把浏览器传入的 desktop 布尔值当作可信设备证明。文件与进程操作仍由原生 sidecar 独立认证，不在云 API 执行。

## 和现有产品的融合

继续使用既有 `project_kind=apprenticeship` 项目模型，新增兼容字段 `project_mode=learning|experiment|practice` 和 `project_brief`。旧项目默认 learning。项目 Tutor、关卡会话和自由对话保留原有正式 ID；没有第二套工程对话身份或本地云账号镜像。

项目、对话和学习进度使用当前账号的服务端；文件、命令、工程执行日志留在设备。云设备目录按 origin、learner、project 隔离，每次访问校验当前云账号和项目归属。旧本地工作区继续显式使用自己的身份，不迁移日常数据库。

实验和带教项目在桌面进入原有项目工作台，复用阶段、交付、纸张和文件树。代码选区携带路径、版本哈希和行号进入当前项目 Tutor 的思考纸；未保存内容标记为草稿。假设、问题和复盘纸张仍通过工作台版本与 revision 保存。工程运行摘要可回到当前导师复盘，不额外创建一个控制用户的主 Agent。

共享 Python 实现位于 `learnflow_core.project_workflows`、`practice_cases`、`api.project_workflows`、`api.project_guidance` 和 `api.vnext_projects`。两端旧路径保留兼容导入。共享 TypeScript 项目引导负责模式选择与候选呈现，宿主负责认证请求、确认和导航。

## 工程子 Agent

复用 Tutor 所有的 `local_agent_broker`，以本机已有 Codex CLI 作为执行 adapter。借鉴 [pi 官方 coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 的小工具面与运行事件：读文件、写入、编辑、执行命令，观察结果，再继续。参考其 [RPC 协议](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) 的事件与中止机制；没有引入 pi 依赖，也没有新增第四类主 Agent。

桌面工程面板提供四个可编辑入口：准备最小骨架、调查构建失败、检查补充测试、整理复现与交接。先与当前导师讨论会进入现有纸张，保留用户审阅和发送。

执行过程：

1. 准备任务语义、当前项目/阶段、限制和所需能力，确定性选择已登记的 profile。
2. 预览经过保护路径过滤的文件快照，用户确认后才启动固定参数数组的 CLI。
3. 在独立副本中运行，记录有界事件，支持超时、输出上限、取消及重启后 interrupted。
4. 展示结果和 diff。用户再次确认，按 source/snapshot/result 哈希检查后批量写回。
5. 删除、移动逐项确认；保护路径与 symlink 不可应用。未保存编辑先保存；版本变化要求重新预览。
6. 把实际结果交回项目 Tutor，讨论原因、风险与学习者应亲自验证的部分。

CLI 凭据仍由 CLI 管理。隔离副本用于控制写回范围，并非完整容器沙箱；网络与同主机读取边界明确显示“未受管”。不把进程运行结果或生成代码记作独立学习证据。

## 实验报告与带教边界

文件“加入交付”在云模式发布 `action=files` 的设备报告，校验用户当前看到的文件哈希，仅包含文件清单；它可以作为普通交付参考，不能充当成功实验运行。设备发布幂等键含持久设备标识，避免同账号多台电脑的本地运行编号碰撞。

固定 C11 实验保留既有 preview、hash 与显式运行确认。成功 run/verify 可以经用户点击“加入交付”发布设备报告：包含 snapshot hash、文件路径/哈希/大小、步骤名称和退出码；不上传源文件正文、命令正文或 stdout/stderr。报告绑定项目与关卡，重试幂等，失败、过期、阶段不匹配的报告不能充当已完成运行。

服务端声明 `authority=device_reported`：确认结构、归属和引用一致性，不声称自己重新执行了本地实验。设备报告是操作性交付参考，`mastery_inference=false`。提示、纸张、交付、引导确认和报告事件均为零 kernel targets；独立验证、评分和五核写回继续走既有确定性证据链。

带教当前使用固定版本 `support-ticket-import@1.0.0` 案例，明确选择并校验案例版本和 root hash；不会把任意工作任务伪装成已经支持的完整带教案例。材料按当前阶段开放，提示等级和辅助程度进入记录。工程助手可完成准备和辅助工作，无法凭自己的运行报告替学习者通过掌握验证。任意行业任务的自动案例创作与审校是后续扩展点。

## Contract impact

注册表升为 `2026-09-07.5` / `2026-09-07.5-desktop`，登记引导、工作流与设备报告操作及桌面工程 adapter。既有 Project 缺少项目类型和简报，云宿主也缺少桌面已有的工作流存储，因此新增字段默认值和表，以增量方式兼容旧数据；本轮开发与测试不迁移用户日常数据库。

稳定插件 ID、三类 Agent、五核和 EvidenceEvent schema 保持。新增操作事件不产生 KernelMutation，不修改评分、RemediationStrategy 或掌握升级语义。两端共享 API 导入与共同事件必须通过 `scripts/check_shared_contracts.py`。验收包括候选 scope/hash/幂等/事务、工作流阶段和报告引用、工程隔离及写回、两端 Tutor 和前端回归。


## 本轮验收记录（2026-09-07）

整合基线为 `775ffd3`，保留同日学习方法与文件闭环修改。已实际通过：

- Web 后端完整 pytest：632 passed、1 skipped；skip 为仓库既有停用的账户私有密钥 CRUD 用例。
- Desktop 后端完整 pytest：637 passed；其中云设备文件/运行报告含隔离文件、版本和跨机幂等回归。
- Web 完整 npm test：496 passed；Desktop 完整 npm test：425 passed。旧视觉 guidance 用例缺少插件装配，在干净基线同样失败；更新 fixture 后验证真实视觉修复及 Tutor 校正，保留逐次 guidance 断言与视觉规划隔离约束。
- 两端 TypeScript/Vite build、共享契约检查（25 API 模块、144 共同事件）、目录检查、diff check。
- 桌面 sidecar 与 Tauri app/DMG 构建；沙箱内 DMG 工具失败后获准在本机环境重跑成功。打包程序使用内存数据库验证新 API、registry、案例与云 Broker 可导入。
- 实际浏览器组件验收（模拟协议）：三类型选卡只填草稿、桌面确认卡、浏览器提示、成功后项目入口、文件清单、diff、二次确认和结果复盘。

未执行：真实付费 CLI/模型调用、真实云账号全链路、安装替换用户当前应用、生产部署、比赛 demo 启动。后端测试使用隔离数据库与临时工程；不把模拟界面或设备报告描述为真实模型端到端验收。构建仍有已有 chunk 体积及动态导入提示，Python 存在既有弃用警告。
