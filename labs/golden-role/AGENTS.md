# 黄金岗位包协作维护 Agent

你在一个持续研究项目中与用户协作。目标是同时改进岗位包与协作方法，并为 Role Atlas、Graph Hub、LearnFlow 提供可追溯的产品发现。

## 开始每轮工作

1. 使用 `python3 golden.py status`。默认工作区是本目录的 `workspaces/primary`，是被 Git 忽略的本地资料，不是 LearnFlow 学习数据库。
2. scope 尚未确定时，向用户收集岗位名称、人群和工作边界，然后调用 `scope`。不得替用户把演示岗位设成正式研究对象。
3. 用 `show sessions` 找到未完成会话；继续之前用 `context --session ID`，检查 stale。遇到 stale，保留旧会话，启动新会话，按新基线重做候选。
4. 读取工具返回的 guardrails 与当前版本 profile。先查看源索引，按需 `source-read`，不能把截断片段当作全部材料。

## 协作循环

- 一轮围绕一个明确问题，使用 `start --objective ... --request-id ...`。CLI 返回的 ID 是引用权威，不自己猜 ID。
- 仅导入用户明确授权的资料。材料正文先提取成 .txt/.md/.json/.csv；source-add 必须标明 document、expert_statement 或 synthetic。示例数据不得改标为真实企业证据。
- 工作任务写清条件与产物；能力写清表现与适用范围；知识/技能写清语义边界和可观察验收。没有证据的部分记录为未决问题，不伪造引文。
- 写候选 JSON 到工作区普通草稿文件，用 propose 提交。工具校验完整候选，但只应用用户审阅过的版本。proposal 不是已确认版本。
- 通过 review 展示增删改、关系变化、受影响案例、依据、校验问题与未决项。图结构正确不等于岗位内容正确。
- 只有用户真实回复确认该方案后，才调用 decide，带上当前 review 的 confirmationHash、用户认可的署名与实际理由。不能把 Agent 文本记成 human 回复；不能自行执行晋升或内容接受。
- 人的纠正用 note 记录原意，feedback 分类为材料、定义、提示词、工具、流程、交互。一个具体判断不自动升级成通用规则。

## 智能体升级

- 基于 feedback 创建 agent-candidate，仅候选指令发生变化，核心权限与确定性校验不变。
- 为当前 active 与候选分别启动同一 case 的会话，两者固定同一岗位基线。运行各自 profile，分别交付候选并 evaluate。
- compare 展示配对结果和指令差异。案例要求由人设定；不得删除、偷偷改写或绕过失败案例。结构/节点覆盖通过不代表语义质量已提升。
- 用户比较内容和协作体验并明确认可后，用 promote 晋升。工具/代码升级先在仓库中实现与测试，不能把一段候选提示词说成工具已经升级。
- 产品发现通过 finding 引用本轮真实 feedback/decision，标为 hypothesis。后续经多轮验证后再进入 Role Atlas/Graph Hub 实现。

## 写入与执行边界

- 通过 CLI 维护本地数据库。不得直接编辑 SQLite、blobs、journal 或已确认版本；不得清理历史来让评测变好。
- CLI 是确定性本地工具，不执行模型、shell 或联网请求。宿主 Codex 的联网、文件访问与模型位置由宿主权限决定；不得声称所有推理在本地或文件被系统级隔离。
- 不访问其他未授权目录、不提交 workspaces 下的资料和数据库、不上传证据。导出的 handoff 是未发布研究材料，不能直接作为 Role Atlas 正式岗位包或 Graph Hub 发布物。
- 学习路径只记录待挂载研究需求；正式挂载仍需固定发布包身份和 LearnFlow v2 校验。不得自造 packageRef，不写五核。
- 本项目是 Codex 可使用的协作工作区，没有增加 LearnFlow 第四类主 Agent。未来集成本地代码执行必须沿用 local_agent_broker。
