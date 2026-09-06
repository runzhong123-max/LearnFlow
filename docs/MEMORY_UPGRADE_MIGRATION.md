# 五核记忆升级迁移记录

2026-09-06，将用户指定的 `/Users/a1-6/LearnFlow app/edagent` 五核升级迁入 LearnFlow 当前 main。
来源是用户 fork `runzhong123-max/edagent` 中 Ryan 的 `ed680826d66fb60f77c7ee80a20e5388428bcd89` 与 `3e71c8332f151f367def3ace06be0334c8123538`。未发现独立 LICENSE 文件；本次依据用户对其升级成果的明确迁移请求，仅迁移这两组增量并保留作者与来源记录，不据此声明第三方代码的开放许可。

## 范围与 Contract impact

注册表从 `2026-09-06.1` 升至 `2026-09-06.2`，登记新增事件与控制字段；保留当前学习路径 v2、Graph Hub、岗位插件、正式任务交接和模型截止时间控制。

- 模型观察改为有原事件引用的 `semantic_observation_proposed` 短期候选，不能冒充用户原话或掌握证据。
- 目标及偏好支持部分更新、替换和撤回；撤回的依据及衍生认识不再进入有效检索与合成。
- Module policy 升至 `memory-module-version-v2`，按独立事件判断门槛，优先处理纠正与验证，失败最多重试三次。能力措辞遵守确定性证据等级。
- 检索先限制 scope 再截取候选，保留旧主题召回；所有关联路径统一应用有效状态、敏感信息与答案过滤。
- `vnext_teaching_input_received` 把直接用户输入转成确定性教学控制投影，按当轮、会话或明确持续偏好生效。网页、Native、正式技能回合共享幂等语义；隐藏控制和资料不冒充用户表达。
- 学习任务规划读取有 scope 的 ContextPacket；答错后的局部讲法轮换不再冒充用户明确拒绝；无变式不显示可迁移。
- 画像概览显示当前重点、已有基础、最近进展、如何帮助我，保留来源与管理入口。

三类主 Agent、五核和唯一写入链保持不变。新增控制只是 reducer 管理的 KernelState 投影，不成为另一套长期画像。

## 兼容与发布

不新增数据库结构迁移，不复制日常数据库，不批量重写历史事件。旧客户端可忽略增量字段；新网页与后端需要一起发布，才能保证用户输入在读取指导前入账。保留既有 schema 与稳定 ID，只有新增事件、注册表版本与 Module policy 发生上述变化。

来源分支的桌宠、实验工作台、桌面打包、供应商调整和发布流水线均不在范围内。当前工作区其他并行修改不属于本次提交。

回退采用新增 revert 提交并共同回退前后端，先停止新事件写入；保留事件账本，不能用删除历史或降级数据库冒充回退。无需执行真实数据迁移。

## 本仓库实际验证

- `cd backend && venv/bin/python -m pytest -q`：515 passed、1 skipped；包含架构漂移、记忆、即时指导、纠错、复习与用户隔离。跳过的是已被平台统一凭据取代的旧账户私有密钥 CRUD 测试。
- `cd frontend && npm test`：396 项通过，包含新增画像、记忆上下文与即时指导测试，以及当前主线插件、路径和模型预算回归。
- `cd frontend && npm run build`：通过；现有大 chunk 提示仍存在。
- `cd backend && venv/bin/python scripts/evaluate_memory_upgrade.py`：完成隔离 SQLite、零网络的三组检索评测；仅验证合成夹具上的检索与状态合同，不能代表学习收益。
- `bash start.sh demo`：隔离数据库 seed 与前后端启动成功；`/api/demo/status` 返回 enabled/offline=true，`/api/architecture/validate` 的 schema_valid、implementation_valid、valid 全部为 true。
- 浏览器检查 `/review` 和 `/learner-profile`：页面正常，四块概览可见；隔离演示账号偏好修改即时刷新，停止使用后出现恢复入口；浏览器错误日志为空。
- `git diff --check`：通过。
- 另从暂存区导出隔离副本（排除所有其他任务的未提交改动），复跑后端得到相同的 515 passed / 1 skipped，前端 396 项测试与构建也全部通过。

首次后端测试从仓库根目录运行导致 app 导入失败，改用规定的 backend 工作目录后全量通过。首次 demo 端口监听被沙箱阻止，获自动授权后启动通过。没有把这些失败尝试算作通过。

未执行真实学生试点、线上部署或真实数据库迁移；本任务交付代码迁移及本地隔离验证。原有确定性语言提取仍可能漏识别复杂转述，八小时临时指导上限也不是个体化遗忘模型。
