# 岗位包引用与 Hub Fork 修复验收

日期：2026-09-13。范围：Role Atlas 发布/项目读取、中央 Web Tutor 岗位插件、桌面兼容导入与固定引用。

## 已确认并修复

- signed launch 的 requiredSelector 缺 rootHash；后续工具还可能漏传 selector 而读取内置包。现在补齐完整四元身份、继承当前引用，并拒绝冲突或损坏的历史引用；显式新引用可重新选择。
- Hub 的“在 LearnFlow 中使用”创建了引用，但原插件只能读取启动时安装的包。现在通过已登记的 ecosystem_gateway_v1 读取权限允许的精确 bundle，核验原始组件和 manifest 哈希，在调用内创建只读索引；不写全局缓存或用户学习状态。
- Fork 的 brief.projectId 已变成新项目，顶层 projectId 仍属于上游。现在统一新身份；旧 Fork 通过受限项目读取投影兼容，不改历史字节和数据库。
- 指定项目无法解析时不再落回全局快照；同 snapshotId 的新发布版本不再被内置旧版本遮蔽。版本与快照必须一致。

Contract impact：沿用 Tutor 既有网关与岗位插件责任，`package.resolve` 增加可选 `format: "bundle"`，默认输出保持兼容。插件版本两端 1.8.0；对象 schema 不变，无新 Agent、Event 或五核写权限。详见 `docs/product/ECOSYSTEM_GATEWAY_V1.md`。

## 已执行且通过

- Role Atlas：627 tests；`npm run typecheck`；`npm run build`。
- Web：116 插件 tests（包含宿主权限、历史引用恢复和远程原始制品读取），59 Tutor runtime tests，`npm run build`。
- 桌面：98 插件 tests，60 Tutor runtime tests，`npm run build`。
- Web 后端：1069 passed，1 项原有废弃私有密钥 CRUD 测试跳过。
- 桌面后端：1089 passed。
- `python3 scripts/check_shared_contracts.py`：共享 core 0.2.5，148 个共同事件，三类 Agent、五核一致。
- `git diff --check`。

Role Atlas 首轮在沙箱中因两项测试无法监听 127.0.0.1 临时端口而失败；获得执行权限后原样重跑全套，627 项全部通过。未删断言或跳过这些测试。构建仍有既有 chunk 大小及动态路由分类提示；后端仍有既有 datetime/ORM 弃用警告。

## 边界

- 桌面本地账号未获得中央身份委托；兼容导入和固定引用已验证，不宣称本地账号能读取中央私有包。
- 内容验证使用现有冻结岗位包与隔离 SQLite、模拟网关，不开展新岗位调研，不用模型自评代替运行验证。
- 源包、历史快照、日常数据库与学习状态不因本轮修复而迁移。
