# 画像成就发布记录

2026-09-14 用户明确授权推送并部署。成就提交 0f6b14a 普通合并远端导航图标更新后，最终发布 Git 版本为 56bf43c8991d67ad3ec55b68c4e0773d67563f4d；origin/main 已核对。没有携带未跟踪的 docs/reports。

现场基线：LearnFlow 服务 12bb721296fa、Role Atlas 295b355166d9。仅更新有差异的学习前端、后端、同源记忆 worker 与岗位应用；岗位后台 worker、交接代理、Caddy 的镜像、配置及挂载保持原样。岗位草稿提示修复为该发布版本已有内容。依赖清单与实时镜像一致，采用离线源码覆盖构建，按最终 Git 对象和源码哈希校验。

发布目录：`/opt/ceg/releases/profile-achievements-56bf43c-20260914/`。保存源码包、release.json、images.json、构建日志、apply/rollback 配置、backups.json、verification.json 和 success。构建在切换前完成；切换持服务器锁并复核任务空闲，临时停写后用 SQLite backup API 备份，integrity_check/quick_check 通过。历史 running 子记录有同 ID 已失败、无租约的父任务，按既有精确条件复核，未更改任务记录。

发布镜像：

- Backend / memory worker：`sha256:7d8813155eb096b5feaa80a35cfb4f90ab41623592b171086f201486a0981795`
- Frontend：`sha256:f5e37f67e0a5a2731fdb5ef2c260007f784904f937559b3b61f96490235ba268`
- Role Atlas：`sha256:46bda40e5e995eb9f0e3b0c3325f51e76931e7abb7f1c401abdb458652d43454`

两份数据库备份位于上述目录：`backup-d838df272628ea86.sqlite`（LearnFlow）和 `backup-1e23667177c0bdc2.sqlite`（Atlas）。需要回退时复用每个服务自己的原 Compose 链和对应 `.rollback.json`，只切换镜像，不恢复数据库覆盖新数据。

验收：合并后 Web 完整 npm test/build、岗位应用 npm test/typecheck/build 通过，后端复用同源码版本的上轮回归记录（Web 全量一项 SQLite 并发锁失败、单独复跑通过，定向 34 项通过；Desktop 1171 通过、5 跳过）。镜像内源码哈希、架构有效性、/ready、服务 readiness、实际镜像、环境/命令/挂载/网络策略和 worker 恢复检查通过。

公网四个域名 learn / roles / graphs / w2ltask.learnflow.club 认证跳转后的登录页 HTTP 200；公网新画像 JS 返回 200，含“学习个性化”和勋章滑动入口。未使用真实账户完成任务或颁奖操作，不以登录页 200 代表登录后业务验收。未打包、安装或替换桌面应用，无日常数据库迁移。
