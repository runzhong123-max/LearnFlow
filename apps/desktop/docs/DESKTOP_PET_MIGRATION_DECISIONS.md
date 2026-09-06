# 桌宠迁移 · 决策评审稿（可勾选）

> 配套文档：[DESKTOP_PET_MIGRATION.md](DESKTOP_PET_MIGRATION.md)（迁移方案正文）。
> 用途：把正文 §4/§7 的开放决策点展开成"背景 → 选项 → 影响 → 建议"，逐项打勾后即可按 Phase 0–8 执行。
> 勾选方式：把推荐项前的 `[ ]` 改为 `[x]`，或直接在回复里报编号（如 "D1=A, D3=A, D5=档位A…"）。

---

## D1 — 迁移基线 / 波次范围

**背景**：LF 桌宠主链路已提交（`d8607a5` 稳定版），但工作区还叠加了一批**未提交/未跟踪**的在途特性——字幕导入（source_ref）、选区 OCR 转录（`/pet/selection-text`）、dock/贴边动画。三者前后端靠常量软对齐、测试未全覆盖、Rust 有调试残留，属于"最新但未稳"。

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A（推荐）** | 波次一先迁 LF 已提交的 `d8607a5` 桌宠主链路；波次二把在途三特性独立评审后再迁 | 第一波可控、可验证；字幕/OCR 价值后置 |
| B | 连在途特性一次迁移 | 一次到位，但需要先把 LF 工作区定格 + 补齐两套新测试再动，Phase 0 负担大 |
| C | 只迁"后端 + 前端最小聊天集"，图片/字幕/桌面能力全部砍 | 最小可跑，产品价值打折，不推荐作为正式基线 |

> 无论选哪个，**Phase 0 都必须先把 LF 工作区定格**：建议 `git add -A && git commit` 到 LF 一个 `snapshot/*` 分支（含未跟踪文件），导出 patch 备查。

勾选：`[ ] A`　`[ ] B`　`[ ] C`

---

## D2 — 桌宠鉴权形态（capability 令牌）

**背景**：LF 用 `lfpet_` 前缀短效令牌（9 项 scope、TTL 600s、DB 存 hash、绑定 auth_epoch、`POST /api/auth/desktop-pet-capability` 仅桌面态可刷新、路由入口 URL→scope 白名单强制）。all 现成的 `desktop_token` 是无前缀裸 uuid、语义是"整个桌面"，达不到 per-capability 最小权限。

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A（推荐）** | 照 all `services/role_package_launch.py`（HMAC body+sig、secret 入 Settings）的模板新建 `lfpet_` capability，DB 存 token hash | 与 all 安全体系同构、最小权限、可撤销；Phase 2 工作量最大 |
| B | 扩展现有 desktop token/bearer 语义来放行 `/api/pet/*` | 改动小，但能力边界粗，与"桌宠只读+受限动作"约束相悖 |
| C | 直接给 pet 窗派发主窗 bearer 子集 | 违背最小权限设计，**不推荐** |

勾选：`[ ] A`　`[ ] B`　`[ ] C`

---

## D3 — 视觉模型（图片观察）来源

**背景**：桌宠图片视觉需要与 `LearnFlow-pet` 一致，使用当前账户范围的视觉 provider（独立 API key/base/model，独立加密 AAD），并允许显式复用同一账户的 Tutor Key。

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| A | pet 视觉改用 all 后端 `.env VISION_*` | 服务端统一配置，但无法按账户隔离视觉模型 |
| **B（已采用）** | 把 `LearnFlow-pet` 的后端账户级视觉凭证体系搬进 all（加密存储/解密/AAD 用途扩展） | 支持独立视觉 Key、Base URL、模型名及复用 Tutor Key；需同步认证、迁移、API、桌宠和测试 |
| C | 波次一先不做图片视觉理解（仅文字/文档/字幕/复习提醒），图片后置 | 最稳，砍功能 |

勾选：`[ ] A`　`[x] B`　`[ ] C`

---

## D4 — Tutor 受限回合（`context_refs`）

**背景**：all 的 `client_turn_id` 幂等**已全链落地**，缺的只是把"已确认的临时上下文"带进回合的 `context_refs` 与受限分支。带图/带字幕提问、单回合消费、防跨 scope 串发都依赖它。

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A（推荐）** | `TutorTurnRequest` 加 `context_refs`（max 3）+ `tutor_turn` 的 `desktop_pet_restricted` 分支（强制幂等 id、禁 scope/action 覆盖、成功后 consume）+ `tutor_service` 注入信任边界文本 | 支持临时上下文全链路；**回归红线：常规 turn 不带新字段时行为必须不变** |
| B | 桌宠只发"纯文本普通回合"，暂不引入 context_refs | 第一版最简，但图片/字幕/文档摘录都进不了回合，桌宠核心价值（陪伴材料问答）缺失 |

勾选：`[ ] A`　`[ ] B`

---

## D5 — 桌宠窗口 / OS 桌面能力档位

**背景**：all 的 Tauri 壳是极简单窗（`lib.rs` 101 行，只有 `desktop_runtime_config`）。桌宠完整桌面体验（托盘/快捷键/单实例/dock/截图 OCR）都在 LF 的 Rust（1390 行），且含在途调试残留，需要重写式移植而非照抄。

| 档位 | 内容 | 影响 |
| --- | --- | --- |
| **A（推荐第一波）** | 运行时 `new WebviewWindow('pet', {…360×520, decorations:false, transparent, alwaysOnTop})` + 窗口 label 门禁 + 关闭即隐藏 + 主窗↔pet 导航 request/ack + 顶栏"打开桌宠"入口 + capabilities 对 `"pet"` 授权 | pet 可用、改动集中在 frontend + capabilities |
| A+ | A + 复习提醒系统通知（tauri-plugin-notification） | 若做复习提醒则需 |
| **B（后置）** | 再移植托盘 / `Ctrl+Alt+P` / 单实例 / dock 贴边 / `capture_desktop_pet_ocr/selection` | 工作量和风险集中在此，建议在 A 验收后再单独做 |

勾选：`[ ] A`　`[ ] A+`　`[ ] B`（可 A+B 连选，注明先后）

---

## 定稿记录（2026-09-02 评审结论）

| 决策 | 结论 | 备注 |
| --- | --- | --- |
| D1 | **A** | 波次一先迁 LF `d8607a5` 桌宠主链路；波次二在途特性后置 |
| D2 | **A** | 照 `role_package_launch` 模板新建 `lfpet_` capability |
| D3 | **B** | 视觉走当前账户级配置，未设置独立 Key 时复用 Tutor Key |
| D4 | **A** | `context_refs` + restricted 受限回合 |
| D5 | **档位 A + 快捷键** | 见下"D5 补充决议" |
| D6 | **A** | 抽单一共享常量源（波次二前做） |

### D5 补充决议：快捷键纳入波次一

用户明确要求**全局快捷键也要做**。核实 LF 实现后确认其语义：

- `Ctrl+Alt+P`（`lib.rs` `start_pet_global_shortcut_listener`，注册 `VK_P` + `Ctrl+Alt`，id `PET_GLOBAL_SHORTCUT_ID`）
- 桌宠隐藏/未开 → **无效（no-op）**；
- 桌宠可见时按下 → `request_desktop_pet_selection_capture`：对**当前前台窗口**做一次性高亮选区抓取，交由 OCR / 视觉转录为可编辑文本，随回合发给 Tutor（`learnflow:desktop-pet-selection-capture-requested` 事件 → pet 前端）。

**由此带来的范围调整**：波次一需从波次二提前移植"**前台选区抓取 + OCR/视觉转录**"这一块（涉及 `lib.rs` 的 `capture_desktop_pet_ocr/selection` + DesktopPet 事件处理 + 后端 `/pet/selection-text`）。**字幕 source_ref / 导入仍留在波次二。**

### D5 最终决议（已确认）

> **采用 LF 完整语义**：pet 打开可见时按 `Ctrl+Alt+P` → 抓取当前前台窗口高亮选区 → OCR/视觉转录为可编辑文本随回合发给 Tutor。选区抓取 + OCR/视觉转录链（含后端 `/pet/selection-text`）**提前纳入波次一**；字幕 source_ref 仍留波次二。

---

## D6 — 前后端 source_ref / 字幕常量同步（波次二相关）

**背景**：LF 的字幕 source_ref 目前是前端 `desktop-pet-subtitles.ts` 与后端 Pydantic 各写一份常量（`SOURCE_REF_VERSION`、`MAX_SUBTITLE_CUE_RECEIPTS` 等），靠字符串软对齐，已埋下漂移隐患。

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A（推荐）** | 抽出单一共享常量源：建一份共享模块（例：`frontend/server/pet-source-ref-constants.ts` 或后端 schema 生成前端类型），前后端引用同一来源 | 杜绝双份漂移，波次二前做 |
| B | 维持双份拷贝 + 命名/注释强制同步 | 改动最小，但正是 LF 现在的风险点 |

勾选：`[ ] A`　`[ ] B`

---

## 汇总行（供快速确认）

> D1=＿　D2=＿　D3=＿　D4=＿　D5=＿　D6=＿（例：D1=A, D2=A, D3=A, D4=A, D5=档位A, D6=A）

**默认全推荐**：D1=A（先主链路后特性）→ D2=A（新建 lfpet_ capability）→ D3=B（账户级视觉配置）→ D4=A（context_refs + restricted）→ D5=档位 A（最小 pet 窗先行）→ D6=A（共享常量，波次二前）。

全部按推荐即为**波次一 = 桌宠主链路最小可用**；若 D1 选 B、D3 选 B、D5 选 A+B，则为**完整版一次到位**。
