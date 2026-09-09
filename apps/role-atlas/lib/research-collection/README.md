# 测试研究记录导出

`intake` 是岗位澄清、说明草稿及说明改进的运行分类，来源为 `role_intake_revisions`。它与冷启动、迭代及工作区记录一起进入管理员项目计数、历史列表、单轮详情、分类型导出、项目 ZIP 和全部项目 ZIP。

修订的 `state` 保留原值；`ready` 只在通用运行列表映射为 `completed`，表示本轮说明整理结束，不代表用户已确认、图谱已构建或发布。`run.json` 保留 operation/input/content hash、前序修订、失败信息、租约观察值、确认主体/时间和关联 `build_run_id`。`intake-state` 是导出时会话的当前指针，不冒充历史事件。说明阶段没有独立事件表，不生成虚构运行事件。

- `inputs.json`：实际提交动作、提示词、目标和显式资料。
- `sources.json`：分别保留用户提交、修订中沿用的资料与独立检索正文。
- `model-calls`：按修订 ID 关联的实际模型请求、响应及失败记录。
- `result.json` / `research-report.json`：完整候选岗位或 JD、问题、警告、来源与查询报告；失败时结果可以为空。
- `attachments`：实际原件，包括从前一版沿用且属于同一用户项目的资料引用。原有附件关联不被改写。

JSON 沿用统一凭据脱敏；输入中的 `providerConfig` / `searchConfig` 等凭据字段不得输出。附件仍按已有协议保留原始字节。现有 `role-research-archive/v1` 增加可选 `intake` 目录，不改变既有目录契约。

老数据库没有 intake 表时，读取返回空分类，不创建或迁移 intake 表。测试通过注入隔离 SQLite 执行生产查询和 ZIP 流，验证用户/项目及类别范围、来源身份、失败与确认关联、沿用附件、凭据脱敏、manifest 哈希和旧表兼容。生产入口仍使用现有管理员权限校验。
