# Graph Hub 检索与岗位确认页修复验证

范围：公共岗位/典型任务检索统一接口、冷启动相关岗位、LearnFlow 插件接入、确认生成后恢复历史引用、岗位说明排版。

根因：历史 intake 的 citations 是网页来源 `{title,url,fetchedAt}`，恢复页面却强转为有 confidence 的图谱引用；调用 toFixed 导致整页异常。确认页又同时展示组合后的历史消息和当前 description。Hub 旧策略只要少量通用词命中就推荐，未区分岗位身份和技能内容。

## 已执行且通过

- Role Atlas `npm test`：415 passed；`npm run typecheck`、`npm run build` 通过。
- Web `npm run test:plugins`：99 passed；`npm run build` 通过。
- 后端 `venv/bin/python -m pytest -q`：1049 passed、1 既有 skip；包含注册表漂移与版本检查。
- 本地真实 `/api/hub/search`：只有大模型示例时，云计算工程师查询返回 `not_found`、0 项；target=task 返回真实 task/typical_task 节点，按任务名称再次检索保持同一个发布哈希。
- Playwright 本地隔离 API 夹具：当前岗位说明仅渲染一次、标题/编号列表正确、历史折叠；点击确认后只提交一次生成请求，确认 hash 保持不变；跳转项目页后网页来源链接与没有 confidence 的图谱引用同时正常呈现，无错误边界。
- `git diff --check` 通过。

任务接口第一次 urllib 请求经系统代理返回 502；禁用代理直连 localhost 后验证通过，返回“业务需求分析与 LLM 方案设计”任务，固定发布哈希一致。

初次受限环境运行遇到本地端口/IPC EPERM，随后在允许本地测试服务器的环境完整重跑通过。新增注册表版本断言同步后完整后端回归通过。浏览器控制台的本地 site-session.js 404 与夹具的 admin 403 属隔离预览预期请求；未出现 confidence/toFixed 运行异常。

## 边界

浏览器生成操作由本地夹具拦截，用于验证恢复和导航；没有新建线上测试项目、调用付费模型或重跑用户的正式图谱。检索使用可解释的词面覆盖和领域限制，不声称解决所有长尾同义表达。没有迁移历史数据库、改变确认内容/hash 或写入五核学习状态。

Contract impact：discovery.v1 加性字段和既有 graph_hub_reader 登记更新至 2026-09-09.3；旧客户端综合检索兼容，任务客户端拒绝缺少任务身份的响应。

合并远程 044304c：仅引入已发布的桌面 KEK 和 IP 证书相关改动，与本次业务文件无冲突；合并后重新执行 14 项检索/引用定向回归及架构注册检查。
