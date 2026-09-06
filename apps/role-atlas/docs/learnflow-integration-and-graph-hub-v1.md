# Role Atlas × LearnFlow：共享身份、学习路径与 Graph Hub v1

状态：`implemented foundation`
日期：2026-09-02

## 1. 结论

LearnFlow 与 Role Atlas 是对等的一级产品；Role Atlas 的岗位图谱读取能力也可以作为 LearnFlow 插件出现。Graph Hub 是两者共用的发现层，不归属于任一产品。三个入口必须共享同一主体身份和同一组知识边界：

1. LearnFlow 是注册、登录、账号、学习者身份与个人学习状态的唯一权威；Role Atlas 不保存第二份密码或会话。
2. LearnFlow 官方学习路径图是共同坐标；个人节点与个人语义属于学习者；岗位包语义属于固定岗位包快照。三层只通过显式映射关联，不互相覆盖。
3. Graph Hub 使用内容寻址的通用图文档和独立审核状态机。官方图公开；个人图未审核时只对所有者可见，审核通过后公开。
4. LearnFlow 插件的 `search_graph_hub` 只做有界检索与推荐。它不修改图谱、不确认学习路径、不写 EvidenceEvent 或五核。

## 2. 共享身份

Role Atlas 的 `GET /api/auth/session` 把浏览器携带的 opaque LearnFlow cookie 或 desktop bearer 转发给配置的
`LEARNFLOW_BASE_URL/api/auth/me`。只有 LearnFlow 返回有效账号后才形成主体：

```text
LearnFlow learner_id=23 -> graph subject learnflow:learner:23
```

Role Atlas 不解析、不落库、不记录密码或 session token。未登录与认证服务故障分开处理：前者返回 401，后者返回 502/503，不能在认证故障时降级成匿名 owner。

部署时应让两个产品位于可安全传递会话的同站点边界，或者由受信反向代理转发认证材料。跨站点部署应改为 LearnFlow 签发的短期 audience-bound token；不能把可伪造的 `x-user-id` 当作身份。

## 3. 学习路径的三层语义

| 层 | 权威 | 存放位置 | 可改变什么 |
|---|---|---|---|
| 官方语义 | LearnFlow 官方图 | `LearningPathNode` | 官方标题、摘要、别名、领域、阶段与来源 |
| 个人语义 | 当前学习者 | LearnFlow 个人覆盖事件/投影 | 个人命名、目标、状态、个人节点与连接 |
| 岗位包语义 | 固定 Role Package | `SemanticNode` + `RoleLearningPathBinding` | 某岗位如何解释并要求这个知识/技能 |

岗位包生成时读取“官方图 + 当前用户已确认的个人节点”作为检索候选，但写入岗位包的是独立岗位语义节点及其映射：

```text
Role SemanticNode --requires/practices--> LearnFlow LearningPathNode
```

映射不能写学习者状态。图谱缺口可以产生 `RoleLearningNodeProposal`；只有通过 LearnFlow 的个人节点确认入口后才形成
`vnext_personal_path_node_added` 事件。Role Atlas 不直接写 KernelState，也不把岗位需要推断成学习者掌握或未掌握。

## 4. Graph Hub 协议

Graph Hub v1 是可独立运行的文件目录：

```text
graph-hub/
  graph-hub-policy.json
  catalog.json                       # 仅官方图和已审核个人图
  objects/sha256/<hash>.graph.json   # graph-hub-document.v1
  submissions/<id>.json              # owner + review state
```

图类型支持 `learning_path / role_semantic / role_process / knowledge / custom`。提交状态：

- `official`：仅 policy 中的官方维护主体可提交，直接进入公共目录；
- `personal + pending`：只进入匹配 `audienceSubjectId` 的所有者目录；
- `personal + approved`：独立 reviewer 审核后进入公共目录；
- `personal + rejected`：仍只对所有者可见，便于修订，不向其他主体泄露。

所有目录都带 canonical SHA-256 root hash。所有者目录还固定 `audienceSubjectId`；LearnFlow 插件必须用认证得到的
`learnerId` 重新构造主体并校验，不能接受模型或请求参数提供的 owner。

本地可直接运行：

```bash
npm run graph-hub -- init --hub ./graph-hub --official official:learnflow --reviewers reviewer:one
npm run graph-hub -- submit --hub ./graph-hub --file ./agent-map.json --owner learnflow:learner:7 --kind personal
npm run graph-hub -- export-view --hub ./graph-hub --out ./learner-7-catalog.json --actor learnflow:learner:7
npm run graph-hub -- search --hub ./graph-hub --catalog ./learner-7-catalog.json --actor learnflow:learner:7 --query "Agent 评测"
```

## 5. LearnFlow 插件工具

模型可见名：`role_capability_graph__search_graph_hub`

何时使用：用户询问有哪些相关图谱、希望按学习目标推荐图谱，或尚未确定要进入哪种图谱。
不要使用：已有固定岗位包和稳定对象 ID 的局部读取；图谱编辑、审核、发布或个人路径确认。

输入示例：

```json
{
  "query": "Agent 评测学习路线",
  "graphTypes": ["learning_path", "role_semantic", "knowledge"],
  "topK": 5
}
```

输出 `learnflow.graph-hub-recommendation.v1`，包含候选图的不可变身份、审核/访问范围、匹配节点、分数和明确的
`coverage.returned / omitted / truncated`。工具最多返回 10 个图、每图最多 6 个节点，不静默省略。

本地集成可通过 `LEARNFLOW_GRAPH_HUB_CATALOG=/absolute/path/to/scoped-catalog.json` 指向单个目录。多用户部署使用
`LEARNFLOW_GRAPH_HUB_CATALOG_ROOT`：公共目录位于 `catalogs/public.json`，个人目录位于
`subjects/<sha256(learnflow:learner:<id>)>/catalog.json`；文件由服务端根据正式 learner id 选择，浏览器和模型都不能提供 owner。

## 6. 后续实现顺序

工作台的“在 LearnFlow 中引用”失败提示独立于图谱装载状态，在标题下方显示；图谱已加载时也必须可见。重试清除旧提示，15 秒超时后恢复按钮。`ROLE_ATLAS_REGISTRY_UNAVAILABLE` 表示交接代理读取岗位包目录失败，与 `LEARNFLOW_LOGIN_REQUIRED` 区分；不能将目录故障提示为需要重新登录。非 JSON 网关响应显示可重试的 HTTP 错误。该修复不改变交接令牌、主体绑定或学习证据契约。

当前版本完成共享会话校验、通用 Graph Hub 状态机、权限过滤、内容寻址目录、Graph Hub 市场页、LearnFlow 插件检索工具，以及 Graph Hub/Role Atlas 到 LearnFlow 新对话的主体绑定签名交接。两产品同机部署入口见 `deploy/cohost/`。
下一步应按以下顺序继续：

1. LearnFlow 增加服务端学习路径导出接口，只返回当前主体的官方图、已确认个人节点和个人语义覆盖；
2. Role Atlas 冷启动服务端用共享身份拉取该导出，停止信任浏览器提交的个人图；
3. 把文件 Hub 的相同状态机接到 D1/R2 HTTP 网关，保留协议和审核不变量；
4. 为 Role Atlas 增加全站项目 owner 隔离，并把公共市场与所有者目录统一到 HTTP 网关；
5. 增加个人节点提案的 LearnFlow 确认 UI 和幂等写入回执。

这些工作完成前，`/api/auth/session` 是共享身份验证入口而不是完整的全站授权门，文件目录是可验证基础合同而不是多副本在线存储。

## 2026-09-06 分类与检索

Graph Hub 面向计算机专业群，分类规则位于 `lib/hub/taxonomy.ts`（版本 2.0.0）：软件开发、软件测试、网络与运维、云计算、网络安全、数据技术、人工智能、物联网与嵌入式、数字媒体与交互设计、IT技术支持，以及待归类。所有方向固定展示，空方向显示 0 和共建入口，不生成虚假岗位包；筛选项换行展示。

公开 Registry 与文件目录共用确定性规则：先看岗位名称，再看别名；没有命中时接受标准方向标签，否则进入待归类。专门岗位优先于泛化的软件/运维标签。简介中的“设计系统”“不拼算法”及其他岗位边界、节点技能不参与归类，避免误判。原始行业字段保留在来源数据和 sourceCategories 搜索元数据中，不作为导航分类，不增加重复分类。

新公开发布在目录读取时自动归类；文件图谱在提交后重建目录时生成分类。旧文件目录的分类在通过原始哈希校验后重新投影，无需迁移数据库、修改不可变图谱或重新发布。分类可与名称、别名、节点能力检索组合使用，返回匹配依据；归类不依赖模型和网络，不改变审核与可见性。

Contract impact：catalog.v1 与岗位包保持兼容；分类词表从全行业纠正为计算机岗位方向（2.0.0）。Registry 只读投影新增可选 sourceCategories 保留来源行业标签，categories 只返回标准方向。旧分类链接若不在新词表中显示空结果，不静默映射到无关方向。LearnFlow Agent、事件及五核契约无变化。
