# 画像学习成就

网页与桌面画像将“如何帮助我”更名为“学习个性化”，在概览上方增加可触屏横滑、键盘左右键及按钮翻阅的勋章栏。名称概括注册、1/10/50/100 个学习任务及每个完成项目；未解锁项展示进度。

Contract impact：registry 2026-09-14.1 / 2026-09-14.1-desktop。复用 Tutor 的 vnext_five_kernel_profile_reader、read_vnext_five_kernel_profile 和 vnext_profile 工作台，新增 growth.achievements 可选只读字段（gallery v1），旧客户端与旧 API 字段兼容。新客户端遇到旧服务显示暂不可用，不猜测解锁状态。

确定性实现：已绑定账号的 Learner 获得注册勋章；按本人全部 LearningTask 中 status=completed 的记录计数，不受任务列表隐藏已完成项或分页影响，不计算生成任务、取消任务或重复读取。任务里程碑随当前完成记录投影；不单独持久化第二套计分账本。项目沿用现有 LearnerBadge，按 project_id 去重；历史已完成项目按既有“全部非归档检查点完成且至少一个检查点”规则补充只读展示，空项目及仅旧 legacy_completed 标记不解锁。每个项目独立命名。历史项目奖章继续保留。

没有新增写入行为、Action、EvidenceEvent 或五核语义；GET 不颁发数据库记录、不触发事件，无数据库迁移。成就纪念完成行为，不代表稳定掌握。宿主 profile 服务与前端分别消费相同字段；账号及数据仍各自隔离。

验证：两端 test_profile_achievements 覆盖注册、阈值边界、非完成任务排除、项目完整性、多项目、重复读取、用户隔离及真实 snapshot API；现有项目勋章回归覆盖颁发幂等。前端 profile 测试与构建验证两端标题和类型。浏览器检查横向滚动、左右键、窄屏与长项目名。

## 本轮验收（2026-09-14）

- Web / Desktop 前端完整 npm test：559 / 481 项通过；两端 npm run build 通过（保留现有分包体积等警告）。
- Desktop 后端完整 pytest：1171 passed、5 skipped。
- Web 后端完整 pytest：1155 passed、2 skipped、1 failed。失败为工作任务转换的并发建项目用例 `test_concurrent_ticket_consumption_creates_one_project`（SQLite OperationalError）；该用例单独复跑 1 passed。本次画像、成就、用户隔离及注册表定向回归 34 passed；未修改工作任务转换代码。
- check_shared_contracts.py 与 git diff --check 通过。
- 浏览器使用隔离展示数据渲染真实画像组件：左右按钮、键盘横向滚动、390px 窄屏不溢出、长项目名两行截断，以及重新加载后无运行错误均已检查。原生触屏设备手势未实机验证。
- 未执行 seeded demo 与桌面打包/安装：本次不修改 demo 或原生宿主，不部署、不推送、不迁移日常数据。
