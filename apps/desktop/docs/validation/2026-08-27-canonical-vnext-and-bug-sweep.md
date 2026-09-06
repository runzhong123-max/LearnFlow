# 2026-08-27 vNext 唯一版本与全量缺陷验收

## 结论

- `frontend/` 是唯一产品前端；历史目录名 `vnext/` 只保留在文档和兼容性稳定 ID 中。
- `backend/` 是当前 Tutor、学习任务、项目、五核与证据链的正式运行时；`desktop/` 是当前桌面壳，二者都不是可删除的旧版本。
- Git 中不存在 `vnext/**`、`legacy-frontend/**`、`frontend-old/**` 或 `output/**` 旧实现。
- 本轮没有删除 `.env`、日常数据库、备份、模型、缓存或本地测试痕迹；这些都不进入版本控制。

## 目录收紧

- 新增 `scripts/verify_repository_layout.sh`，持续检查正式入口、旧目录回流、旧 5173 运行入口与非文档 `vnext/` 依赖。
- `make verify-layout` 单独执行目录权威检查；`make verify` 串联前端测试与构建、后端全量测试和桌面 Rust 检查。
- README 只描述 `frontend/ + backend/ + desktop/ + docs/` 的正式结构。

## 缺陷与修复

1. **跨浏览器删除的对话会复活**
   - 原因：旧浏览器先把本地对话回写到已删除的服务端会话，404 恢复逻辑又创建了新会话。
   - 修复：仅迁移没有正式会话 ID 的浏览器旧数据；完整分页读取服务端活动会话；服务端列表缺席作为删除墓碑，单会话暂时加载失败只标记为不可用。
   - 结果：新标签页会移除已删除对话，不产生预期 404；学习证据仍由后端保留。
2. **普通对话超过 100 条时无法形成完整权威视图**
   - 修复：会话列表增加稳定 `offset` 分页，前端遍历全部页再进行归并。
3. **学习事件并发写入可能竞争 learner sequence**
   - 修复：同一浏览器批次按原始顺序串行进入正式事件入口，保持可重放顺序。
4. **重复启动会把旧服务误报为新服务**
   - 原因：端口已有服务时，新进程退出，但健康检查读到了旧服务。
   - 修复：启动前检查监听端口并明确拒绝；停止时只根据 PID 文件或本仓库工作目录清理进程，不再用宽泛 `pkill`。
5. **陈旧 PID 文件显示为部分运行**
   - 修复：没有存活进程时清理陈旧状态并报告未运行。
6. **`/demo` 落入普通新对话**
   - 修复：`/demo` 明确进入隔离 demo 的复习工作台，并规范化为 `/review`。

## 实际执行的验收

- 前端单元测试：91 passed。
- 前端生产构建：Vite 321 modules，构建通过。
- 后端全量测试：194 passed；仅保留现有依赖和 `datetime.utcnow()` 弃用警告。
- 桌面壳：`cargo check` 通过。
- 前端与桌面生产依赖：`npm audit --omit=dev` 均为 0 vulnerabilities。
- 架构注册表：`GET /api/architecture/validate` 返回 `valid: true`、`errors: []`。
- 正常服务：后端 `/health` 正常；重复启动会因 8010 被占用而退出 1，不再假报成功。
- 浏览器工作台：讲义与练习、复习、学习任务、学习路径、学习画像、项目、设置均打开正确标题与主标题，控制台 0 warning/error。
- 真实 Tutor：完成五核只读观察、1 次工具调用、1 轮模型决策并流式形成有效回答，控制台 0 warning/error。
- 跨页面删除：服务端删除后，新页面不再显示该对话，控制台没有 404。
- Seeded demo：隔离数据库重建成功；`/api/demo/status` 为 `enabled: true, offline: true`；架构校验通过；`/demo` 进入复习工作台。
- `git diff --check` 与目录权威检查通过。

## Contract impact

- 唯一前端、会话分页、删除同步和启动脚本修复不改变五核或 `EvidenceEvent` schema。
- 同批学习事件改为顺序提交，只收紧既有事件时序，不新增写入路径。
- 同工作树内的学习路径检索改造将 registry 提升到 `2026-08-27.1`：精确读取、模糊解析、个人节点提案职责分离；个人节点仍需确认，路径自述不升级为掌握证据。
- 所有五核变化仍必须经过 `EvidenceEvent -> five_kernel_reducer -> KernelMutation -> KernelState -> Memory Graph`。
