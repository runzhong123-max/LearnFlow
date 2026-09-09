# 岗位包注册中心协议 v1.0

状态：`implemented`（2026-08-22）

Package Registry 不是文件列表，也不是另一个事实层。它是静态岗位快照及其发布包的身份、治理、发现和解析平面；岗位事实仍在不可变 Static Role Package 中。

## 核心对象

```text
RoleIdentity 1 ─── n PackageLine 1 ─── n PackageRelease
     │                  │                       │
岗位身份/别名       维护与托管政策          确切版本/快照/制品
```

### RoleIdentity

- 稳定岗位身份、规范名称与别名；
- 行业、地区、学段和适用人群；
- 身份状态与替代关系。

### PackageLine

- `packageId` 与协议兼容范围；
- 维护组织、维护类型、维护策略和更新节奏；
- 托管类型（bundled / hosted / remote）；
- 可见范围和证据公开策略；
- 来源许可；
- 当前推荐 Release 指针；
- active / deprecated / disputed / superseded 状态。

维护和托管被刻意分开：一个包可以由来源组织维护、由 Role Atlas 托管；也可以由社区维护、仅登记远程制品。

### PackageRelease

- SemVer、确切 `snapshotId` 和 `snapshotAsOf` 时间边界；
- Static Role Package `rootHash`、校验报告哈希、协议版本和 PackageLine 兼容范围；
- preparing 状态（compiling / validating）、ready、published、failed、deprecated；
- 源 ProjectVersion、发布时间和废弃信息。

## 推荐版与历史版

`PackageLine.recommendedReleaseId` 是一个可原子切换的分发指针，不等于 Project HEAD，也不改变任何静态岗位快照。项目的 `currentReleaseId` 是工作台默认使用的发布版；二者在发布事务中一起移动。

解析顺序：

1. 项目内引用使用 `projectId + versionId` 精确解析；
2. 发布引用使用 `snapshotId + packageVersion` 精确解析；
3. 只给 `snapshotId` 时优先最近可用的已发布/可用制品；
4. 历史节点引用始终携带完整包坐标，不跟随推荐指针。

## Static Role Package v3

编译制品包含九个确定性组件：

- `snapshot.json`
- `sources.json`
- `semantic-graph.json`
- `work-process-forest.json`
- `views.json`
- `object-index.json`
- `retrieval-index.json`
- `validation-report.json`
- `reference-migrations.json`

Manifest 保存每个组件 SHA-256 与整体 root hash。导入支持规范 JSON 和 ZIP；导入前检查路径安全、协议、组件哈希、引用完整性和公开证据政策。相同 `packageId + version` 内容不同会拒绝，相同制品重复导入保持幂等。

编译器只产生 v3。历史 v2 制品可在导入边界通过校验并归一为 v3 内部岗位包；重新发布时一定编译为 v3，不延续旧三包身份。

## 治理边界

- `validation.valid` 表示文件、哈希与引用完整性；`validation.publishable` 表示可形成正式岗位包，`publicationBlockers` 给出可处理的阻塞原因。二者必须同时通过才进入 `ready`；
- 岗位定义、任务、能力、知识技能、结构关系、工作场景与任务关联、实际证据绑定不能缺失；原项目各维度校验失败、`publishable=false`、错误级审计或被排除来源仍有绑定都会阻止 `ready`。语义重合等非阻塞警告仍保留；
- 未通过质量门的编译记录为 `failed`，保留诊断制品和完整项目候选快照，可继续迭代；不删除成果，也不把候选标为正式可发布包；
- 正式保存、公开发布、回滚及重新公开前重新校验不可变制品，旧 `ready` 记录不能绕过新增质量门。公开 `metadata/redacted` 同时遮蔽私有正文及原文引用，私有项目源版本保持不变；
- 私有正式保存使用 `save_private`，强制不可变 manifest 的 `visibility=private`。公开发布使用 `publish`；客户端传 `expectedVisibility`，与制品不一致返回冲突，不根据可变包线或页面当前选择重新解释产物。内部 `published` 生命周期同时用于已私有保存及已公开发布，界面必须结合不可变可见范围呈现；
- 来源页分别显示实际绑定、待核验/未绑定、已排除资料。搜索入选、抓取成功与资格通过都不等于证据采纳；被排除候选保留用于审计；
- `disputed` 表示存在明确争议，不等于技术校验失败；
- `deprecated` 和 `superseded` 保留历史解析，不执行物理删除；
- 首期 Registry 是单实例 D1 注册中心，远程联邦、签名信任链和自动同步留待 Hub 阶段。
