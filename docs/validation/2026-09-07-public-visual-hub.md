# 公共维护作品库修复与发布

发布应用版本 6bb0c81，GitHub main 已推送。/visualize（以及 /visual-hub）不经过 AuthGate；gallery 和 preview 无需登录。公共预览只接受已登记作品 id/version 和参数，拒绝上传 spec。compile、workspace、inspect、predict 仍认证。

根因：Hub 的 VisualSpec bundle 没有个人 owner_scope，但旧播放器初次挂载会调用个人 compile，再将响应的 learner scope 与初始 scope 比较，引发“当前账号已改变”。现提供固定 public:maintained 展示 scope 和基于维护版本的 onRun 参数重算；公共展示不触发个人预测事件或预测门禁。

验证：
- Web / Desktop 各 26 项 Hub/registry 测试通过，两个前端构建通过，共享契约检查通过。
- 本地实际播放器挂载 15 份旧 VisualSpec 作品，均出现图形，无账号错误。
- 线上浏览器清空 cookies 后直接打开页面；匿名读取全部 70 份作品成功。快速排序单步、CNN 参数控制通过，无 pageerror / 作品错误提示。
- 匿名 workspace 返回 401，浏览器唯一 401 控制台记录来自这个有意的权限断言。
- 部署目录 /opt/ceg/releases/learnflow-hub-6bb0c81；前端、后端、memory worker 健康，原卷和凭据保留，SQLite 在线备份及旧镜像回退记录保留。

Contract impact：两端 registry 2026-09-07.10。公共维护展示与个人作品权限分离，不修改五核或证据语义，无数据迁移。未运行无关全仓测试或付费模型生成。
