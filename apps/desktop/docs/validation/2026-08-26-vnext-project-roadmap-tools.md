# vNext 项目关卡图与来源一致性验证

## 范围

- 项目 Tutor 专属 `read_project_roadmap / propose_project_roadmap`
- 空关卡图安全读取
- 已开始关卡锁定、未开始关卡版本化修订
- 项目来源在侧栏与所有项目对话之间共享
- 项目 Session 跨浏览器可见，本地消息缓存不再充当会话存在性权威
- 路线修订、任务取消与五核 EvidenceEvent 留痕

## 契约

- `roadmap_revised` 只归约到 structure；路线与来源均不产生掌握。
- 项目自由对话、关卡对话不获得路线 reader/proposer。
- 修订携带 `expected_revision`；服务端再次验证完整 DAG 和 locked checkpoint。
- 删除未开始关卡使用软归档；关联活动 LearningTask 通过 `learning_task_canceled` 留痕。
- 项目输入栏和项目面板复用正式项目 Source API，不创建 localStorage 来源权威。
- 项目文件夹从正式工作区恢复 Tutor、关卡和自由 Session，并按 `formalSessionId` 合并本地消息视图。

## 自动验证

- `backend/venv/bin/python -m pytest tests/test_vnext_projects.py tests/test_architecture_registry.py -q`
  - 17 passed
- `vnext/npm test`
  - 69 passed
- `vnext/npm run build`
  - TypeScript 与 Vite production build passed

完整仓库回归与浏览器交互检查在提交前再次执行，结果以最终任务报告为准。
