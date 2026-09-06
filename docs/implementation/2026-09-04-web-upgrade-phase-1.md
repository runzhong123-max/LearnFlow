# 网页端升级第一批：Graph Hub、视觉终态与节点引用

日期：2026-09-04。代码状态为本地实现，未部署线上；本批不等于八项升级全部完成。

## 已实现

1. 岗位图谱插件通过配置的 `LEARNFLOW_GRAPH_HUB_BASE_URL` 调用公共发现 API。已加载岗位包与公开可发现包分开显示，保留版本、快照和哈希；服务不可用不再被解释为“岗位不存在”。公共发现不携带身份凭证、不自动安装、不自动创建个人节点。
2. 图谱查询复用 Role Atlas 发布内容及排序结果；私人 scoped catalog 仍走已有权限/完整性检查。发现服务限制超时、响应体大小与结果数，并拒绝非法身份和自相矛盾的总数。
3. “动画失败 → 改成图片”在独立讲解、VisualBrief 和实际工具参数三个阶段使用同一前文主题。新主题优先于旧产物；失败提示不能成为主题来源。不使用领域、岗位或算法关键词白名单。
4. 视觉工具抛异常会产生与原 toolCallId 关联的失败终态；生成等待与子生成调用共享剩余回合预算，不在预算耗尽后继续新调用；迟到阶段回调不能把终态改回运行中。已提交讲解保留为 `explanation_only`，不自动改成其他媒体类型。
5. 岗位结构图支持缩放、一跳聚焦、邻接高亮、较大标签和边方向。环形位置表示语义层级，不表示学习者能力评分。
6. 图谱节点可拖入整个当前对话区域，生成引用草稿。仅接受当前消息中真实工具对象的完整内容匹配，避免跨快照同 ID 混淆与伪造拖入对象。不发送消息、不写五核。

## Contract impact

发布时按用户确认同时纳入已有的注册身份防冲突、规划态预算/恢复和学习路径 v1 只读协议抽取。注册事件仅调整客户端幂等 ID，不改变事件类型、reducer 或掌握证据。Role Atlas 同仓源码的边界与验证见 `2026-09-04-role-atlas-monorepo.md`。

- 现有插件工具 ID、LearnFlow 三类主 Agent、Action Board 和 EvidenceEvent 语义不变，没有新增五核写入路径，架构注册表版本不变。
- 新的外部读取协议是 `graph-hub.discovery.v1`。`role_package_catalog` payload 增加 `availablePackages / hubStatus / hubTotal / hubTruncated / discoveryBoundary`；原 `packages` 继续仅表示已加载且可使用的包。
- `matchStatus` 可新增 `available_not_installed / discovery_unavailable`。部署需同步客户端、插件服务与提示说明；不得按空 `packages` 判断全站无匹配包。
- 视觉异常补发既有 `tool_completed` 事件，其 run.status 为 failed，不新增事件类型，不产生学习证据。
- 等待超时并不保证供应商停止计费或计算；持久化任务、刷新恢复、供应商级取消另行实施。
- 学习路径协议 v2 和来源/语义覆盖层尚未实现；现有学习路径改动保持用户原状，不将它们记作本批成果。

## 配置和发布顺序

先发布 Role Atlas 的 `/api/hub/search` 及正确的公共跳转/launch 代理配置，再更新 LearnFlow 前后端与插件。设置 `LEARNFLOW_GRAPH_HUB_BASE_URL` 为目标环境 Hub 地址；不要在组件里嵌入生产域名。公开目录发现不是登录桥接，导入仍需既有签名、scope 和版本校验。

若 Hub 暂未更新，插件返回 discovery_unavailable 而非伪造空目录。回滚应成组回退插件服务与客户端；不修改用户已安装的不可变岗位包。删除/恢复职责留在 Role Atlas，不级联删除 LearnFlow 引用。

## 已执行验证

- 前端 `npm test`：361 项通过。
- 前端 `npm run build`：通过；有既存的大 chunk 警告。
- `backend/venv/bin/python -m pytest tests/test_architecture_registry.py -q -p no:cacheprovider`：18 项通过，有既存弃用警告。
- 覆盖公开发现的网络异常/未配置/非法身份/计数冲突、不同快照同包版本、插件真实注册入口、伪造拖拽、视觉续接主题、异常终态、超时等待和迟到回调。
- Role Atlas 配套测试 135 项通过；隔离浏览器验证了节点检索、进入工作台、整栏拖拽和回收站配置错误提示。

未执行：真实付费模型生成、生产域名登录/导入、真实生产迁移、完整 LearnFlow 登录后视觉 UI 的端到端联调。不能据离线测试宣称线上冷启动或图像生成已经恢复。

## 后续工作

- 学习路径 v2：节点简介，官方/个人归属与 chat/tool/package 来源分离，带 namespace/source/version 的语义覆盖层；v1 读兼容，候选确认事件和可回放迁移。
- 生成任务持久化与刷新恢复，客户端取消到服务器/供应商的真实传播，真实模型回归样例。
- Hub 分类治理、增量索引及可解释个性化推荐；岗位图完整分层布局和触屏替代引用交互。

## 后续进展（2026-09-06）

学习路径 v2 契约、官方简介增强与双版本静态导出已在后续批次实现；共享特殊节点持久化和岗位语义匹配仍未切换。具体范围见 [后续实施记录](2026-09-06-learning-path-contract-and-graph-workflow.md)。上文保留 9 月 4 日批次当时的验收边界。
