# Role Package 纯文件交换

## 目标

在部署网关之前，role-agent 与 LearnFlow 通过一个不可变文件交换岗位包。两边不共享数据库、运行状态或内部类，
传输合同固定为 role-agent 已发布的 `StaticRolePackageBundle`：

```text
{
  manifest: StaticRolePackageManifest,
  components: Record<relativePath, exactJsonText>
}
```

协议必须是 `static-role-package@3.0.0`，身份由
`packageId + packageVersion + snapshotId + rootHash` 固定。

## 导入门

LearnFlow 的文件导入器在任何写盘前检查：

1. 文件大小、JSON 信封和 SemVer；
2. 九个必需 entrypoint 及无路径穿越；
3. components 与 manifest hashes 集合完全一致；
4. 每个组件 SHA-256；
5. canonical manifest root hash；
6. snapshot 组件与 manifest 的 snapshotId 一致；
7. 同 `packageId + packageVersion` 只能对应同一 root hash。

通过后写入同文件系统 staging 目录，再原子 rename 为不可变版本目录。重复导入同一 root hash 幂等返回，版本冲突
失败关闭，不覆盖原包。

## 命令

```bash
cd frontend
npm run role:import-file -- \
  --file /tmp/llm-app-engineer-1.0.0.role-package.json \
  --dry-run

npm run role:import-file -- \
  --file /tmp/llm-app-engineer-1.0.0.role-package.json
```

默认安装到岗位插件自身的 `data/packages`。当前这是维护期/构建期能力，不是 Tutor Tool，也不写五核、EvidenceEvent
或 LearnFlow 核心对象。生产部署时应把 `packageRoot` 指向应用数据目录，并让确认式网关复用相同校验器；网关不得
重新解释或改写 bundle。
