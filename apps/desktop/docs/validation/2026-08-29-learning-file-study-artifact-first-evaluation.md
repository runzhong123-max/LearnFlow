# 文件共学 Artifact-first 评测

## 触发样例

真实交互为：学习者在 `learning_file_study / selecting_learning_artifact` 中询问“什么是聚类，能做什么”。旧轨迹连续读取画像与工作区、搜索网页和视频、重复核验失败，最后仍在聊天里展开定义、应用、算法与资源菜单，没有交接完整讲义或练习。

## 失败模式

- Skill 意图漂移：文件驱动教学退化为开放资源策展和长篇聊天讲解。
- 工具面过宽：普通概念导入也能调用 Web/Video ACI。
- 产物缺位：正式 LearningTask 已存在，但没有复用其 `artifact_refs`，缺文件时也没有产生确认卡。
- 推荐越权：视频只有 `metadata_only`，最终回答仍声称“很适合”。

## 修正后的可检查合同

1. 初始聊天至多三句话，只给概念起点和用途。
2. Harness 读取当前正式 LearningTask 的 `artifact_refs`；已有文件直接提供打开卡。
3. 没有文件时复用 `generate_learning_files` 的确认策略，同时请求完整讲义和练习。
4. 未明确请求外部资源时，当前 Skill 不向模型暴露 Web/Video ACI。
5. `inspect_learning_video` 未达到 `content_inspected` 时，终态校验拒绝正向推荐。

## 自动化证据

- `frontend/server/agent-runtime.test.ts`
  - 复现模型尝试调用 `search_learning_videos`，验证 Harness 阻止并生成文件确认卡。
  - 验证已有讲义优先复用，不重复提出生成。
  - 验证 `metadata_only` 视频不能支持“推荐/适合”结论。
- `frontend/server/learning-task.test.ts`
  - 保持 `selecting -> reading -> practicing -> verification` 的稳定状态序列。
- `backend/tests/test_architecture_registry.py`
  - 验证注册表版本、工具绑定和生成清单无漂移。

## 边界

本次没有新增模型工具、第四类 Agent、EvidenceEvent 或 Kernel writer。生成、打开和阅读仍是零 Kernel target；只有正式练习提交后的 Attempt 可以形成 Knowledge / Practice 证据。
