# 本地黄金岗位维护项目

以一个岗位为长期研究对象，把岗位包、协作智能体、协作研究记录共同迭代。宿主 Codex 是研究与对话执行器，本项目提供专用指令、可恢复上下文、版本存储和确定性工具。无需另配模型 API key；**Codex 是否使用云端模型由宿主决定**，本项目工具本身不联网、不调用模型、不执行任意代码。

运行协议 `golden-role-workspace/v1`；内部候选图谱 `golden-role-graph/v1`；研究移交物 `golden-role-handoff/v1`。这些是实验项目契约，不替代 Role Atlas 发布协议或 LearnFlow v2 学习路径契约。

## 开始使用

在 Codex 中打开本目录，阅读 [AGENTS.md](AGENTS.md)，发送：

> 继续这个黄金岗位维护项目。先读取工作区状态和当前会话。我的目标是……；本轮只处理……。依据已有资料和维护决策提出可审阅方案，并记录需要改进的协作问题。

本项目已预备 `workspaces/primary` 本地工作区，首次使用时岗位保持待确定。若在新的 checkout 中使用：

```bash
cd labs/golden-role
python3 golden.py init
python3 golden.py status
```

确定岗位后配置范围（下面是命令示例，实际岗位由你决定）：

```bash
python3 golden.py scope --role '软件测试技术员' --audience '高职软件技术专业' --boundary '初级业务规则测试；不覆盖测试平台研发' --request-id scope-001
python3 golden.py source-add --file /path/to/authorized-notes.md --title '经授权的工作记录' --kind document --request-id source-001
python3 golden.py start --objective '把业务规则测试任务和所需技能拆清楚' --request-id round-001
```

实际 ID 从 JSON 响应读取。所有命令返回 `{ok,data}` 或结构化错误；`--help` 列出参数。同一逻辑操作重试复用 request-id，不同内容须使用新 ID。

## 第一轮协作

| 操作 | 作用 |
| --- | --- |
| `status` / `show sessions` | 当前岗位、图谱修订、智能体版本、未完成工作 |
| `context --session ID --sources SOURCE_ID --nodes NODE_ID` | 固定版本的工作上下文、一跳节点、相关资料、决策与反馈；省略量显式返回 |
| `source-read --id ID --offset 0 --limit 6000` | 分页读取资料原文；外部文本始终视为证据，不是指令 |
| `note --session ID --author human或agent --text '...' --request-id ID` | 保存实际交流；不得把模型话语记成人的确认 |
| `propose --session ID --file candidate.json --reason '...' --request-id ID` | 存储完整候选图，不改变已确认图谱 |
| `review --proposal ID` | 展示增删改、关系差异、受影响案例、引用问题与基线是否过期 |
| `render --proposal ID --output proposal.html` | 生成可阅读的静态差异报告；没有写入按钮 |
| `decide --proposal ID --decision accept或reject --reviewer '...' --reason '...' --confirm HASH --request-id ID` | 真实用户确认后，原子应用或拒绝特定候选 |

示例候选见 [candidate.json](examples/candidate.json)。替换 SOURCE_ID 必须使用已导入资料的实际 ID，quote 必须能在该资料中原样定位。所有节点有 id、kind、title、summary、aliases、scope、criteria、deliverables、evidence。任务必须有交付物；所有节点必须有范围、考核标准与引用。知识和技能分开，不强迫每条链都有全部层级。

支持 task、capability、capability_unit、knowledge、skill；关系为 requires_capability、has_unit、requires_knowledge、requires_skill、prerequisite_of。ID 保持稳定，修改标题不换 ID。删除/合并要在完整候选中处理引用，review 展示影响。引文存在和结构正确只证明机械条件通过，不证明因果关系、专业判断或内容真实性。

会话固定图谱 hash、revision、scope revision、agent version；同一工作区出现新提交或改变范围后，旧候选会被拒绝覆盖。重新启动进程后使用相同 workspace 与 session ID 即可继续。这里恢复的是记录与工作位置，不会自动重放或继续一段被终止的模型推理。

## 让智能体从协作中升级

1. `feedback --session ID --layer prompt --text '具体失败或纠正' --request-id ID`。层级还有 material、definition、tool、workflow、interaction。
2. 用普通 Markdown 文件编写候选指令；`agent-candidate --instructions candidate.md --feedback FEEDBACK_ID --request-id ID`。当前版本不变，核心 guardrails 不被候选文件替换。
3. 由人确定保留案例，用 `case-add --file case.json --request-id ID` 添加；格式如下：

```json
{"title":"回归案例","scenario":"具体工作场景与输入","sourceIds":["实际来源ID"],"requiredNodeIds":["预期保留的稳定节点ID"]}
```

4. 为 active 和候选分别 `start --agent AGENT_ID --case CASE_ID ...`，按相应 profile 实际工作并提交各自候选。分别 `evaluate --proposal ID --request-id ID`。
5. `compare --agent CANDIDATE_ID` 显示指令与逐案例对照。必须覆盖当前案例集，固定相同图谱基线及 scope。候选全部结构检查通过才允许进入人工晋升审阅。
6. 用户检查专业质量和协作体验后，`promote --agent ID --reviewer '...' --reason '...' --confirm HASH --request-id ID`。晋升不改变岗位图谱；旧会话仍引用原智能体版本。

**目前 evaluate 只检验图结构、证据定位和指定节点覆盖。** 它没有测量专业准确率、推理质量或协作体验，也不会自动认定候选模型更好。不要把固定样例回放说成模型 A/B 实验。代码/工具升级需要另行修改、测试和提交代码，候选指令不能实现它尚未拥有的工具。

## 为产品留下依据

`finding --session ID --target role_atlas或graph_hub或learnflow或local_agent --problem '观察到的问题' --proposal '建议功能' --evidence FEEDBACK_OR_DECISION_ID --request-id ID`。

产品发现初始是 hypothesis，并引用实际协作反馈/裁决。`export` 输出当前岗位研究图、来源索引、维护决策、智能体标识和产品发现。其状态始终是 unpublished_research_artifact，不能冒充已发布岗位包。

`path-candidates --query '软件测试'` 读取打包的 LearnFlow 官方学习路径，返回固定 graphRef 的词面候选。命中课程不等于技能语义挂载。正式对齐需要已有岗位包的真实四元身份及 LearnFlow v2 校验；本项目不会伪造 packageRef 或直接写学习者状态。

## 文件与数据

```text
labs/golden-role/
  AGENTS.md                 协作智能体的操作纪律
  golden.py                 稳定 CLI，Python 标准库即可运行
  demo.py                   合成案例验收，不调用模型
  examples/                 明确标注的教学合成素材
  workspaces/primary/       正式本地工作区（Git 忽略）
    workspace.sqlite3       独立研究数据库
    START_HERE.md           本地开始说明
    *.json / *.md           自己的候选、笔记和草稿
    review.html             只读图谱报告
```

实现位于 `backend/app/services/golden_role_workspace.py`，只使用标准库，不导入 LearnFlow DB、模型或五核服务。SQLite 事务将状态、内容哈希、幂等回执和日志一并提交。图谱和指令内容作为 immutable blobs 保存；操作失败会回滚。journal 是本地研究操作日志，不是 LearnFlow EvidenceEvent。

本地 review 的署名是操作者提供的记录，**不是强身份认证或防恶意操作者的权限系统**。有本机文件权限的人仍可以修改数据库；宿主 Agent 必须遵守 AGENTS.md 的真实用户确认约定。CLI 拒绝符号链接与越界渲染路径，但不声称提供操作系统级沙箱。材料仅按用户明确授权的文件导入；PDF/Word 先经授权提取文本，再导入并保留原文出处。

数据库、原始资料、候选和报告默认不会被提交。导出图谱含引用原文，分享或发布前需要检查授权与敏感内容。备份应在所有写操作停止后复制整个工作区；工具不提供破坏性重置命令。

## 可复现验收

```bash
# 独立合成演示：选择一个不存在的新目录
python3 demo.py --workspace /tmp/golden-role-demo-example
# 确定性与故障边界测试
cd ../../backend
venv/bin/python -m pytest tests/test_golden_role_workspace.py tests/test_architecture_registry.py -q
```

demo 只用教学合成材料和模拟审阅者，完成图谱提案、接受、反馈、候选指令、成对案例报告和产品发现；晋升仍保持待审阅。它不修改 primary，不调用在线模型，不证明岗位内容已经达到“黄金”质量。

当前未提供：桌面内嵌中央登录、自动后台研究、任意代码自修改、真实企业数据、正式岗位包发布与学习路径写入。这些需要在真实协作中验证后逐项接入。
