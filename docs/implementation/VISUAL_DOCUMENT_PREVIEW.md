# 图解库空白预览修复

维护作品本身能运行，但桌面 Tauri 的 script-src 不允许内联脚本；iframe srcdoc 继承宿主 CSP，作品内部 CSP 无法放宽它，因此只有列表和空白预览。已用截图作品 course-security-c1-s1 在相同严格策略下复现。

Contract impact：registry 2026-09-14.2 / desktop 对应版本。复用 Learning Design 的 visual_content_library、retrieve_learning_visual 和 Visual Hub 工作台，登记只读 GET /api/visuals/document/{work_id}/{version}?digest=...。只允许已登记的 ready 维护 HTML，验证版本和内容摘要；不存在、私有或摘要不符返回 404，无请求体、任意 HTML、外部 URL 或文件路径输入。

POST preview 增量返回 document_path，保留原 html/builder；旧客户端兼容。桌面前端只将严格验证的公开路径映射到本机 /api，不使用带凭据的 /cloud/api，不向 iframe 传 token；浏览器保留原 srcdoc。独立导航文档使用自己的 CSP 和 sandbox allow-scripts，仍无 same-origin、联网、表单和宿主访问权限。Tauri 主窗口 CSP 不放宽，数据库和账号边界不变，无事件或五核写入。

播放器等待仅含有界高度的执行消息；加载失败或 12 秒内没有执行消息会显示错误与重试，避免持续空白。作品请求失败后的重试现在重新请求所选预览。只有维护库公开内容拥有这个端点，个人作品读取仍需原有授权。原生桌面包须包含此次前端和 sidecar 更新；云端部署不会替换已安装桌面应用。

验证覆盖：相同严格 CSP 下 srcdoc 空白与独立文档成功的浏览器对照；截图作品实际控件及图形；API 摘要、匿名本机 iframe 请求、404 和原私人 API 认证；URL 路由拒绝远程地址、云代理和凭据；双端构建及相关回归。

## 本次验证结果

- 两端前端完整测试：Web 561、桌面 483 项通过；两端生产构建通过。
- 后端全量：桌面 1172 passed / 5 skipped；Web 1156 passed / 2 skipped / 1 failed，失败为已有的并发兑换测试 SQLite database is locked；该用例单独重跑 1 passed。
- 最终文档端点与注册表回归：两端各 29 项通过；共享契约检查通过。
- Web 额外 test:visuals：19 passed / 1 failed，为未修改的 composition golden 节点坐标断言；该测试与实现均和上次发布一致。
- Chromium 使用桌面 CSP 验证截图作品可显示、错误提示与重试；未安装或替换原生桌面应用，未声称已验证用户实际宿主。
