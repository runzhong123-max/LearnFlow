# LearnFlow 项目交接文档

> 更新时间：2026-09-04（Asia/Shanghai）
> 适用仓库：`D:\jbgs\all`
> 当前分支：`feat/desktop-pet-migration`
> 当前 HEAD：`0a9070c`
> 发布远程：`https://github.com/killoppen/edagent.git`

本文以生成时的真实工作树、已提交历史和最近验证结果为准。桌宠已经迁移进桌面端主链路；当前工作树仍有用户/本轮未提交改动，接手时必须先审阅 `git status -sb` 和 `git diff`，不得重置或覆盖这些改动。

## 1. 项目概览

LearnFlow 是面向计算机学习的 Tutor 工作空间，包含：

- FastAPI + SQLAlchemy async + SQLite 后端；
- React + Vite + TypeScript 前端；
- Tauri 2 桌面壳；
- 本地 FastAPI sidecar，桌面端启动时绑定随机 loopback 端口；
- 浏览器端和桌面端共用正式 Tutor、Session、LearningTask、SkillRun、Review 与 LearningFile 对象。

`LearnFlow-pet` 仅作为桌宠迁移的原始参考实现。它与本仓库保持独立，不是持续合并上游，也不共享数据库、凭据或状态权威。

## 2. 当前 Git 状态

已提交的最近桌宠相关提交包括：

- `ad0f600`：桌宠桌面壳主链路；
- `ee0bcfa`：账户级视觉模型设置；
- `0284ce9`：兼容非标准 Spark Chat 响应；
- `2cc8f53`：兼容当前 OpenAI SDK 的 legacy response；
- `0a9070c`：视觉凭据测试使用有效尺寸图片。

生成本文时，以下文件仍有未提交改动：

- `backend/app/services/architecture_registry.py`：注册表版本升至 `2026-09-03.3`，登记原生选区读取与视觉回退语义；
- `backend/tests/test_architecture_registry.py`：同步注册表版本断言；
- `desktop/src-tauri/src/lib.rs`：按平台选择系统选区读取或交互式截图，并统一交给视觉回退链路；
- `frontend/src/DesktopPet.tsx`：消费原生文本结果、紧凑模式响应快捷键、移除手动“截图文字 OCR”入口；
- `docs/ARCHITECTURE_AUTHORITY.md`：补充 `2026-09-03.3` Contract impact；
- `docs/AGENT_ARCHITECTURE_GUIDE.md`：补充桌宠选区读取契约说明。

本交接文档也属于本轮新增文件。没有在本轮自动 commit 或 push；后续发布目标仍是 `origin/feat/desktop-pet-migration`，但提交前应先审阅上述混合工作树。

## 3. 架构约束

### 3.1 三类主 Agent

LearnFlow 只有三类主责任接口：

| Agent | 责任 |
| --- | --- |
| `tutor_agent` | 意图、对话、Action、工作台协调和 handoff |
| `learning_design_agent` | 路线、内容、问题、评估规格和视觉产物 |
| `practice_agent` | 提交、测试、判题、反馈、诊断追问和纠错呈现 |

桌宠是 `tutor_agent` 的桌面工作台入口，不是第四类主 Agent。

### 3.2 五核与证据写入

五核是学习者状态维度：`structure`、`knowledge`、`human`、`value`、`practice`。唯一合法的状态写入链为：

```text
用户 / UI / Tool / Agent 行为
  -> EvidenceEvent
  -> five_kernel_reducer
  -> KernelMutation
  -> KernelState
  -> MemoryFact -> MemoryModule -> MemoryClaim
```

桌宠上下文、图片观察、选区文字、导航和桌宠生命周期均不直接写 `KernelState`、`Memory Graph` 或 `EvidenceEvent`。桌宠临时上下文必须经过用户确认，并且只随一个正式 Tutor 回合消费。

### 3.3 注册表入口

桌宠能力已经登记在 `backend/app/services/architecture_registry.py` 与 `backend/app/services/action_board.py`：

- Tool：`desktop_pet_gateway`、`desktop_pet_vision_observer`；
- Workbench：`desktop_pet`，入口 `tauri://pet`；
- Capability：`desktop_pet_companion`、`desktop_pet_task_control`、`desktop_pet_main_navigation`、`desktop_pet_context_attachment`；
- 重要实现绑定：`api:pet.bootstrap`、`api:pet.context`、`api:pet.selection_text`、`py:pet.image_observation`。

修改上述架构热点时，需要同步实现、测试、文档和注册表版本，并在提交说明中写明 `Contract impact`。

## 4. 桌宠架构与数据流

```text
主窗口登录
  -> 账户响应返回 desktop_auth_token + 短效 desktop_pet_capability_token
  -> Tauri 主进程保存 capability 和正式 session_id
  -> 运行时创建独立 WebViewWindow(label = "pet")
  -> pet 通过受限 capability 调用 /api/pet/* 与正式 Tutor Session
  -> 用户确认的临时 context_refs 随一个 restricted Tutor turn 消费
```

### 4.1 Tauri/sidecar

- 主窗口 label 为 `main`，桌宠窗口 label 为 `pet`；两者共用 `index.html`，由 `frontend/src/main.tsx` 按窗口 label 分流。
- `openDesktopPet()` 运行时创建无边框、透明、置顶、跳过任务栏的 `360×520` 桌宠窗口。
- Tauri 启动 sidecar 时生成桌面 token、随机 loopback 端口和独立应用数据目录。
- sidecar 数据包括桌面数据库、`settings.env`、来源缓存、上传文件目录、插件制品目录和 `desktop-pet-settings.json`；这些目录不属于用户项目工作区。
- pet 关闭事件被拦截为隐藏，重新打开时复用同一窗口；窗口位置与尺寸会持久化，并在无效显示器坐标时回退。
- Windows 和 macOS 支持系统托盘、鼠标穿透恢复和可配置的全局快捷键；Windows 额外支持单实例唤醒。

### 4.2 认证与权限

桌宠使用 `lfpet_` 短效 capability，而不是主窗口 bearer：

- TTL：10 分钟；绑定账户、learner、父 `AuthSession` 和 `auth_epoch`；服务端只保存 token hash；
- capability scope：`pet.bootstrap.read`、`pet.session.read`、`pet.tutor.turn`、`pet.task.read`、`pet.task.control`、`pet.skill.control`、`pet.review.read`、`pet.file.read`、`pet.context.write`；
- URL 到 scope 的白名单在认证入口强制执行，普通 bearer 不能借用 `/api/pet/*` 的受限身份；
- 登出、会话撤销、账户 `auth_epoch` 变化或 capability 过期后，pet 身份失效并隐藏窗口。

### 4.3 临时上下文

当前支持的上下文类型：`text`、`ocr_text`、`image_observation`、`document_excerpt`、`video_transcript`。

生命周期为：

```text
创建 pending 包
  -> 前端预览
  -> 用户确认并绑定正式 Session
  -> Tutor restricted turn 携带最多 3 个 context_refs
  -> 成功后标记 consumed、清除正文
```

上下文默认 TTL 为 15 分钟，最大 30 分钟，正文上限 12,000 字。过期、删除或消费后正文清空，只保留有限 provenance receipt；原文不会进入 `AgentMessage`、`EvidenceEvent` 或长期记忆。重复图片请求通过 `client_context_id` 幂等。

## 5. 已交付功能

| 功能 | 当前状态 |
| --- | --- |
| 独立桌宠窗口 | 已交付：透明、置顶、无边框、紧凑头像/对话两种形态 |
| 桌宠形象 | 已交付：设置中可选 `mist`、`warm`、`dusk` |
| 托盘与单实例 | 已交付：显示/隐藏桌宠、打开主窗口、退出、第二实例唤醒首实例 |
| 主窗/桌宠同步 | 已交付：正式 Tutor Session 同步，主窗导航使用 request/ack |
| 桌宠任务与复习 | 已交付：读取任务/复习摘要、开始/暂停/恢复既有任务或 SkillRun、复习提醒通知 |
| 文本上下文 | 已交付：用户输入后预览、确认、单回合消费 |
| 图片观察 | 已交付：粘贴或选择图片，规范化后调用账户视觉模型并生成 TTL 观察 |
| 文档摘录 | 已交付：支持文本、Markdown、CSV、PDF、DOCX、PPTX、XLSX，最多 12 MB |
| 字幕导入 | 已交付基础 SRT/VTT/TXT 文本提取；完整 `source_ref` 时间轴链路仍待补齐 |
| 选中文本 | 已交付：优先读取系统原生 Unicode 选区，失败时回退视觉转录 |
| 鼠标穿透 | 已交付：本机设置持久化，并可从托盘恢复交互 |
| OS 贴边 dock/动画 | 未完成：`edgeAutoHide` 目前只持久化，不代表系统级贴边行为 |

## 6. 视觉模型配置

设置页展示的名称固定为“配置视觉模型”。主路径如下：

1. 账户在设置页填写视觉 API Key、Base URL 和模型名称；
2. API Key 以账户级加密信封保存，视觉用途使用独立 AAD；界面只返回脱敏 hint；
3. 桌宠通过 `/api/auth/vision-credential` 和 `account_vision_provider_config()` 取得当前账户范围的 provider 配置；
4. 没有独立视觉 Key 时，可以显式复用同一账户的 Tutor Key，Base URL/模型也按账户配置回退；
5. 桌宠 capability 不携带任何明文模型凭据，图片原始字节只在请求内存中处理。

相关接口：

- `GET /api/auth/vision-credential`：读取配置元数据；
- `PUT /api/auth/vision-credential`：保存或更新配置；
- `DELETE /api/auth/vision-credential`：清除独立视觉配置并回到未配置状态；
- `POST /api/auth/vision-credential/test`：发送最小有效测试图片验证连接。

视觉图片观察要求模型返回受约束的 JSON；格式或 provider 错误会转换为前端可读的中文错误。视觉观察是“不可信外部参考”，不改变评分、教学策略、掌握状态或五核。

## 7. 选中文字识别工作流

默认快捷键按系统选择：macOS 为 `Command+Option+P`，其他桌面系统为 `Ctrl+Alt+P`；用户可在桌宠设置中切换可用组合。

1. 桌宠隐藏时按快捷键：主窗口收到请求并打开桌宠；
2. 桌宠可见时按快捷键：Windows 优先读取当前窗口的原生选区文字；
3. Windows 原生读取失败时，回退为目标窗口截图；macOS 使用系统交互式区域截图；
4. 截图通过账户视觉模型调用 `/api/pet/selection-text`，不会依赖固定用户目录或固定窗口句柄；
5. 识别结果进入 `ocr_text` 临时上下文，仍需用户发送/确认后才随一个 Tutor 回合消费。

UI 已移除手动“截图文字 OCR”文件选择入口，用户只需在原应用选中文字后按快捷键。macOS 首次使用需要授予应用“屏幕录制”权限；视觉回退仍受 12 MB 图片和 12,000 字上下文上限约束。

## 8. 关键代码入口

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 后端模型 | `backend/app/models/learning.py` | `DesktopPetCapability`、`DesktopPetContextPackage` 及账户视觉字段 |
| 后端认证 | `backend/app/services/auth.py` | capability 签发、scope 白名单、账户视觉凭据加解密 |
| 后端 API | `backend/app/api/pet.py` | bootstrap、上下文包、文档、图片、选区转录 |
| 后端上下文 | `backend/app/services/desktop_pet_context.py` | TTL、确认、scope/session 校验、消费和幂等 |
| 后端视觉 | `backend/app/services/desktop_pet_vision.py` | 图片规范化、视觉观察、选区视觉回退 |
| Tutor 受限回合 | `backend/app/api/agent.py`、`backend/app/services/tutor_service.py` | `context_refs`、信任边界、单回合消费 |
| 前端运行时 | `frontend/src/runtime-client.ts`、`frontend/src/formal-runtime.ts` | 桌面 sidecar 地址、token/capability 注入、pet API 封装 |
| 前端入口 | `frontend/src/main.tsx` | 创建 pet 窗口、事件桥、主窗/桌宠挂载分流 |
| 桌宠 UI | `frontend/src/DesktopPet.tsx`、`frontend/src/PetAvatar.tsx` | 对话、任务、复习、上下文、快捷键结果展示 |
| Tauri 壳 | `desktop/src-tauri/src/lib.rs` | sidecar、托盘、单实例、快捷键、窗口生命周期、原生选区读取 |
| Tauri 权限 | `desktop/src-tauri/capabilities/default.json` | `main`/`pet` 窗口权限与本地 HTTP 访问 |
| sidecar 构建 | `desktop/scripts/build_sidecar.py` | PyInstaller 打包并复制目标三元组命名的 sidecar |

## 9. 本地启动与打包

### 9.1 浏览器开发模式

```bash
bash start.sh
bash start.sh status
bash start.sh stop
```

默认前端为 `http://localhost:4174`，后端为 `http://127.0.0.1:8010`。首次启动会检查 Python 3.10–3.13、后端依赖、`frontend/node_modules` 和 `backend/.env`。不要把真实 `.env`、数据库或日志提交到 Git。

### 9.2 桌面开发与构建

```bash
cd frontend
npm install
npm run build

cd ../desktop
npm install
npm run build:sidecar
npm run dev
# 发布构建
npm run build
```

桌面构建前需要：

- Rust stable 与 Tauri 2 平台依赖；
- `backend` 运行依赖；
- `desktop/requirements-build.txt` 中的 PyInstaller 依赖；
- Node.js 与前端/桌面 `node_modules`。

Windows 调试检查在没有默认 rustup toolchain 时使用：

```bash
rustup run stable cargo check --no-default-features
```

sidecar 制品写入 `desktop/src-tauri/binaries/`，通常被 Git 忽略；Tauri 安装包位于 `desktop/src-tauri/target/release/bundle/` 下。安装包签名、证书和商店凭据不在仓库内管理。

## 10. 验证记录

本次交接前已实际执行：

| 检查 | 结果 |
| --- | --- |
| `frontend/npm run build` | 通过；TypeScript 与 Vite 构建成功，只有既有大 chunk 提示 |
| `frontend/npm run test:auth` | 通过，15 项 |
| `backend` 的 `test_architecture_registry.py` + `test_desktop_pet_vision.py` | 通过，25 项 |
| `rustup run stable cargo check --no-default-features` | 通过 |

仍未完成或未在本机执行：

- Edge、PDF 阅读器等跨应用真实 GUI 选区回归；
- Tauri 安装包的完整安装、升级、托盘和单实例验收；
- 字幕 `source_ref` 与时间窗的完整服务端/前端链路；
- OS 级贴边 dock、自动隐藏和动画；
- Windows/macOS 安装包签名与发布流水线。

完整后端套件此前出现 9 项 Windows 权限、编码或符号链接环境失败，涉及 `code_executor`、`local_agent_broker`、`source_boundaries`、`workspace`、`user_isolation` 等非桌宠区域；不能把这些失败归因于桌宠改动，CI 或启用 Developer Mode 后应重新核验。

## 11. 建议接手顺序

1. 阅读根目录 `AGENTS.md`、`docs/ARCHITECTURE_AUTHORITY.md`、`docs/AGENT_ARCHITECTURE_GUIDE.md`、`docs/DESKTOP_PET_MIGRATION.md` 和本文。
2. 执行 `git status -sb`，逐个审阅当前六个未提交文件及本文；确认是否将 OCR 契约修复与文档分开提交。
3. 在 `backend`、`frontend` 和 `desktop` 分别运行最小回归，再启动 sidecar 与桌面调试版。
4. 使用测试账户登录，进入正式 Tutor Session，打开桌宠，配置“配置视觉模型”，验证纯文本、图片、文档、字幕和快捷键选区流程。
5. 在 Edge/PDF 中验证长选区：先确认原应用允许复制，再按快捷键，检查原剪贴板是否恢复、结果是否完整、发送后上下文是否清除。
6. 处理波次二事项：字幕 source_ref 共享常量、时间窗 receipt、OS dock/动画及真实 GUI e2e。
7. 发布前比较 `origin/main` 的非桌宠新变化；不要把当前桌宠分支误认为已与最新 `main` 完整对齐。

## 12. 安全与架构红线

- 不在文档、日志、提交或截图中保存 API Key、Token、Cookie、`.env` 值、数据库内容或模型凭据。
- 不让桌宠直接写 `KernelState`、`Memory Graph`、`EvidenceEvent` 或长期用户画像。
- 不新增第四类主 Agent，不建立第二套消息/学习状态权威。
- 不绕过 capability scope、learner/session ownership、TTL、确认和幂等校验。
- 不把视觉模型生成内容、一次答对、带提示成功或原题重做当作掌握证据。
- 不使用 `git reset --hard`、`git checkout --`、rebase 或 force push 清理工作树。
- 任何架构热点修改都要同步注册表、实现、测试和文档，并报告 `Contract impact`。
