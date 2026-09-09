# 项目版本、Tag 与岗位包发布协议 v1.0

状态：`implemented`（2026-08-22）\
原则：参考 Git 的心智模型，但不要求用户会使用 Git，也不把运行数据库替换成 Git 仓库

本协议没有“版本化基线”概念。对外领域对象始终是静态岗位快照；ProjectVersion 记录项目历史，Tag 提供人类命名，Release 负责校验、分发和当前推荐指针。三者不会改变静态快照本身。

## 0. 已实现架构

```text
冷启动 / 统一迭代 / 工作区实例化
                │
                ▼
      commitProjectVersion（唯一写入口）
                │
        ┌───────┴────────┐
        ▼                ▼
immutable Snapshot   immutable ProjectVersion
content hash         parent + source run + root hash
        │                │
        └───────┬────────┘
                ▼
      semantic Diff / Tag / restore
                │
                ▼
 Package Compiler → Validator → content-addressed Artifact
                │                         │
                └──────── ready Release ──┘
                              │ atomic publish / rollback
                              ▼
               PackageLine.recommendedReleaseId
```

关键实现：

- `lib/versioning/commit.ts`：不可变快照、统一版本提交、历史恢复和旧数据回填；
- `lib/versioning/identity.ts`：同维度、无歧义对象的稳定 ID 继承；
- `lib/versioning/diff.ts`：按对象 ID 和字段路径生成语义 Diff 与引用迁移；
- `lib/packages/*`：确定性编译、硬不变量校验、JSON/ZIP 导入导出和内容寻址存储；
- `lib/releases/*`：prepare、原子发布、失败隔离、推荐指针回滚和历史解析；
- `lib/registry/*`：岗位身份、PackageLine、维护/托管/证据政策和版本目录；
- `/projects/:id/versions` 与 `/registry`：版本发布工作台和岗位包目录。

## 1. 概念映射

| Role Atlas | Git 类比 | 含义 |
|---|---|---|
| 运行候选 | working tree | 当前生成中的候选内容；失败不会成为版本 |
| 项目版本 | commit | 某一时刻完整、不可变、可比较的项目状态 |
| 分支 | branch | 从某个版本开始的不同研究方向或实验 |
| Tag | tag | 指向某个版本的不可变、人类可读里程碑名称 |
| 发布 | release | 从某个版本编译、校验并登记 Static Role Package |
| 当前岗位包 | deployed release | 默认对话和图谱使用的发布版本 |

这些概念在 UI 中使用中文主名称，辅助说明中介绍 Git 类比。

## 2. ProjectVersion

```text
id
project_id
parent_version_id?
source_run_id
source_kind               cold_start | iteration | workspace | restore | import | legacy
version                   人类可读的生成标签，不是 Tag 或 SemVer
snapshot_id
status                    candidate | ready | published
root_hash                 完整岗位快照内容哈希
message
author_kind               user | agent | system
package_json              冻结后的完整工程快照
created_at
```

首期 ProjectVersion 同时保存完整、可直接恢复的工程快照和内容哈希。Static Role Package Artifact 另行按 root hash 内容寻址；二者职责不同。

### 2.1 创建时机

自动版本：

- 完成一次冷启动并通过最低结构校验；
- 完成一次岗位快照迭代（可包含深度研究、风险修复、时间刷新或工作区重构）；
- 完成一次真实工作区实例化；
- 用户明确从历史版本恢复。

可恢复 checkpoint 不等于项目版本。LangGraph/Workflow checkpoint 用于续跑；ProjectVersion 用于产品历史、比较和引用。

### 2.2 版本消息

Agent 自动生成简洁、可验证的消息：

```text
建立首个任务—能力—知识技能结构
补充金融行业样本并修订任务 T-04
合并 5 个重复技能节点，新增 2 个前置关系
根据工作区实例补充隐含职责，未改变市场岗位共性
```

禁止只有“自动保存”“更新数据”这类无信息消息。

## 3. Branch（未来扩展，不属于本阶段实现）

默认仍是一条线性父版本链。本阶段没有建立 Branch 表或分支操作；以下仅保留为 Hub 阶段候选：

```text
id
project_id
name
head_version_id
base_version_id
purpose
status                    active | merged | archived
created_at
```

创建分支的典型情境：

- 比较不同岗位边界解释；
- 单独深化某个行业或资历层；
- 教师基于共同岗位包尝试不同课程投影；
- 企业基于公开岗位快照建立私域实例；
- 在不影响当前发布版的情况下尝试大规模结构修订。

当前实现中，运行失败或取消不会移动项目 HEAD。

## 4. Tag

```text
id
project_id
name
target_version_id
description
created_by
created_at
```

Tag 是不可变指针。要移动同名 Tag，必须删除后重建，并保留审计记录。

建议名称：

- `首个可用版`
- `2026春季教学版`
- `企业评审版`
- `赛题提交版`
- `v1.0.0`

Agent 可以建议 Tag，但不能在用户没有表达里程碑含义时为每次自动版本创建 Tag。

## 5. Release 与 Static Role Package

发布记录：

```text
id
project_id
source_project_version_id
package_line_id
package_version
snapshot_id
snapshot_as_of
protocol_version
status                    compiling | validating | ready | published | failed | deprecated
artifact_root_hash
validation_report_hash
published_at?
supersedes_release_id?
```

发布必须从一个 ProjectVersion 开始，不能直接从仍在变化的工作图谱开始。

## 6. Package Compiler

编译流程：

```text
read exact ProjectVersion
        ↓
project source/evidence visibility policy
        ↓
materialize snapshot + sources + semantic graph + process forest + views
        ↓
generate object index + retrieval index + reference migrations
        ↓
run protocol / reference / privacy validation + quality warnings
        ↓
calculate component SHA-256 + package root hash
        ↓
register immutable artifact
```

### 6.1 编译选择

Compiler 编译所选 ProjectVersion 的完整静态岗位快照，不在发布阶段重新让模型筛选或改写节点。对象自身的 accepted/candidate/rejected 认识状态继续保留。协议、哈希、引用完整性和公开隐私泄露是硬错误；语义重合、覆盖不足、弱证据与时效风险进入 validation warnings，不以数量门禁丢弃快照。

### 6.2 发布失败

编译或校验失败：

- 保留状态为 `failed` 的 Release 尝试和校验错误，便于审计；
- 不移动项目的当前发布指针；
- 不修改旧岗位包；
- 保存 validation report；
- 校验错误可由用户带入统一岗位快照迭代，但发布服务不自动修改岗位事实；
- 保留原 ProjectVersion，便于复现。

## 7. SemVer

Static Role Package 继续使用带引号的 SemVer。

建议升级规则：

### PATCH

- 修正文案、别名或来源定位；
- 不改变核心实体集合和关系含义；
- 提升证据粒度但不改变断言结论。

### MINOR

- 新增任务、能力、知识技能或相邻岗位；
- 扩大行业、地区或资历覆盖；
- 新增兼容的谓词、视图或 derived insight；
- 改善图谱结构但保留旧引用目标的可迁移映射。

### MAJOR

- 改变核心岗位定义或包协议；
- 删除或重定义大量稳定实体；
- 关系语义不兼容；
- 引用协议发生破坏性变化。

语义 Diff 根据变化类型提出升级建议；Compiler 校验 SemVer 语法。本阶段不自动阻止用户选择比建议更低的版本号，发布动作仍由用户或具有权限的项目角色触发。

## 8. Snapshot ID 与版本引用

发布后生成：

```text
package_id      role-package:<role-slug>
package_version <semver>
snapshot_id     snapshot:<role-id>@<as-of>:<revision>
```

`snapshot_id` 指向一个确切、不可变的静态快照；`as_of` 仍单独表达它描述岗位事实的时间边界。同一 `as_of` 的语义、证据或事理修订会获得新的 revision，而不是覆盖原快照。旧协议中不带 revision 的已发布快照仍然有效，解析器通过包清单完成兼容。

风险研究等跨存储 Skill 使用统一引用：

```text
snapshotId
packageVersion?  发布包精确解析提示
projectId?       仅作为存储路由提示
versionId?       仅作为项目内精确解析提示
```

项目 ID 和版本 ID 不构成快照的领域身份。静态快照也不需要先转换成另一种“版本化基线”才能被 Skill 使用。

现有节点引用协议继续携带：

```text
packageId
packageVersion
snapshotId
targetId
fieldPath?
selectionHash?
```

工作图谱引用使用：

```text
projectId
versionId | runId + graphRevision
candidateId
fieldPath?
selectionHash
```

当一次对话首次引用工作图谱节点时，系统固定版本或 graph revision。后续节点被合并时，显示迁移提示，不静默把旧引用替换为新语义。

## 9. Diff

任意两个 ProjectVersion 之间提供：

- 岗位边界变化；
- 新增、修改、重命名和移除节点；
- 新增、修改、移除关系；
- 来源集合变化；
- 证据绑定和认识状态变化；
- 已解决和新增风险；
- 图谱统计变化；
- 对任务—能力、学习路径和 JD 投影的影响。

Diff 不比较 JSON 文本行。实现按稳定 ID 对齐对象，以字段路径比较对象内容，并为高置信的一对一替代和稳定 ID 重命名生成显式引用迁移。合并/拆分不会被臆测为自动迁移，需后续人工或 Agent 研究确认。

## 10. 用户界面

版本工作台左侧显示不可变历史链：

```text
● HEAD      迭代 Agent 能力与证据           刚刚
● pv:01J... 建立首个岗位图谱               10 分钟前
│  tag: 首个可用版
● pv:01H... 项目创建                       25 分钟前
```

对初学者默认显示：

- 查看变化；
- 标记里程碑；
- 编译并发布岗位包；
- 恢复到此版本。

界面同时显示 version ID、snapshot ID、root hash、Release 状态与导出/回滚操作；分支与合并尚未实现。

“恢复到此版本”不删除后续历史，而是从选定版本创建新的工作状态，语义类似 revert/fork。

## 11. Agent 与 API 边界

当前由服务层和受控 API 提供：

```text
GET/POST  /api/projects/:projectId/versions
GET       /api/projects/:projectId/diffs
GET/POST/DELETE /api/projects/:projectId/tags
GET/POST/PATCH /api/releases
GET       /api/releases/:releaseId/export
POST      /api/packages/import
GET/PATCH /api/registry[/packageLineId]
GET       /api/reference-migrations
GET       /api/snapshots/resolve
```

读取、Diff、编译和校验可以由 Agent 自动调用；Tag、发布、回滚和废弃属于改变分发状态的操作，当前只通过显式用户界面/API 发起。接口明确区分：

- 创建可恢复 checkpoint；
- 创建 ProjectVersion；
- 创建 Tag；
- 编译 package；
- 发布 release。

Agent 不应把“我保存了一下”同时解释为以上多个动作，也不能把生成运行的 checkpoint 误报为岗位版本。

## 12. 事务与恢复不变量

1. `snapshot_id` 已存在且内容哈希不同，写入以 `IMMUTABLE_SNAPSHOT_CONFLICT` 失败。
2. 同一项目和 `source_run_id` 只能形成一个 ProjectVersion；重试返回原版本。
3. 冷启动、迭代、工作区实例化完成时均调用同一个提交服务；无信息增量的成功迭代仍形成指向原静态快照的新项目版本。
4. 恢复历史版本会创建新的 `restore` 版本并移动 HEAD，不删除后续历史。
5. 编译先产生内容寻址 Artifact 和 `ready` Release；发布以一组 D1 batch 语句比较并移动推荐指针。
6. 编译/校验失败或并发发布冲突都不修改 `recommended_release_id` 和项目 `current_release_id`。
7. 回滚只移动推荐指针并写审计事件；历史 Release 和 Artifact 不变。
8. 节点引用固定 `packageId + packageVersion + snapshotId + targetId`；精确解析不依赖当前推荐版。

## 13. 教学价值

版本界面同时帮助高职学生和教师理解：

- 岗位认识是如何随着证据演进的；
- 新来源为什么导致任务或能力结构变化；
- 工作区实例与市场岗位共性有什么区别；
- 一个岗位结论在什么时间和范围内成立；
- 研究结果为什么不能被静默覆盖。

因此版本历史本身也是课程和研究材料，不只是工程备份设施。

## 14. 从 Graph Hub 撤回与重新公开

“我的岗位包”对当前所有者完整拥有、且推荐版曾以公开制品发布的岗位包显示“从 Graph Hub 撤回”。确认后将整个岗位包线设为 private；Hub 列表、检索、详情与匿名制品访问均遵循这一可见性。个人内容、推荐版指针、历史 Release、制品哈希均保留，不删除数据。已下载或导入到其他系统的副本无法追回。

撤回后同一入口显示“重新公开到 Graph Hub”，复用原公开推荐版。私有编译制品不能经此入口扩大披露，仍需走正式公开编译发布流程。

`PATCH /api/releases` 新增 `withdraw_from_hub` / `restore_to_hub`，参数为 `packageLineId`、`expectedReleaseId`、`expectedRegistryVersion`。沿用所有者身份和整条包线写权限检查；D1 batch 原子写入可见性及 `release.hub_withdrawn` / `release.hub_restored` 事件，推进 registry_version。重复目标状态不重复写事件；版本冲突返回 409，要求刷新后重试。

Contract impact：新增兼容的 Role Atlas 发布动作和发布事件；不改变不可变岗位包协议、不新增数据库字段，不涉及 LearnFlow 五核或 EvidenceEvent。

## 15. Fork 公开岗位包到个人空间

Graph Hub 仓库详情的“Fork 到我的岗位包”会把当前公开 Release 复制为登录用户自己的项目、会话、快照和私有岗位包，并打开个人工作台。它复用 import 类型的版本提交和私有 Release 登记，不自动公开、不复制上游项目的私有会话或草稿。

同一账户和源 Release 对应唯一 Fork；重复点击返回已有副本，不覆盖其后续迭代或推荐版。不同账户或不同源版本拥有独立身份。已放入回收站的副本需要先恢复，不能通过再次 Fork 隐式恢复。中途失败可以重试，已完成的版本提交被幂等复用。

来源记录保存在初始 import 运行的 `input_json.upstream` 中，包括仓库、Release、packageId、packageVersion、快照、内容哈希和许可。“我的岗位包”显示来源及“打开并维护”。个人副本保留上游许可，默认私有 v1.0.0；后续独立迭代，若要公开自己的版本，按正常发布流程选择新版本号（例如 v1.0.1）。上游更新不会自动覆盖个人内容；来源撤回后不再允许新 Fork，已获得的独立副本仍可维护。

`POST /api/hub/fork` 只接受 `releaseId`，目标所有者由身份桥取得。服务端重新验证公开可见性、published 状态、active 包线和制品哈希；客户端不能指定他人所有者、目标项目或私有来源。公开导入读取和个人项目写入是两个权限边界，不授予 Fork 者对上游的写权限。

Contract impact：新增兼容的 Role Atlas API，沿用 import ProjectVersion、version.created 和私有发布事件；无数据库字段迁移、不改变岗位包制品协议及 LearnFlow 五核语义。
