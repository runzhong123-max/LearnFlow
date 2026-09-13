# LearnFlow 项目对接文档

版本：`project-integration/v1`
适用项目：云存储技术学习项目
维护范围：Web、Desktop 与共享 `learning-core`

## 1. 对接目标

本项目将“块文件对象存储的区别与场景选择”拆成可验证的学习任务，并通过项目来源、来源基线、讲义和练习形成一条可重建链路：

```text
项目来源 -> 来源版本 -> 来源基线 -> 学习任务 -> 领域知识包 -> 讲义/练习
```

项目来源只提供可追溯材料，不直接写入学习者五核状态。讲义和练习的生成属于 Learning Design 产物；正式练习提交仍由 Practice Agent 判定。

## 2. 项目边界

### 学习目标

- 区分对象存储、块存储和文件存储的数据模型与访问方式。
- 根据延迟、吞吐量、共享方式、扩展性、成本和运维边界选择存储模型。
- 能说明副本、纠删码、故障域、持久性、可用性和一致性的关系。
- 能设计分片上传、断点续传、幂等、权限、加密和恢复方案。

### 不在本项目范围

- 不把生成的讲义或一次答对当作掌握证据。
- 不把本地 Markdown 内的引用链接自动升级为权威来源。
- 不把桌面本地文件、Web 云端项目和数据库混合迁移。
- 不由模型直接决定评分、通过条件或五核长期状态。

## 3. 来源接入

### 推荐来源

至少保留一份独立的官方来源，并将其作为项目基线候选：

- AWS Storage Overview：`https://docs.aws.amazon.com/whitepapers/latest/aws-overview/storage-services.html`
- Amazon S3 User Guide：`https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html`
- Google Cloud Storage：`https://cloud.google.com/storage/docs`
- Azure Storage Introduction：`https://learn.microsoft.com/azure/storage/common/storage-introduction`

本地课程资料可作为学习者语境和考试框架，例如 `云存储技术-期末考试主题资料.md`。它可以补充定义、例子和练习，但不替代独立官方来源。

### Web 操作流程

1. 在项目的“学习材料”中添加官方 URL。
2. 等待来源状态变为 `processed`，确认版本状态为 `active`。
3. 上传或处理本地 Markdown 资料。
4. 点击“生成基线”或“重新核验”。
5. 确认候选覆盖率为 100%，且缺口为空。
6. 点击“确认作为项目基线”，将当前 `SourceVersion` 固定。

只有已确认的项目基线会被 Tutor、路线和学习文件共同消费。来源内容变更后必须重新处理并生成新的版本，不能直接修改上传目录中的文件来替代版本更新。

## 4. 关键 API

以下路径以 `/api` 为前缀，Web 与 Desktop 使用同一共享契约；认证、数据库和本地文件权限仍由宿主负责。

| 用途 | 方法与路径 |
|---|---|
| 添加 URL 来源 | `POST /knowledge-library/sources/url` |
| 上传本地来源 | `POST /knowledge-library/sources/upload` |
| 处理来源 | `POST /knowledge-library/sources/{source_id}/process` |
| 读取项目来源 | `GET /vnext-projects/{project_id}/sources` |
| 生成基线候选 | `POST /vnext-projects/{project_id}/knowledge-baseline/proposals` |
| 确认项目基线 | `POST /vnext-projects/{project_id}/knowledge-baseline/{packet_id}/confirm` |
| 查看项目基线 | `GET /vnext-projects/{project_id}/knowledge-baseline` |
| 生成讲义与练习 | `POST /learning-files/tasks/{task_id}/generate` |
| 查看讲义 | `GET /learning-files/lecture/{lecture_id}` |

生成讲义与练习时，客户端应携带当前任务版本 `expected_version` 和幂等用的 `client_request_id`。重复请求不得重复创建产物或重复计分。

## 5. 基线门禁

项目基线使用 `project_baseline` 领域知识包，至少检查以下 facet：

- `scope`：项目范围和目标。
- `prerequisites`：前置知识与依赖。
- `canonical_sources`：可追溯的官方、学术或已登记规范来源。
- `risks`：可靠性、安全、成本或失败边界。
- `example` 或 `implementation`：与项目类型匹配的示例/实现材料。

讲义与练习使用 `teaching_artifact` 知识包，除定义、机制、例子和边界外，还要求误区与可验证依据。`misconception` 可以由带有明确 facet 的标题概念或正文断言提供，但必须有来源 provenance。

如果界面显示“候选覆盖 80% / 缺口：`canonical_sources`”，应检查官方 URL 是否成功处理、是否为 `active` 版本，以及是否重新生成了基线候选。若界面仍显示旧结果，应刷新项目页面并重新发起 proposal，而不是重复上传相同文件。

## 6. 讲义与练习生成链路

```text
LearningTask
  -> compile_domain_knowledge_packet(kind=teaching_artifact)
  -> coverage / provenance / freshness audit
  -> deterministic readiness gate
  -> Lecture + ConceptQuestion + Exercise
  -> artifact_refs 写回 LearningTask
```

生成失败时，接口应返回结构化状态和缺口；不能静默跳转到空白讲义页面。生成、打开和阅读产物不会直接改变五核；正式练习提交才进入 Attempt、EvidenceEvent 和确定性评分链。

## 7. 桌面端启动与验收

从仓库根目录启动当前版本：

```powershell
cd D:\jbgs\LearnFlow
npm run dev:desktop
```

桌面开发前端默认使用 `http://localhost:4175`，桌面 sidecar 使用随机 loopback 端口。不要同时运行旧副本、Demo 实例和当前仓库的桌面开发实例。

最小验收顺序：

1. 打开项目并确认来源均为 `processed / active`。
2. 生成并确认项目基线，覆盖率达到 100%。
3. 打开目标学习任务，点击“生成讲义和练习”。
4. 确认任务版本递增且 `artifact_refs` 不为空。
5. 打开讲义，确认包含三种存储模型、场景取舍和至少一个边界/误区。
6. 打开练习，确认题目有来源依据，提交后再检查评分与反馈。

## 8. 故障排查

### 仍显示缺少权威来源

检查官方 URL 的 `SourceVersion.authority_tier` 是否为 `official`、状态是否为 `active`，然后重新生成基线候选。项目基线未确认前，任务级生成会继续使用旧的或不完整的项目包。

### 仍显示缺少主题资料

检查任务级知识包，而不是只看项目级基线。任务级包可能缺少 `definition`、`misconception` 或 `assessment_basis`；需要在当前任务引用的来源中补充对应段落，并重新生成任务文件。

### 点击后无反应

先确认按钮没有处于 busy 状态，再查看请求是否到达 `/learning-files/tasks/{task_id}/generate`。如果请求到达但没有产物，检查返回的 `domain_knowledge_status`、`domain_knowledge_gaps` 和任务 `expected_version`；如果请求未发出，重启当前仓库的桌面端并确认窗口路径位于 `D:\jbgs\LearnFlow`。

### Tauri 启动时报“拒绝访问”

关闭旧的 `learnflow-desktop.exe`、`learnflow-backend.exe` 和占用 `4175` 的旧 Vite 进程，再重新执行 `npm run dev:desktop`。不要结束 Codex 自身的 Node 进程。

## 9. 版本与责任

- 共享领域知识、来源版本和覆盖规则：`packages/learning-core/`。
- Web 后端宿主：`backend/`。
- Desktop 后端与 sidecar：`apps/desktop/backend/`、`apps/desktop/desktop/`。
- Desktop UI：`apps/desktop/frontend/`。
- 架构和跨端约束：`docs/ARCHITECTURE_AUTHORITY.md`、`docs/MONOREPO.md`。

涉及来源基线、领域知识包或讲义生成契约的修改，必须同步 Web/Desktop 实现与测试，并在提交说明中记录 `Contract impact`。来源、讲义和练习均不应包含密钥、Cookie、真实数据库或其他本地运行数据。
