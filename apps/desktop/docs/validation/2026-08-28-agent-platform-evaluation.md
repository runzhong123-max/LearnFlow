# LearnFlow Agent 平台七项升级测评

日期：2026-08-28
对象：视觉生成、教学 Skill、账号与模型凭据、人因核、学习文件与代码纸张、本地 Agent 协作、架构真实性与代码质量。

## 1. 验收结论

本轮七项工作均已进入真实运行链路，不再只是页面常量或提示词约定。三类主 Agent 边界、五核唯一写入链和确定性教学证据规则保持不变。上线结论分三档：

| 能力 | 当前结论 | 说明 |
|---|---|---|
| 图解与动画 | 可用 | 共用 VisualSpec v2；动画可重放，失败时诚实降级为图解 |
| 方法 / Skill 与输入栏 | 可用 | 正式 SkillRun、单轮单迁移、支架预算、可访问能力选择器 |
| 密码账号与账户级 API Key | 具备上线基础 | Argon2id、会话/CSRF/限流、AES-GCM；部署仍需正式秘密、HTTPS 与密钥轮换方案 |
| Human 同轮适配 | 可用 | 明确请求同轮生效、8 小时过期、普通错误不推断人因 |
| 学习文件与代码纸张 | 可用但有范围边界 | 常用格式可安全解析；代码只展示，通用生产执行失败关闭 |
| Tutor 本地 Agent Broker | 本地桌面可用 | 两次确认、隔离副本、diff 回写；不是远程生产沙箱 |
| 架构治理 | 通过 | registry 同时验证 schema 与真实 implementation binding，未实现能力不再冒充可用 |

## 2. 七项任务的效果检查

### 2.1 图解与动画

检查项：

- 计算机知识能表达调用序列、状态机、数据/张量流、内存布局、树图、并发时间线与分层系统。
- 数学知识能表达数轴/坐标、函数变化、线性变换、矩阵形状、几何约束、概率分布、微积分过程与证明步骤。
- 图解与动画共享节点、关系、状态、约束、provenance 与质量报告；不是两套不兼容模板。
- 动画用 typed patch 驱动，不执行模型生成脚本；每一步检查引用、invariant 和最终状态。
- 动画不可用时返回有效静态图，并在工具结果中标记真实 effective kind。

参考与设计理由记录在 `docs/VISUAL_TOOL_ENGINEERING.md`。本轮没有把 Mermaid、Cytoscape、ELK、Motion Canvas 或 Manim 的接口编造成已经接入；它们只作为对象模型、布局和时间线设计参考。

### 2.2 输入栏、方法与原子学习任务

已验证清晰讲解、苏格拉底追问、费曼复述、示例渐隐与讲义/练习共学等正式 Skill 的启动、推进、循环预算、验证入口和结束条件。关键约束：

- Skill 只能在带领学习态启动；自由态和规划态不伪装执行 Skill。
- 每轮最多一个子状态迁移，避免同一次模型回答跳过多个教学阶段。
- 用户可以自然回答或请求帮助；无需手动切换内部状态。
- 支架有上限，耗尽后确定性退出或 handoff，不无限追问。
- Skill 生命周期事件不升级掌握；正式 Attempt、明确 Human 请求或其他登记证据才进入 reducer。
- 输入栏展示实际可用 ID、禁用原因和当前选择，不复制一套前端状态机。

### 2.3 账号、权限和模型凭据

自动化覆盖注册、登录、登出、会话过期、CSRF、Origin、速率限制、旧密码升级、账户隔离、管理员列表和凭据加解密。Ryan 保持原 learner/数据库主键，只增加稳定展示号 `account_number=0` 与 admin role，避免破坏既有外键。

管理员列表不返回密码散列、session、API Key 密文或明文，只显示账户元数据和 `credential_configured`。Tutor runtime 只能通过服务端 bridge 按当前会话解析当前账户凭据；浏览器来源请求不能调用内部 bridge。

### 2.4 Human 核

明确的节奏、呈现、负荷、挫败和支持请求会在本轮 ContextPacket 组装前写入类型化 EvidenceEvent，因此本轮就能调整 Tutor。普通答错、低分、“我不会”或自我贴标签不会自动写 Human。完整正反样例、TTL 和缺口见 `docs/validation/2026-08-28-human-kernel-operation-evaluation.md`。

### 2.5 文件与代码纸张

已覆盖 PDF、DOCX、PPTX、XLSX、CSV、TXT、Markdown、RST、IPYNB、常见代码和配置文件。解析统一产生带页码、slide、sheet/cell、cell 或代码段位置的 provenance。宏 Office、压缩炸弹、归档、可执行文件、伪装 MIME、损坏 OOXML、秘密和超预算内容会被拒绝。

代码纸张具备多文件标签、独立草稿、行号、语言和输出区域；当前只允许单文件正式提交。没有 Monaco/LSP，也没有把浏览器预览伪装成安全执行器。

### 2.6 本地 Agent 协作

Broker 由 Tutor 所有，Profile 决定允许的 adapter 和参数，运行前后分别请求授权。副本没有 `.git`、远端地址、历史、`.learnflow`、数据库或密钥；包含和跳过文件均记录 manifest 与 SHA-256。真实工作区变化会让旧结果 stale，应用 diff 前逐项确认。

Codex adapter 当前属于本地桌面能力，主机/网络隔离声明为 `unmanaged`。它的运行、测试和 diff 是操作审计，不是学习证据，也不会产生第四个主 Agent。

### 2.7 工程真实性与代码质量

已修复的高影响问题：

- 原“Sandboxed Code Executor”实际是宿主机进程：改为策略门控，生产默认失败关闭。
- URL/Git 来源可触达内网、本地仓库或携带凭据：增加协议、DNS、重定向、GitHub 根 URL、预算和秘密边界。
- 浏览器账号状态与模型 key 曾可跨账户复用：改为正式会话、账户作用域存储和服务端凭据解析。
- registry 曾只验证自身 schema，并把占位 workflow 当可用：增加 lifecycle、implementation binding 与实现校验。
- Human 临时状态曾可能丢失 scope：现在严格保留 learner/project/checkpoint/session。
- checkpoint session 并发创建可能违反唯一约束：增加 savepoint 竞争恢复和回归测试。
- seeded demo 曾依赖不安全通用执行：改为固定练习的 AST 合约判题，不执行学习者代码。

拆出的独立模块包括视觉规格、账号凭据、来源 locator、文件格式、Human 适配、Composer 能力选择器、代码纸张和执行策略。大型热点尚未全部拆完，见剩余风险。

## 3. 自动化与真实浏览器结果

### 3.1 后端

```text
cd backend
venv/bin/python -m pytest -q
363 passed, 21600 warnings in 48.11s
```

警告主要来自既有 `datetime.utcnow()`、Pydantic class config 和 Starlette TestClient 弃用提示；不是本轮失败，但应建立专项清理预算。

### 3.2 前端

```text
cd frontend
npm test
179 passed

npm run build
335 modules transformed; build passed
```

覆盖分布：search 23、learning 96、planning 6、profile 9、path 24、formal 10、auth/runtime 11。

### 3.3 Seeded demo 浏览器闭环

在真实浏览器中完成：

1. `/review` 自动登录 demo 账户。
2. 提交 starter code，确定性判题得到 `2/3`，进入纠错流程。
3. 修正代码后提交，得到 `3/3`，自动进入迁移变式。
4. 回答变式 `25.0`，任务通过，复习进入明日队列。
5. 页面显示 proficiency 69、transfer 75、误解已纠正、有效启发与独立成功记录。
6. 浏览器 console：0 error、0 warning。
7. 数据库 Attempt 记录 execution policy 为 `deterministic_seeded_ast_contract`；EvidenceEvent provenance 为 `seeded_safe_average_ast_v1` 且 `execution_performed=0`。

该闭环在无 LLM、无网络、无学习者代码执行的条件下完成。

### 3.4 机械检查

```text
git diff --check
passed

GET /api/architecture/validate
schema_valid=true
implementation_valid=true
valid=true
```

### 3.5 常规服务重启冒烟

- `bash start.sh stop` 后重新执行 `bash start.sh`，后端 `8010`、前端 `4174` 均就绪。
- 实际浏览器打开 `/`，正确进入账号登录门；`GET /api/auth/status` 返回 `200`。
- 页面标题与登录/注册控件可访问，console 为 0 error、0 warning。

## 4. 上线前仍需解决的风险

以下未被包装成“已完成”：

1. 通用代码执行在生产环境不可用。要上线项目级代码练习，需要 Firecracker、gVisor 或等价远程沙箱，具备网络、文件、进程、资源、秘密和镜像隔离；不能仅打开 `trusted_local_process`。
2. 来源 URL 在解析与连接之间仍存在 DNS rebinding 的 TOCTOU 窗口。当前每次跳转都重验 DNS，Git 来源限定 GitHub，但正式抓取器还应绑定已验证 peer IP 或经过受控 egress proxy。
3. 账户 API Key 使用单一 KEK，尚未实现 KMS/HSM、key version、轮换和双读迁移。
4. Tutor provider 调用仍有“外部副作用完成、最终状态尚未持久化”崩溃窗口。数据写入有幂等 ID，但无法保证供应商计费 exactly-once。
5. 部分浏览器本地学习状态在正式服务同步失败时仍可能先行推进；应改成 server-first transition 或增加可见的 pending/reconciliation 状态。
6. 本地 Agent Broker 是桌面工具，不是多租户生产执行环境；主机与网络权限仍是 `unmanaged`。
7. Human 暂停/恢复、冲突请求确认和长期偏好知情升级尚未实现；语音、表情和行为轨迹刻意不推断。
8. 文件系统暂不支持扫描 PDF OCR、旧 `.doc/.ppt/.xls`、压缩包或宏文档；多文件代码可编辑但不能正式提交。
9. 代码纸张没有 LSP、语义诊断和项目依赖图。
10. 旧 `ProcessAnimation` 表达仍有迁移债务；应在 VisualSpec v1 使用量归零后删除。
11. `tutor_service.py`、`main.tsx`、`architecture_registry.py` 和解析器仍是大型热点。此次已抽离高风险职责，但继续拆分前应先稳定跨模块契约与回归测试，避免机械重写。
12. 测试警告数量过高，会掩盖新警告；应单独治理弃用 API，而不是关闭 warning。

## 5. 发布判定

可以发布为本地/受控试用版本；账号与账户级凭据具备正式上线底座，但在公网多租户上线前必须完成部署秘密、HTTPS Secure Cookie、KMS 轮换、受控 egress 和真正代码沙箱。所有标为未实现或不可用的能力都会失败关闭，不会返回伪成功，也不会生成学习证据。
