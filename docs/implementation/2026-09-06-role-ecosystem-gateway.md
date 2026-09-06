# 岗位图谱接入实现与验收

## 已实现

- 岗位生成 detail schema、提示词与编译器保留独立知识/技能的适用范围和可考核条件。
- Role Atlas 签名网关复用 Graph Hub registry，读取精确固定版本制品并校验授权、manifest/组件完整性。
- 有界只读岗位助手复用现有 graph；主体隔离的运行 ID、幂等执行与持久结果查询。
- v2 岗位要求解析、未解决项、特殊节点批次、LearnFlow 主体源图 CAS 与回执。
- `/ecosystem` 的搜索、证据、提问、挂载预览、确认；学习路径页显示 contains 岗位补充节点及定义详情。
- 后端官方契约制品与桌面打包入口；独立生产 Gateway Worker 可限制为唯一签名入口。

## Contract impact

架构注册表从 `2026-09-06.2` 升至 `2026-09-06.3`，登记 adapter、source runtime、工作台、三项 capability 与零 target 内容审计事件。现有三个主 Agent、EvidenceEvent schema 和五核 reducer 语义不变；不新增掌握来源。既有 v1 图谱与个人节点事件保持兼容，新增 source graph 不强制降级为 v1。D1 新增运行表，LearnFlow 新增源图 head、resolution、commit 三表，均为追加式建表。

`learningDefinition` 是向后兼容可选字段；旧包不会因缺失而无法读取，但不能自动成为定义完整的学习节点。历史版本不被静默重写。

## 已执行验证

- LearnFlow 后端全套：538 passed、1 skipped；增加最后一项组件登记后的 focused registry+gateway 回归 42 passed。
- LearnFlow 前端全套：406 项通过；新增客户端与 source adjacency 测试已纳入 npm test。
- Role Atlas 全套 145 项与 TypeScript 检查通过；生产 Worker 构建通过。
- LearnFlow 前端生产构建通过；已有 chunk 大小提示仍存在。
- `bash start.sh demo` 在隔离数据库成功启动；`/api/demo/status` enabled、`/api/architecture/validate` valid。
- 浏览器从 seeded `/review` 登录后进入 `/ecosystem`，验证未配置服务提示、禁用搜索、源图版本；进入 `/learning-path` 验证岗位补充区域与空态正常。
- `git diff --check` 通过。

测试期间发现的 dispatch 缺少 protocol、fixture assertionType 类型及注册表版本断言已修复并回归。初次演示脚本退出导致后台进程被执行环境回收，保持执行会话后浏览器验收完成。

## 未执行与后续范围

本次未部署线上服务，也未使用真实远端数据库或在线模型做跨服务联调；当前 demo 中网关未配置。桌面安装包未重打包签名；只更新了 source JSON 的 PyInstaller data 声明。桌面中央认证、组织级共享权限、官方源图迁移、任意节点编辑/删除、跨产品发布与长任务恢复仍需各自契约和验收。不能把本次 read-only Agent 运行记录称为已支持持久队列续跑。

完整 API、权限、自主性和配置说明见 [ECOSYSTEM_GATEWAY_V1](../product/ECOSYSTEM_GATEWAY_V1.md)。
