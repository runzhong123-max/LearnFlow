# 知行课径桌宠（Desktop Pet）迁移方案：LearnFlow-pet → all

> 文档状态：**方案稿（待评审，尚未对 all 仓库做任何代码改动）**
>
> 迁移方向：源 = `d:\jbgs\LearnFlow-pet`（下面简称 **LF**）；目标 = `d:\jbgs\all`（下面简称 **all**）
>
> 基线：源 LF 工作区 `HEAD d8607a5`（含未提交/未跟踪的在途改动）；目标 all `HEAD 7e53808`（git clean）。目标仓库 **当前不含任何桌宠代码**（已全仓确认）。
>
> 日期：2026-09-02

---

## 1. 背景与目标

**桌宠是什么**：它是 `tutor_agent` 的一个轻量桌面入口，不是第四类主 Agent。在 LF 中的实现形态为——

- **一个独立置顶、无边框、透明、可贴边的小窗**：Tauri WebView，窗口 label `pet`，与主窗口（label `main`）共享同一份 `index.html`；前端按窗口 label 分流渲染 `<DesktopPet/>` 或正式 `<AuthGate>…</AuthGate>` 应用。
- **后端"桌宠网关"**：短效 opaque capability（令牌前缀 `lfpet_`，TTL 10 分钟，绑定 `AuthSession`/auth_epoch/learner）访问正式对象（AgentSession / LearningTask / LearningSkillRun / ReviewSchedule / Learning Files），并把用户主动确认的临时上下文（文字/图片视觉观察/文档摘录/视频字幕）以 `context_refs` 方式只随一个 Tutor 回合消费。不新建消息表、不写五核/EvidenceEvent。
- **Tauri OS 层**：托盘、全局快捷键（`Ctrl+Alt+P`）、单实例、关闭即隐藏、主窗↔pet 导航 request/ack 等，全部在 Rust `desktop/src-tauri/src/lib.rs`。

**迁移目标**：把这套能力完整移植进 all，使其跑在 all 当前的架构（FastAPI + SQLAlchemy async + SQLite + Vite/React 扁平结构 + Tauri 2 单窗壳）之上。

**非目标**（沿用 LF 约束，迁移不得破坏）：
- 不新增第四类主 Agent、不建立第二套聊天/学习状态。
- 不直接写 `KernelState` / Memory Graph / 长期画像；临时上下文、观察、导航均无 kernel target。
- 不改变 all 已有的 role-package / graph-hub / plugin 工作与既有认证流。

---

## 2. 源端（LF）现状与迁移基线风险

### 2.1 LF 工作区并非"干净提交"

| 状态 | 说明 |
| --- | --- |
| 已提交 | `d8607a5 … 4d46154` 一串 pet 提交（桌宠全链路），HEAD 为 detached `d8607a5` |
| **未提交修改** | `pet.py`、`desktop_pet_context.py`、`desktop_pet_vision.py`、`auth.py`(scope 映射)、`tutor_service.py`(字幕时间窗说明)、`DesktopPet.tsx`(+约 326 行)、`DesktopPet.module.css`、`test_desktop_pet_vision.py`(+89 行)、`backend/requirements-build`、docs 等 |
| **未跟踪文件** | `frontend/src/desktop-pet-subtitles.ts` + `frontend/server/desktop-pet-subtitles.test.ts`、`backend/tests/test_desktop_pet_source_ref.py`、若干 docs/代码生成产物 |

在途改动集中在三块**新特性**：**字幕导入（source_ref）**、**选区 OCR 转录（`/pet/selection-text`）**、**dock/贴边动画**。其特点是前后端用**常量字符串软对齐**（`SOURCE_REF_VERSION = "desktop_pet_source_ref.v1"`、`MAX_SUBTITLE_CUE_RECEIPTS = 256` 前后端各写一份），且测试尚未全覆盖、Rust `lib.rs` 含大量 `eprintln!("[dock] …")` 调试残留。

> ⚠️ **迁移基线的第一步必须是"定格源"**：先把 LF 工作区快照到一个独立分支/补丁文件，避免迁移过程中源再变。建议波次策略见 **§7 决策 D1**。

### 2.2 桌宠文件全览（LF 视角）

**A 类：新增/专属文件**（大部分可直接拷贝，部分 import 图带共享依赖）

| 文件 | 行数 | 角色 | 自包含？ |
| --- | --- | --- | --- |
| `frontend/src/DesktopPet.tsx` | ~1134 | pet 窗口根组件（compact/chat、发回合、图片/字幕、复习提醒、Tauri 调用、事件监听） | 依赖 `formal-runtime.ts`/`runtime-client.ts`/`desktop-pet-subtitles.ts`/`PetAvatar`/Markdown/lazy 等 |
| `frontend/src/DesktopPet.module.css` | ~111 | pet 样式 | 依赖 className 约定 |
| `frontend/src/PetAvatar.tsx` | 43 | SVG 猫头像 + 状态点 | ✅（React + 内联 SVG） |
| `frontend/src/PetAvatar.module.css` | 25 | 头像样式 | ✅ |
| `frontend/src/desktop-pet-subtitles.ts` | 194 | **纯 TS** SRT/VTT/TXT 字幕解析器（无 DOM），与后端 Pydantic source_ref 同构 | ✅ |
| `frontend/server/desktop-pet-subtitles.test.ts` | 184 | `node:test` 单测 | ✅ |
| `backend/app/api/pet.py` | ~390 | `/api/pet/*` 全部端点（bootstrap / context-packages / selection-text） | 依赖 auth / desktop_pet_context / desktop_pet_vision / learning_tasks / review / file_formats |
| `backend/app/services/desktop_pet_context.py` | ~289 | 上下文包状态机（TTL、confirm、consume、source_ref 校验） | 依赖 models/database/errors |
| `backend/app/services/desktop_pet_vision.py` | ~248 | 图片规范化（EXIF/alpha/缩放/JPEG 重编码）+ 视觉观察/选区转录（AsyncOpenAI + PIL） | 依赖 config / auth(provider) / desktop_pet_context |
| `backend/tests/test_desktop_pet_vision.py` | ~236 | 后端视觉/上下文/幂等测试 | 随代码 |
| `backend/tests/test_desktop_pet_source_ref.py`（未跟踪） | ~370 | source_ref 严格校验 / 消费清空正文 / 零 EvidenceEvent | 随代码 |

**B 类：被改写的共享文件**（必须手工融合，见 §8 矩阵）

后端：`models/learning.py`、`db/database.py`、`core/config.py`、`.env.example`、`services/auth.py`、`api/auth.py`、`schemas/auth.py`、`api/agent.py`、`schemas/agent.py`、`services/tutor_service.py`、`services/architecture_registry.py`、`services/action_board.py`、`api/main.py`。
前端：`src/runtime-client.ts`、`src/formal-runtime.ts`、`src/main.tsx`、`package.json`。
Tauri：`src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`、`Cargo.toml`、`tauri.conf.json`、`scripts/build_sidecar.py`、`requirements-build.txt`、`desktop/package.json`。

---

## 3. 目标端（all）现状与已可复用抓手

| 抓手 | 位置 | 说明 |
| --- | --- | --- |
| **`client_turn_id` 幂等已全链落地** | `schemas/agent.py` `TutorTurnRequest`；`models/learning.py` `AgentMessage.idempotency_key`(唯一索引)；`tutor_service.process_turn`/`_turn_replay_message` | 桌宠回合幂等只差"用起来 + 加 context_refs" |
| **短命签名令牌模板** | `services/role_package_launch.py`（HMAC body+sig、TTL≤900s、secret 入 Settings） | `lfpet_` capability token 可照此模板再造 |
| **desktop bearer 底子** | `services/auth.valid_desktop_request`；`api/auth._account_view` 注入 `desktop_auth_token`；`schemas/auth.AuthenticatedAccountResponse.desktop_auth_token`；`runtime-client.captureRuntimeAuth`（sessionStorage `learnflow.desktop.auth-token`） | pet 桌面态鉴权的基础，但**第二个窗口不继承该 sessionStorage** |
| **正式对象 API 齐备** | `/api/learning-tasks`、`/api/review/summary`、`/api/learning-files`、`/api/agent/sessions`(+turns) | 桌宠要读的对象都现成 |
| **后端视觉 .env 配置** | `api/settings.py` `VISION_*` + `/settings/test-vision` | pet 视觉可对齐此通道（见决策 D3） |
| **字幕/时间轴基础** | `frontend/server/learning-video-harness.ts`（`VideoTranscriptSegment`） | 仅参考；pet 需自己的轻量解析器 |
| **架构注册中心** | `services/architecture_registry.py` + `api/architecture/{registry,validate}` + digest 测试 | 登记桌宠 Workbench/Tool/Capability 的唯一入口；改动必同步测试 |

**all 的缺口**（迁移要补）：
1. **无第二个窗口**：`tauri.conf.json` 只有单窗 `main`；`capabilities/default.json` 只对 `["main"]` 授权 `core:default + dialog:allow-open`；`desktop/src-tauri/src/lib.rs` 仅 101 行（`desktop_runtime_config` + sidecar 启动）。
2. **无 `context_refs`**：`TutorTurnRequest` 只有 `client_turn_id`，没有上下文引用字段——这是真正的新增点。
3. **无 `lfpet_` capability 管道**：现只有 desktop bearer；pet 短命能力令牌需新建。
4. **跨窗口凭据传播**：desktop bearer 存 sessionStorage，逐窗口隔离；pet 窗需独立的 capability 令牌 + header 注入机制。
5. **Tutor 双通道**：web 走 vite/Node 代理（每账户加密凭证）；desktop 走后端 .env provider。pet 驻留 desktop → 走后端通道，需确认后端 provider 可配。

---

## 4. 关键架构差异 → 适配决策（开放决策点）

> 以下 D1–D6 需要你在动手前拍板。每项都给了推荐默认，可在评审时直接采纳或调整。

### D1 — 迁移基线 & 波次（推荐：两波）
- **波次一（推荐先做）**：以 LF **已提交的 `d8607a5`** 为准迁移桌宠主链路（窗口 + 后端 capability/context + tutor context_refs + 视觉观察 + 导航）。不含在途的三块新特性。
- **波次二（可选）**：字幕 source_ref + 选区 OCR 转录 + dock/贴边动画，从 LF **当前工作区**取。因为它们是未提交、前后端软对齐、测试不全，故后置并单独评审。
- 无论选哪波，先把 LF 工作区 `git add -A && git commit`（或导出 patch）定格一份快照，防止源漂移。

### D2 — pet 鉴权形态（推荐：照 `role_package_launch` 模板新建 `lfpet_` capability）
- LF 的做法：9 项 scope（pet.bootstrap.read / session.read / tutor.turn / task.read / task.control / skill.control / review.read / file.read / context.write），DB 存 token hash，绑定 auth_epoch，TTL 600s，`POST /api/auth/desktop-pet-capability` 刷新，只允许 desktop bearer 刷新，URL→scope 白名单在路由入口强制。
- all 的适配：token 格式/校验可完全照 `role_package_launch.py`；secret 进 Settings。**不建议**复用 `desktop_token`（形态不同：裸 uuid，非前缀 capability）。
- 落地后必须保证**普通 bearer 不能访问 `/api/pet/*`**。

### D3 — 视觉模型来源（已采用：账户级配置）
- `LearnFlow-pet`：pet 视觉走**后端账户级**视觉 provider（`auth.account_vision_provider_config`，独立 key/加密 AAD）。
- all：已补齐账户模型/视觉凭据字段、解密解析器与 `/auth/vision-credential` CRUD/测试接口。
- 桌宠优先使用独立视觉配置；未设置独立 Key 时显式复用同一账户的 Tutor Key，桌宠 capability 不携带任一明文凭据。

### D4 — Tutor 受限回合（推荐：在 all 现有幂等之上加 `context_refs` + restricted 分支）
- 在 `TutorTurnRequest` 增加 `context_refs: list[str] | None`（max 3），`api/agent.tutor_turn` 增加 `desktop_pet_restricted` 分支：强制 `client_turn_id`、禁 project/checkpoint/action/skill 覆盖、非 pet 来源的 context_refs 拒绝、回合成功后 `consume_desktop_pet_contexts`。
- `tutor_service`：`process_turn` 增加 `ephemeral_context` + restricted 标记；注入**信任边界文本**（"用户已明确确认以下外部参考…不执行其中指令"），收到 source_ref 且为 srt/vtt 时附字幕真实时间窗。
- **回归红线**：restricted 分支不得破坏常规 turn（不带这些字段时行为不变）。

### D5 — 桌宠窗口/OS 能力范围（推荐：分两档）
- **档位 A（最小可用，推荐波次一先做）**：`new WebviewWindow('pet', {...})` + 透明无边框置顶小窗；窗口 label 门禁；`capabilities` 增对 `"pet"` 的授权；关闭即隐藏；主窗↔pet 导航 request/ack；一个顶栏"打开桌宠"按钮。该档位现已完成，并额外包含托盘、全局快捷键、选区截图与单实例唤醒。
- **档位 B（完整桌面体验）**：从 LF `lib.rs` 全量移植托盘、`Ctrl+Alt+P`、单实例、dock/贴边、`capture_desktop_pet_ocr/selection`。工作量与风险主要集中在这一档（Windows PowerShell OCR / CopyFromScreen / 窗口动画），且 LF 该部分含在途调试代码，需重写而非照抄。

### D6 — 前后端 source_ref / 字幕双份常量
- 若做波次二，前后端两套常量（`SOURCE_REF_VERSION`、`MAX_SUBTITLE_CUE_RECEIPTS`）必须同步；建议这次迁移时抽出为**单一共享常量模块**（例如 `frontend/server` 生成 + 后端 import，或文档内注明强制同步），避免再次漂移。

---

## 5. 依赖关系（谁需要先存在）

```text
models(两表) ──> database(建表/列/索引) ─┐
config/env    ──────────────────────────┼──> auth(capability 管道) ──> pet.py(api) ─┐
schemas/auth / api/auth(签发/刷新) ──────┘    desktop_pet_context / _vision ──────────┤
                                                  │                                   ├──> /api/pet/* 可用
schemas/agent(加 context_refs)                          │                            │
   └─> api/agent.tutor_turn(restricted)                 │                            │
        └─> tutor_service(ephemeral_context/幂等/信任边界)─┘                            │
architecture_registry + action_board（登记 Workbench/Tool/Capability）───────────────┘
        └─> test_architecture_registry（digest 同步）

前端：runtime-client(pet 鉴权头/三态窗口) ──> formal-runtime(pet 端点函数)
        └─> main.tsx(openDesktopPet / 事件桥 / mount 分流 / 顶栏)
              └─> DesktopPet/PetAvatar/subtitles ──> 发 turn
Tauri：capabilities(default.json) + lib.rs(窗口/托盘/命令) + Cargo/tauri.conf/build_sidecar
```

**关键顺序**：后端数据→认证→pet 服务/API→tutor 扩展→registry→前端 runtime/formal→窗口 UI→Tauri 层。前面的缺口（context_refs、capability）不补齐，后面无法跑通。

---

## 6. 分阶段迁移步骤

### Phase 0 — 准备与定格源（半天）
1. LF：在 `d:\jbgs\LearnFlow-pet` 把工作区在途改动定格（建议新分支 `snapshot/pet-worktree` 提交，或 `git diff > pet-worktree.patch` + 未跟踪文件打包）。
2. 全仓确认 all 无 pet（已确认）。在 all 建迁移分支：`git checkout -b feat/desktop-pet-migration`。
3. 统一行尾策略：LF 多个文件 CRLF，diff 时先 `tr -d '\r'`；迁移文件建议落盘为 LF（与 all 现状一致）。
4. 建立"迁移核对清单"（本文件 §8 矩阵勾选），逐文件过。

### Phase 1 — 后端数据模型与配置
- `backend/app/models/learning.py`：新增 `DesktopPetCapability`、`DesktopPetContextPackage`（表 `desktop_pet_capabilities` / `desktop_pet_context_packages`），照 LF（token_hash 唯一、scopes JSON、auth_epoch、expires_at、revoked_at；client_context_id 160、kind/status/content/sha/source JSON、confirmed/consumed/consumed_by_turn_id、expires_at）。注意 JSON 默认写法、索引名与 all 现有模型查重。
- `backend/app/db/database.py`：`Base.metadata.create_all` 自动建新表（依赖 model import 链在 `from app.models import ...`）；存量表若需 `client_context_id` 补列则登记进 `EXTRA_COLUMNS`；新增部分唯一索引 `(learner_id, client_context_id) WHERE client_context_id IS NOT NULL`（索引名需唯一）；在 `init_db()` 加 `_mark_*_migration()` 占位（建 SchemaMigration 行）——all 用 v1..v20 迁移版本机制，需给两张新表登记迁移版本。
- `backend/app/core/config.py` + `.env.example`：LF 用 `desktop_mode`/`desktop_token`（all **已有**，勿重复加）；新增 capability secret/过期窗口等键（建议 `desktop_pet_capability_secret`、`desktop_pet_capability_ttl_seconds=600`）。`LEARNFLOW_SETTINGS_PATH`/桌面覆盖逻辑沿用 all 现有。
- ✅ 验证：后端可启动、`init_db` 建出两张新表（`sqlite3 … .tables` 或日志）。

### Phase 2 — 认证 capability 管道 + pet 服务/API
- `backend/app/services/auth.py`：照 LF 增 `DESKTOP_PET_CAPABILITY_SCOPES`（9 项）、`issue_desktop_pet_capability`（`lfpet_{secrets.token_urlsafe(32)}`）、`require_desktop_pet_capability(current, scope)`、`_required_desktop_pet_scope(request)`（URL→scope 白名单）、`current_learner_from_request` 的 capability join 分支、`CurrentLearner` 字段、守卫链 desktop/capability 旁路。**all 现有 CurrentLearner/依赖体系较 LF 已有差异，先对齐其枚举/字段再移植，勿整体覆盖 `auth.py`。**
- `schemas/auth.py` / `api/auth.py`：登录/注册/会话/dev/demo 签发点在 `valid_desktop_request` 时附加 `desktop_pet_capability_token`（all 已有 `desktop_auth_token` 注入模式可照抄）；新增 `POST /api/auth/desktop-pet-capability` 刷新（仅 desktop bearer）。
- 拷贝 `services/desktop_pet_context.py`、`services/desktop_pet_vision.py`、`api/pet.py` → 在 `backend/app/api/main.py` 注册 `include_router(pet_router, prefix="/api")`。
- **视觉 provider 按 D3 决策改写** `desktop_pet_vision.py` 的 provider 解析（LF 账户级 → all `.env vision_*`）。
- ✅ 验证：迁移后端测试（见 §9）通过；普通 bearer 打 `/api/pet/bootstrap` 应被拒。

### Phase 3 — Tutor 受限回合（context_refs）
- `schemas/agent.py` `TutorTurnRequest`：加 `context_refs: list[str] | None = None`（max 3）。
- `api/agent.py` `tutor_turn`（all 约行 802）：加 `desktop_pet_restricted` 分支（照 LF），成功后 `consume_desktop_pet_contexts`。
- `services/tutor_service.py`：`process_turn` 增 `ephemeral_context`/`desktop_pet_restricted`；幂等已具备（`idempotency_key`）；注入信任边界文本 + 字幕时间窗说明（D6 常量同步）。
- ✅ 验证：不带新字段的常规 turn 回归全绿（`test_tutor`、`agent-runtime`）；带 context_refs 的受限 turn 行为正确（LF 两个 pet 后端测试可移植对拍）。

### Phase 4 — 架构登记
- `services/architecture_registry.py`：登记 `ToolContract desktop_pet_gateway / desktop_pet_vision_observer`、`WorkbenchContract desktop_pet(Desktop Pet Companion, tauri://pet)`，capabilities `desktop_pet_companion / task_control / main_navigation / context_attachment`；`CAPABILITY_OWNERS` 与 `action_board.py` 的 ActionDefinition **成对**登记；`IMPLEMENTATION_BINDINGS` 补 api:/workbench: 绑定（会校验前端符号存在 → 前端 Phase 6 完成前 registry validate 会红，属预期，按阶段推进即可）。
- 同步改 `backend/tests/test_architecture_registry.py`：digest 复算 / `REGISTRY_VERSION` / 不变式（**all 断言 `set(ACTION_BOARD)==set(CAPABILITY_OWNERS)` 必须成对**）。
- ✅ 验证：`/api/architecture/validate` 返回空错误列表。

### Phase 5 — 前端 runtime / formal / tutor payload
- `frontend/src/runtime-client.ts`：增 `isDesktopPetWindow()` 判定与桌面 token/capability header 注入；pet 窗的 Authorization 用其独立 capability；沿用 all 的 `runtimeFetch`/事件机制。**跨窗传播按 D2/D5 设计。**
- `frontend/src/formal-runtime.ts`：增 pet 端点函数与类型（bootstrap/context/image/confirm/delete/refresh capability/selection-text，若做波次二），照 LF 段落插入、复用 `jsonRequest/formRequest`。
- `frontend/src/tutor.ts`：desktop 分支 payload 在需要时扩展 context_refs（默认 pet 自己直连 turn 端点，tutor.ts 主要给主窗用，注意别破坏现有纯文本 payload）。

### Phase 6 — 前端窗口与 UI
- 拷贝 `DesktopPet.tsx/.module.css`、`PetAvatar.tsx/.module.css`（+波次二 `desktop-pet-subtitles.ts` 与其 test）。
- `frontend/src/main.tsx`（all 3693 行，改动最密集，**逐个 diff 核对**）：
  - import DesktopPet + `openDesktopPet()`（含 `WebviewWindow('pet', {…360×520, decorations:false, transparent, alwaysOnTop…})`，先 `refreshFormalDesktopPetCapability`）。
  - mount 尾部分流：`initializeRuntimeClient().then(...)` 处按窗口 label 渲染 `<DesktopPet/>` 或原 `<AuthGate>`。
  - 事件桥：`learnflow:desktop-pet-navigate`（主窗监听→tab 定位→`navigation-ack`）、`pet-identity-updated/cleared`、session 同步、8 分钟 capability 刷新、顶栏"打开桌宠"按钮。
  - 导航目标需映射到 all 的 pathname→tab 路由（`tabFromCurrentPath`/`pathForTab`）。
- `frontend/package.json`：把 `server/desktop-pet-subtitles.test.ts` 加进 `test:*` 脚本。
- ✅ 验证：`tsc -b`、前端相关 `test:*`；`formal-runtime.test.ts` 的"image-only fallback message"字符串断言随源码同步移植。

### Phase 7 — Tauri OS 层（档位 A 或 A+B）
- `capabilities/default.json`：windows 加 `"pet"`；补权限（`core:webview:allow-create-webview-window`、set-size/focus/show、notification 若做复习提醒、`http:allow-fetch` 到 loopback 等）。
- `src-tauri/tauri.conf.json`：CSP `connect-src` 若需覆盖 pet 窗来源；`lib.rs`：档位 A 只需 `WebviewWindow` 由前端运行时创建 + 少量窗口命令；档位 B 从 LF `lib.rs`(1390 行) 移植托盘/快捷键/单实例/dock/OCR/selection 命令——**建议重写式移植**（LF 版有在途调试残留），并保持现有 `desktop_runtime_config` 契约不变（主窗依赖它）。
- `Cargo.toml`：追加依赖（tray-icon、notification 插件、windows-sys 等，仅档位 B）。
- `desktop/scripts/build_sidecar.py`：确认 `add-data plugins/dist`（all 若已有插件 dist）与 `backend/desktop_entry.py` 入口在 all 存在。
- ✅ 验证：`npm run build`(desktop)、`cargo check`；手动开 pet 窗、隐藏、主窗导航回执。

### Phase 8 — 端到端验证与回归
见 §9 清单。核心演示链路：登录 → 主窗进入正式 Session → 打开桌宠 → 桌宠随 Session scope → 提问/带图片/带字幕 → 回答后主窗可定位讲义/关卡 → 关闭只隐藏 → 重启不裂。

---

## 7. 开放决策点汇总（请在动手前逐项拍板）

| # | 决策 | 推荐默认 | 影响面 |
| --- | --- | --- | --- |
| D1 | 迁移基线/波次 | 波次一 = LF `d8607a5` 已提交主链路；波次二 = 字幕/选区 OCR/dock 后置 | 几乎全部 Phase |
| D2 | pet 鉴权形态 | 照 `role_package_launch` 模板新建 `lfpet_` capability | Phase 2 |
| D3 | 视觉模型来源 | 当前账户级视觉配置；未设置独立 Key 时复用 Tutor Key | Phase 2 |
| D4 | tutor 受限回合 | 加 `context_refs` + restricted，回归红线：常规 turn 不变 | Phase 3 |
| D5 | 窗口/OS 能力档位 | 档位 A 最小可用先做，档位 B 后置 | Phase 6/7 |
| D6 | 前后端字幕常量 | 抽单一共享常量源，杜绝双份漂移 | 波次二 |

### 已定稿决议（2026-09-02）

| # | 结论 |
| --- | --- |
| D1 | **A**：波次一先迁 LF `d8607a5` 主链路；波次二在途特性（字幕 source_ref / 选区 OCR 转录 / dock 动画）后置 |
| D2 | **A**：照 `role_package_launch` 模板新建 `lfpet_` capability |
| D3 | **B**：pet 视觉走当前账户级配置，支持复用 Tutor Key |
| D4 | **A**：`context_refs` + restricted 受限回合 |
| D5 | **档位 A + 全局快捷键**：最小 pet 窗先行，托盘/贴边后置；但 `Ctrl+Alt+P` 纳入波次一 → **选区抓取 + OCR/视觉转录这一小块从波次二提前**（字幕 source_ref 仍留波次二） |
| D6 | **A**：抽单一共享常量源（波次二前做） |

---

## 8. 逐文件迁移矩阵（执行核对清单）

### 8.1 表 A — 可直接拷贝的新增文件

| # | 源（LF） | 目标（all） | 说明/依赖 | 波次 |
| --- | --- | --- | --- | --- |
| A1 | `frontend/src/PetAvatar.tsx` + `PetAvatar.module.css` | 同路径 | 自包含 | 一 |
| A2 | `frontend/src/DesktopPet.module.css` | 同路径 | 自包含 | 一 |
| A3 | `frontend/src/DesktopPet.tsx` | 同路径 | 依赖 formal/runtime-client/subtitles/PetAvatar（其对应修改见 表B） | 一 |
| A4 | `backend/app/api/pet.py` | 同路径 | 依赖 auth/context/vision/… | 一 |
| A5 | `backend/app/services/desktop_pet_context.py` | 同路径 | 依赖 models/database/errors | 一 |
| A6 | `backend/app/services/desktop_pet_vision.py` | 同路径 | provider 解析按 D3 改写 | 一 |
| A7 | `backend/tests/test_desktop_pet_vision.py` | 同路径 | 需按 all 测试基建微调 | 一 |
| A8 | `frontend/src/desktop-pet-subtitles.ts` + `frontend/server/desktop-pet-subtitles.test.ts` | 同路径 | 自包含 | 二 |
| A9 | `backend/tests/test_desktop_pet_source_ref.py` | 同路径 | 需按 all 测试基建微调 | 二 |

### 8.2 表 B — 共享文件手工融合（在 all 文件里加"桌宠片段"）

| # | all 目标文件（当前规模） | 要融合进去的桌宠片段 | 冲突/注意 |
| --- | --- | --- | --- |
| B1 | `models/learning.py`（896 行） | 两个 pet 模型类 | JSON 默认/索引名查重 |
| B2 | `db/database.py`（1572 行） | 新表 create_all 依赖链、`EXTRA_COLUMNS`、部分唯一索引、迁移版本登记 | 用 all 的 v1..v20 机制，勿硬塞 |
| B3 | `core/config.py`（177 行） | capability secret/ttl 键 | `desktop_mode/desktop_token` all 已有，别重复 |
| B4 | `.env.example` | 对应注释键 | — |
| B5 | `services/auth.py`（879 行） | 9 scope / issue / require / URL→scope 白名单 / capability join / 守卫旁路 | **最大融合点**：对齐 all CurrentLearner 体系后移植，勿整文件覆盖 |
| B6 | `api/auth.py`（726 行） + `schemas/auth.py` | 签发附加 capability token + `POST /auth/desktop-pet-capability` | 复用 all `desktop_auth_token` 注入模式 |
| B7 | `schemas/agent.py`（220 行） | `context_refs` 字段 | 唯一新增点之一 |
| B8 | `api/agent.py`（1172 行） | `tutor_turn` restricted 分支 + consume | role-package 改动热点，diff 逐段核对 |
| B9 | `services/tutor_service.py`（3323 行） | process_turn 签名/ephemeral_context/restricted/信任边界注入 | **最大融合点/最高冲突风险** |
| B10 | `services/architecture_registry.py`（2403 行） | Tool/Workbench/Capability owners/bindings 登记 | 需**同步**改 B11 |
| B11 | `tests/test_architecture_registry.py`（648 行） | digest / REGISTRY_VERSION / `ACTION_BOARD==CAPABILITY_OWNERS` | 不改则 CI 红 |
| B12 | `services/action_board.py` | 4 个 ActionDefinition | 与 B10 成对 |
| B13 | `api/main.py`（110 行） | `include_router(pet_router, prefix="/api")` | 简单 |
| B14 | `frontend/src/runtime-client.ts`（261 行） | pet 窗判定 / capability header 注入 | 跨窗传播见 D2/D5 |
| B15 | `frontend/src/formal-runtime.ts`（1370 行） | pet 端点函数/类型/capability 刷新 | 复用 jsonRequest/formRequest |
| B16 | `frontend/src/tutor.ts`（658 行） | （如需）desktop payload context_refs | 主窗纯文本 payload 别破坏 |
| B17 | `frontend/src/main.tsx`（3693 行） | DesktopPet import/mount 分流/openDesktopPet/事件桥/顶栏/导航映射 | **改动最密集**；role-package/hub 近期大改此文件，冲突最高 |

### 8.3 表 C — 工程/配置/脚本

| # | 文件 | 改动 | 波次 |
| --- | --- | --- | --- |
| C1 | `desktop/src-tauri/capabilities/default.json` | windows 加 `"pet"` + 权限 | 一 |
| C2 | `desktop/src-tauri/tauri.conf.json` | CSP/（可选）窗口预声明 | 一 |
| C3 | `desktop/src-tauri/src/lib.rs`（all 101 行） | 档位 A：窗口/鉴权命令；档位 B：托盘/快捷键/OCR/贴边 | 一(A)/二(B) |
| C4 | `desktop/src-tauri/Cargo.toml` | 追加插件依赖 | 一(A)/二(B) |
| C5 | `desktop/scripts/build_sidecar.py` | 核对 `backend/desktop_entry.py`、add-data | 一 |
| C6 | `frontend/package.json` | test 脚本纳入字幕 test | 二 |
| C7 | `backend/requirements.txt` | 新增 `Pillow==11.3.0`（LF 已 pin；all 缺失）。**另需显式 pin `openai`**：LF 只是靠 `langchain-openai` 传递携带、未直接声明，迁移后 `from openai import AsyncOpenAI` 会脆弱，应显式加依赖 | 一 |

### 8.4 表 D — 参考文档（可选，非代码）

`LF/docs/implementation/DESKTOP_PET_COMPANION.md`（产品/接口规格）、`DESKTOP_PET_VISION_HANDOFF.md`、`docs/competition/DESKTOP_PET_*_PLAN.md`、`docs/design/desktop-pet/*`（概念图）。建议把前两者拷入 all/docs 作为功能规格，其余按需。

---

## 9. 验证清单

**后端**
- `backend/tests/test_desktop_pet_vision.py`、`test_desktop_pet_source_ref.py`（按 all 基建微调后）通过。
- 常规回归：`test_tutor.py`、`test_auth_production.py`、`test_architecture_registry.py`、conftest 既有用例全绿。
- `GET /api/architecture/validate` 无错误；`/api/demo/status`、seeded demo 回归不破（迁移不改证据链）。
- 手工：普通 bearer 调 `/api/pet/bootstrap` → 401/403；capability 过期/撤销后失效；`client_turn_id` 重试不重复建回合。

**前端**
- `tsc -b` 通过；`test:formal` 等含字幕/formal-runtime 行为对拍用例。
- 手工：主窗登录取 capability → 开 pet 窗（不闪、置顶、透明）→ scope 跟随正式 Session → 提问/图片/字幕（波次二）→ 换 Session 清空 outbox/临时上下文 → 关窗只隐藏、再开恢复。

**Tauri / 桌面**
- `cargo check`/`npm run build` 通过；sidecar 能起、端口随机、token 注入正确。
- 已完成：托盘显示/隐藏/退出、`Ctrl+Alt+P` 仅 pet 可见时抓取、第二实例唤醒第一实例、几何异常坐标回退。
- 波次二：OS 贴边 dock、紧凑视图动画与贴边恢复，以及字幕 `source_ref` 链路。

**架构红线**
- 全程无第四类 Agent、无第二套消息表、无对 KernelState/Memory Graph/EvidenceEvent 的直接写（pet 测试已含"零 EvidenceEvent/KernelMutation"断言，保留之）。

---

## 10. 已完成的分析依据（保留备查）

- LF 端桌宠实现勘察（本会话 Explore 报告）：文件逐一定位、共享文件改动点、在途/未跟踪清单、判别清单。
- all 端接入点勘察（本会话 Explore 报告）：后端 main/auth/db/config/agent/tutor_service/registry 现状、前端 main/runtime-client/formal-runtime/tutor 现状、Tauri 单窗壳差距、近期 role/hub/graph 改动热点文件。

> 执行迁移时，若某文件在 all 已有新改动与本节描述不符，以 all 实际代码为准并回填本表。

---

## 11. 波次一实施记录（2026-09-02）

分支 `feat/desktop-pet-migration`；源定格 LF `d8607a5` 已提交主链路 + snapshot `98cbc4d` 的选区抓取片段（D5 提前）。

### 11.1 已交付清单

**后端（已提交，68c90ed → a09864d）**
- 数据层 `models/learning.py`（pet 两表 + 序列）、`db/database.py`（建表/列/唯一索引/迁移登记）、`core/config.py`、`.env.example`（VISION_* 沿用 all 已有键）。
- 认证与 API：`services/auth.py`（capability 签发/校验/URL→scope 白名单）、`api/auth.py`（capability token 附加 + `POST /auth/desktop-pet-capability`）、`api/pet.py`（/pet/bootstrap、context-packages、/pet/selection-text）、`services/desktop_pet_context.py`、`services/desktop_pet_vision.py`（走 all 后端 VISION_*，D3）、`api/main.py` 挂载。
- 受限回合：`schemas/agent.py`（context_refs）、`api/agent.py`、`services/tutor_service.py`（restricted 分支 + consume；常规 turn 不改）。
- 架构登记：`architecture_registry.py`/`action_board.py` + 同步 `tests/test_architecture_registry.py`。

**前端（未提交）**
- `runtime-client.ts`、`formal-runtime.ts`、`main.tsx`（openDesktopPet/事件桥/mount 分流/顶栏按钮/`tabFromPath` 映射/session 同步/capability 周期刷新）。
- 新增 `DesktopPet.tsx`（= LF committed 882 行 + snapshot 选区抓取/OCR 转录链，剔除 dock/紧凑动画与 source_ref 字幕）、`DesktopPet.module.css`（committed 92 行 + selection 样式 6 行）、`PetAvatar.tsx` + `.module.css`。
- `package.json`：新增 `@tauri-apps/plugin-notification ^2.3.3`（复习提醒；Rust 侧同步注册）。

**Tauri / 桌面（未提交，Phase 7 agent 完成，cargo check 绿）**
- `src/lib.rs`（101 → ~815 行）：扩展 `DesktopRuntimeState`；保留原 sidecar env/`desktop_runtime_config` 契约与 ExitRequested 清理；注册 dialog+notification+shell；14 个命令齐全；pet 窗 `CloseRequested` → `prevent_close` + hide（发 `learnflow:desktop-pet-hidden`）；Ctrl+Alt+P 全局快捷键按持久化 `shortcut` 生效：pet 可见→选区抓取请求，否则→开 pet 请求。
- `capabilities/default.json`：windows 加 `"pet"`；补 `core:window:allow-*`/`core:webview:allow-create-webview-window`/`notification:default`；identifier 仍 `desktop-main`；不放 `http:` 权限（all 用 fetch）。
- `Cargo.toml`：`serde_json`、`tauri-plugin-notification 2.3.3`、windows-sys `0.61`（Win32 选区抓取相关）。
- `backend/requirements.txt`：显式 pin `openai==1.109.1`、`Pillow==12.3.0`（C7；见 11.3 偏差④）。

### 11.2 验证结果

| 层 | 结果 |
| --- | --- |
| 后端 | 全量 pytest：**382 passed**，9 failed 均为**中文 Windows 环境/与本迁移无关**（见 11.3 偏差⑥）。迁移关键子集全绿：architecture registry + pet vision 25、auth production + tutor 83。 |
| 前端 | `tsc -b` 0 错误；`npx vite build` 成功（含 DesktopPet 分包；仅既有 chunk>500kB 提示）。 |
| 桌面 | `cargo check` 0 错误 0 警告（需 `desktop/src-tauri/binaries/learnflow-backend-*.exe` 存在，当前为 gitignored 占位；打包前须跑 `build_sidecar.py`）。 |
| 手工 e2e | 本会话未执行（需先产真实 sidecar + GUI 运行）。详见 §11.4。 |

### 11.3 偏差与说明

1. **选区抓取提前（D5 已拍板）**：`capture_desktop_pet_selection` 及其前台窗口捕获链从 snapshot 移植进波次一；字幕 `source_ref`/`desktop-pet-subtitles.ts` 仍留波次二，未拷贝。
2. **安装壳补齐（2026-09-03）**：已移植托盘、单实例守卫和鼠标穿透恢复入口；第二次启动会唤醒首实例的主窗口并保留当前工作区。sidecar 现在获得独立的 `PLUGIN_ARTIFACT_DIR`，构建脚本只在仓库实际存在 `plugins/dist` 时才嵌入插件资源。`edgeAutoHide` 的 OS 贴边 dock、compact-dock 动画、`restore_desktop_pet_dock` 与 `set_desktop_pet_view`仍留波次二，不能把前端紧凑视图误称为 OS 自动贴边。
3. **B16 `tutor.ts` 未改**（文档标注"如需"）：pet 回合走后端 restricted 分支 + `context_refs`，主窗纯文本 payload 未触碰。
4. **C7 版本偏差**：文档建议 `Pillow==11.3.0`（LF pin）；all 环境实测已解析 `Pillow==12.3.0` 且全量回归绿，故按实测版本显式 pin（`openai==1.109.1`、`Pillow==12.3.0`），避免无谓降级。
5. **C2 `tauri.conf.json` 未改**：现有 CSP/单窗口配置已覆盖 pet（同源共享 index.html；pet 窗由前端 `WebviewWindow('pet',…)` 运行时创建）。
6. **9 项既有后端失败与迁移无关**：涉及 `code_executor`(进程组 kill)、`local_agent_broker`/`source_boundaries`/`workspace`/`user_isolation`（symlink 特权 WinError 1314、非法文件名 `?` WinError 123、settings GBK 解码）等文件均与 `main` **字节一致**，属本机环境（无 Developer Mode symlink 特权 + 中文 locale），CI 上应复核。
7. **前端已装但未提交**：`DesktopPet/PetAvatar` 四个文件与三个共享文件改动尚未 commit；`Cargo.lock` 已随 cargo 更新。

### 11.4 波次一遗留手工验证（需真实 sidecar + GUI）

登录 → 主窗进入正式 Session → 开 pet → scope 跟随 → 提问/带图/`Ctrl+Alt+P` 选区抓取 → 回答后主窗定位 → 关窗仅隐藏、再开恢复。执行前置：`desktop/scripts/build_sidecar.py` 产出真实 sidecar，再 `cargo build`/`npm run build`。

### 11.5 波次二待办（未动）

`desktop-pet-subtitles.ts` + 时间轴 source_ref UI/服务端、字幕 test（C6 脚本挂载）、`test_desktop_pet_source_ref.py`、dock/紧凑动画与 OS 贴边。
