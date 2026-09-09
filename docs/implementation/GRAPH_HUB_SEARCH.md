# Graph Hub 岗位与典型任务检索

Contract impact（registry 2026-09-09.3）：扩展既有只读 `graph_hub_reader`，复用 `/api/hub/search` 和 `graph-hub.discovery.v1`。不新增 Agent、学习事件、数据库或五核字段。旧客户端省略 target 时仍综合检索；响应新增字段向后兼容。新客户端任务模式不接受缺少任务引用的旧响应。

## 一条公共检索链

发布 Registry 推荐版本 → listPublicHubEntries → searchHub → GET /api/hub/search。
Role Atlas 冷启动直接调用同一服务算法并校验发布访问、制品及版本哈希；LearnFlow 岗位图谱插件调用 HTTP 接口。Hub 市场页消费同一算法。私有和非岗位图谱的本机目录不并入公开索引，继续原有 ownership/hash 校验。

参数：

- `q`：岗位名称、别名或任务描述（最多 500 字）。空值用于目录浏览。
- `target=role|task|all`：默认 all；冷启动固定 role；插件 search_graph_hub 可指定；list_role_packages 固定 role。
- `role`：可选岗位名称限制，与任务查询同时满足才返回。
- `category`、`offset`、`limit`：分类和仓库分页。

每项保留 packageId、release.id、packageVersion、snapshotId、rootHash。`matchedTasks` 仅含 task/typical_task，返回稳定 id、label、type、summary，最多六项；`matchedTaskCount` 标明未截断数量。total 为匹配仓库数。任务 ID 仅在所属固定版本内解释，发现不代表已加载或已选择。

## field-coverage.v2

名称和登记别名优先；岗位检索只使用岗位身份，不因技能或简介偶然提到某行业而推荐整个岗位。任务检索单独限制节点类型，并查任务名称、别名、说明。

NFKC 归一化、中英文词和中文二元词片段、少量明确同义词归一化，剔除“工程师/岗位/我想了解”等通用后缀与问句。岗位括号中的方向不替代主岗位名称。完整名称优先，其次需要至少 65% 有效查询词片段覆盖；不以任意一个词命中、分类重合或目录仅有一个包作为推荐理由。无足够匹配返回 not_found；上游或制品错误返回 unavailable，二者不混淆。

这是可解释的词面检索，不声称任意长文本都能语义理解。别名未登记、同义改写过大的长尾查询可能少召回；后续基于真实测试查询评估再扩展，不能用无关岗位填满推荐列表。历史待确认草稿读取时重新查询公共推荐，不修改已确认正文/hash，也不篡改历史研究档案。

## 页面恢复与说明呈现

历史 citations 同时存在 `{title,url,fetchedAt}` 网页来源和图谱节点引用。读取历史和流事件时统一校验，网页显示来源链接，节点显示真实生命周期与可选有限置信度。缺失或非法置信度不补成虚假的 0/1；旧历史无需迁移。

岗位确认页只展开当前说明，旧输入与讨论折叠；语义标题和编号列表改善阅读，来源原文独立展开。只转换显示，不修改确认依据。

## 验证

定向回归覆盖云计算与大模型岗位误匹配、任务类型隔离、角色限制、固定版本、无结果、服务失败、旧来源引用恢复、缺失置信度及当前草稿去重。完整命令和实际结果见本轮验证记录。
