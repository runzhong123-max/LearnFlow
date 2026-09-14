# 生成内容尾注与作品总导航

2026-09-14。

## 表达与入口

Web、桌面聊天回复结束后、讲义与练习页尾、模型生成的学习方案尾部显示“含 AI 生成内容，请结合来源核对。”。使用同一共享组件：12px、正常文档流、无背景或边框，不插入正文，不写入对话存储、模型上下文、EvidenceEvent 或掌握状态。系统消息、用户输入、纯操作卡和确定性编译方案不单独添加。图解与动画播放器也在尾部标识；SVG 导出在图外增加 32px 尾部，JSON 导出增加 ai_content_notice。浏览器打印样式保留尾注；未新增讲义 PDF/Word 导出器。

/demo 复用 /showcase.html 总导航，展示岗位研究、Graph Hub、任务转学习项目、学习与实践、纠错复习、交互教学。导航本身不请求登录；业务页仍执行原认证。localhost 的学习、转换、复习和视觉入口留在本机，外部服务使用原有站点地址。bash start.sh demo 打开总导航；/review 保留兼容且仅在隔离模式下自动登录。

桌面下载区已预留。当前 LearnFlow 仓库没有发布的 Release，也未提供可确认的安装包地址，因此显示“下载地址待提供”，不链接空发布页或历史仓旧包。填写实际链接后应验证文件可下载、版本及适配系统；本次没有发布安装包或部署站点。

## 首次访问修复

全新浏览器首次进入 /review 曾触发 kernel_heads 唯一键冲突，来自并发请求懒初始化尚缺的读投影。两端 demo seed 在提交前复用 ensure_kernel_heads 完成全部派生投影，避免首次页面读争抢初始化。播种回归验证五核 head 齐全、重复播种不重复创建；不改变 reducer 或证据规则。

Contract impact：Web registry 2026-09-14.4，competition_demo 稳定 ID 保留，surface 改为 /demo，绑定 CompetitionDemoEntry；旧 /review 学习入口保留。导出 JSON 仅增加表达用字段；核心契约、三类 Agent、五核写入权限与数据库结构不变。

## 验证

- Web 后端全量：1171 passed，2 skipped。
- 桌面后端全量：1186 passed，5 skipped。
- Web 前端 npm test：562 passed；新增导出回归纳入 test:formal 后，该组 35 passed。
- 桌面前端 npm test：483 passed；新增导出回归纳入 test:formal 后，该组 37 passed。
- 两端 npm run build 通过；存在既有 bundle 大小提示。
- Web 架构注册回归：28 passed。首轮固定旧版本断言失败，已按入口变更更新版本断言并复验通过。
- check_shared_contracts.py 与 git diff --check 通过。
- 实际 bash start.sh demo：隔离库启动；/api/demo/status enabled=true，/api/architecture/validate valid=true。
- 全新 Playwright 会话：/demo → /showcase.html → /review，自动登录比赛演示学习者并显示复习内容；打开讲义、概念练习并提交错误答案，正常展示纠错与步骤入口。
- 讲义尾注计算样式：12px、18px 高、static、透明背景。手机 390px 视口无横向溢出。
- 未执行：线上部署、真实模型生成、桌面安装包构建及安装、外部场景完整业务验收；这些不由本次本地入口测试替代。
