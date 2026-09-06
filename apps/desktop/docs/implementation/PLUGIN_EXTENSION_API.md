# LearnFlow 插件扩展 API v1

LearnFlow 第一版插件不是独立应用、工作台、进程或数据库。它是随 LearnFlow 一起加载的受信 Agent 工程包，
只向现有 Tutor 对话贡献四类能力：Tool、Agent Skill、Plugin Object 和 Tool Renderer。

```text
plugin manifest
  ├─ objects[]      版本化 JSON 对象合同
  ├─ tools[]        模型工具 schema、路由条件与本地 handler
  ├─ skills[]       使用条件、禁止条件、说明及 tool/object 引用
  └─ renderers[]    工具结果的客户端组件声明

Tutor Agent
  ├─ 合并已启用插件的 Tool definitions
  ├─ 把已启用插件的 Skill instructions 放入本轮上下文
  ├─ 调用 namespaced handler 并校验 Plugin Object
  └─ 把结果作为 TutorToolRun 回灌模型和对话

conversation ToolRun
  └─ renderer id → 插件组件；缺少组件 → 通用对象卡
```

## 1. Tool

每个 Tool 声明稳定局部 ID、标题、功能描述、正反路由条件、严格输入 schema、输出对象类型、可选 renderer
以及本轮适用的 Tutor mode。宿主把模型可见名称确定性限定为 `plugin_id__tool_id`，插件和核心工具不会
共享未限定命名空间。

第一版只接受 `read_only` 和 `artifact` 风险等级。插件 Tool 不能写五核、EvidenceEvent、LearnFlow 核心对象，
也不能批准自己的产物。输入拒绝额外字段；输出必须是有界 JSON，失败以结构化 ToolRun 返回。

`artifact` 表示未提交候选制品，不表示副作用授权。它可以承载生成/迭代合同、候选 patch、diff 与校验报告，
但必须显式给出基线、状态、限制和停止条件；插件 Tool 不能把候选批准为正式版本，也不能原地覆盖既有对象。
若宿主尚未提供独立持久化/确认能力，Renderer 和 Tutor 必须明确显示“尚未创建或发布”。

Tool 描述必须同时说明“何时使用”和“不要用于什么”。插件数量增加时，宿主只暴露默认启用或本轮显式
启用的包，不把所有插件 schema 常驻塞入模型上下文。

## 2. Agent Skill

插件 Skill 是 Agent 工程里的操作说明，不是 LearnFlow 的教学法状态机，也不是第四类主 Agent。它声明：

- 何时使用、何时禁止；
- 本轮有界 instructions；
- 所引用的同包 Tool 和 Object type。

宿主只在插件启用时把 Skill 放入 Tutor 上下文，并自动把工具名限定到插件命名空间。Skill 不能改变评分、
掌握判定、LearningSkillRun、EvidenceEvent 或五核归约规则。

## 3. Plugin Object

Tool 返回的领域对象使用不可变信封：

```json
{
  "protocol": "learnflow.plugin-object.v1",
  "pluginId": "example_plugin",
  "objectType": "node",
  "objectId": "node:42",
  "schemaVersion": "example.node.v1",
  "label": "节点 42",
  "value": {}
}
```

宿主检查对象归属、声明类型、schema version、JSON 有限值、包内 validator 与总输出大小。Plugin Object
是工具结果中的事实边界，不自动成为 LearnFlow 数据库对象、学习证据、学习者画像或掌握状态。以后若需要
持久化，应另行设计明确的核心对象转换/确认接口，而不是扩张本协议。

## 4. Tool Renderer

Tool 可以在 manifest 中声明一个 renderer，并在成功结果中请求该 renderer。宿主把 renderer 限定为
`plugin_id:renderer_id`，对话中的通用 `PluginToolResultView` 根据注册表选择客户端组件。

Renderer 只获得已校验的 Tool result 和 Plugin Object；接口不提供工具调用、核心状态写入或 HTML/脚本注入。
找不到组件时，宿主显示通用对象卡和转义后的 JSON，不丢失结果。这让雷达图、事理森林、领域卡片等表现
由插件包自行实现，LearnFlow 主界面不出现岗位名称、对象类型或 renderer 的条件分支。

Renderer 还可以使用宿主提供的通用 `onPrompt(prompt)` 回调，把用户点击的对象和快照引用写入当前输入框。
该回调不发送消息、不调用工具、不改变插件数据或核心对象；用户仍需编辑或发送下一轮消息。Tutor 的近期
ToolRun 投影会有界保留 `presentation.state` 和最多 16 个 Plugin Object，支持代词式追问继续固定原快照。

宿主还提供两个不增加扩展点的确定性交互：`onReference(object)` 只接受已校验的 Plugin Object，并通过
`application/x-learnflow-plugin-object` 拖拽载荷或点击操作把 `pluginId + objectType + objectId + schemaVersion`
放入当前草稿；宿主会重新要求该引用命中当前可见 ToolRun 中的已校验对象，不信任任意外部拖拽 JSON。
发送草稿时，宿主同时提交学习者可见的 `plugin-object://` 引用文本和对应的完整已校验对象信封；前者用于对话可读性，
后者供本轮 Tool 路由精确读取 `label/value`，不得从展示文本反向解析领域对象。该结构化输入只存活于当前 Tutor 回合，
仍受 JSON 大小、对象数量、ownership 与 schema 校验约束，不能绕过插件 Tool 的项目范围或确认门。
`onOpenPaper()` 把产生当前结果的原 ToolRun 作为只读投影附到对话纸张。引用不会自动发送，
纸张不会复制 Plugin Object 的领域权威，两者都不能触发工具、Action、EvidenceEvent 或五核写入。视图切换
属于插件 Renderer 内部状态，例如同一岗位全景结果可以切换为能力雷达或对象卡片；宿主不理解这些视图语义。

## 5. 包目录与发现

内置插件放在 `frontend/plugins/<plugin_id>/`：

```text
server.ts       manifest + handlers，导出 default 或 plugin
client.tsx      renderer components，导出 default 或 plugin
```

服务端按目录排序发现 `server.ts/js/mjs`；客户端使用构建时 glob 发现 `client.tsx`。宿主代码不维护插件 ID
列表。包必须通过 `defineLearnFlowPlugin()` / `defineLearnFlowPluginClient()` 暴露贡献。缺少目录等价于没有
安装插件，不改变 Tutor 核心行为。

开发态服务端以整个插件目录的文件指纹作为加载版本，并由 `versionedPluginModuleUrl()` 把同一版本令牌传给
插件内部动态依赖。这样 manifest、runtime 与共享常量只会作为同一依赖图切换，不会把新入口和旧模块缓存
混合。生产态仍在进程生命周期内只加载一次不可变目录。

客户端包还可以声明 `name / description / icon` 展示元数据。通用 `PluginCapabilityPicker` 根据同一个构建时发现结果在
对话选项栏呈现插件，选择只形成当前对话的 `activePluginIds`；宿主不按插件 ID 添加按钮、文案或状态分支。
显式启用但尚未产生工具记录的插件仍可关闭；一旦插件完成或尝试过一次 namespaced Tool，宿主会从主对话及
纸张中的 `TutorToolRun` 确定性恢复其 `pluginId`，并把它单调合并进以后每轮的激活集合。选择器此后显示
“已使用 · 锁定”，不能单独取消；删除整个对话才结束这项上下文。该规则也覆盖失败 ToolRun，并同时在客户端
恢复层与 Tutor 运行时执行，不能通过刷新、切换纸张或省略 `activePluginIds` 破坏历史可重放性。

## 6. 首个官方消费包

`frontend/plugins/role_capability_graph/` 是首个官方实现，只读取已发布的不可变 Static Role Package，并可从受信 Graph Hub 目录读取当前主体可见的图谱候选：

- 十三个只读 Tool；`search_graph_hub` 负责按学习目标检索官方图、已审核个人图和所有者自己的未审核图，`list_role_packages -> reference_role_package` 负责用户明确选择与不可变引用，`research_role_node_risks` 只为解释节点证据、关系和事理风险；
- 一个证据化岗位图谱阅读 Agent Skill；
- 五类已发布岗位对象，加一类岗位包引用 Object 和一类只读节点风险解释 Object；
- 十二个 ToolResult Renderer，包括图谱推荐、岗位包目录、岗位包引用和节点风险研究。

Graph Hub 目录使用 `graph-hub-catalog.v1`。所有者作用域目录必须带 `audienceSubjectId=learnflow:learner:<id>`；宿主从正式学习者上下文把 `learnerId` 注入通用 Plugin Tool scope，插件据此校验目录，模型 schema 不包含 owner 参数。未审核个人图不得出现在公共目录，也不得在其他学习者的调用中降级为匿名可见。`LEARNFLOW_GRAPH_HUB_CATALOG` 指向公共目录或当前学习者作用域目录；工具最多返回 10 个图、每图 6 个命中节点，并显式返回 omitted/truncated。开发环境未配置目录时使用插件内置的公开种子目录，生产环境仍要求显式目录配置。检索结果是只读推荐，不写学习路径、Plugin 持久化权威、EvidenceEvent 或五核。

插件 runtime 按自身数据目录发现包并校验 manifest 中全部组件 SHA-256，包括 views、retrieval-index、
object-index、snapshot 与 reference-migrations；代码不写具体岗位、对象 ID 或快照 ID。
讨论特定岗位时，目录工具必须接收用户的岗位查询，只展示岗位标题、根节点 label 或 alias 与查询整体确定性包含匹配的候选；
无匹配返回 `matchStatus=not_found` 和 Role Atlas 自主研究入口，不能展示无关岗位包，也不能继续调用岗位内容工具。查询全部目录时
才省略 `query`。引用工具只有在学习者明确选择并原样提供 `packageId + packageVersion + snapshotId + rootHash` 时才固定引用。
后续工具必须复用该 selector。Role Atlas 基地址通过 `LEARNFLOW_ROLE_AGENT_BASE_URL` 配置，本地默认 `http://localhost:3000`；
开发态可把本机 role-agent 的有效静态包标为模拟可用，生产态不启用该隐式来源。读取结果固定同一四元身份并显式披露截断与覆盖。节点风险研究只读取当前
快照的两跳邻域、关系、证据、生命周期和显式风险，不联网补证据，也不生成修改建议或后继版本。冷启动、迭代、
审核、发布、Tag、回滚和 Registry 全部留在 role-agent/Hub；LearnFlow Tutor 没有这些生产入口。
维护期另有纯文件导入器：它只接收 role-agent 导出的 `static-role-package@3.0.0` bundle，在写盘前独立校验组件
hash、canonical root hash、snapshot 身份和版本冲突，再原子安装不可变目录。它不是模型 Tool，也不让候选制品
批准自己。纯文件 Hub 在其上增加独立审核和可见范围目录，LearnFlow 只安装公共已审核包或当前主体自己的私有包。
详细合同见 `docs/implementation/ROLE_PACKAGE_FILE_EXCHANGE.md` 与 `docs/implementation/ROLE_PACKAGE_HUB_ECOSYSTEM.md`。

## 7. 当前边界

- 这是受信的本机代码包；纯文件导入只提供维护期显式命令，不提供第三方下载、签名、runner、沙箱或对话内热安装。
- 没有 Plugin Instance、Snapshot、独立工作台、专用侧栏或插件数据库。
- “展开到新纸”只是既有 ToolRun 的对话内只读投影，不是 Plugin Snapshot 持久化对象或独立工作台。
- `defaultEnabled` 只适合官方内置能力；其他包必须由调用方传入 `activePluginIds`。
- Web Tutor 已具备 Tool/Skill 执行入口；Desktop 正式 Agent 在接入同一包加载器前不会自动执行前端插件 Tool。
- 特殊显示只位于对话 ToolRun 内，不形成第二套产品导航。

协议权威由 `backend/app/services/architecture_registry.py::PLUGIN_EXTENSION_POINTS` 和
`frontend/src/plugin-api.ts` 共同约束；测试必须覆盖命名空间、未启用状态、输入边界、对象归属、renderer
声明、重复 ID 和通用降级显示。
## 跨产品岗位包交接

Graph Hub 或 Role Atlas 可以把已发布岗位包交给 LearnFlow，但这不是模型工具调用。来源产品先用共享 HMAC 密钥签发最多 15 分钟、绑定 `learnflow:learner:<id>` 的 `role-package-launch.v1` 令牌；LearnFlow 的 `/api/agent/role-package-launches/consume` 验签、核对当前登录主体，并创建普通 `AgentSession + AgentMessage`。首条消息投影一个完成态 `role_package_reference` Plugin ToolRun，因此岗位插件会被锁定启用，后续读取只能复用令牌中的精确 selector。该入口不得写 EvidenceEvent 或五核，也不得把导航和会话创建暴露成模型可调用工具。
