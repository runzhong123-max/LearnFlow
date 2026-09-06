# Teaching Delivery 与视频 Harness 验证记录

日期：2026-08-27
注册表：`2026-08-27.8`

## 验收范围

- Teaching Contract 向后兼容规范化、硬错误门禁、一次修订上限与非空 fallback。
- Checkpoint 既有对象的确定性 `delivery_readiness` 投影。
- 两级视频 ACI 的离线 fake adapter、当前轮候选约束、字幕时间点和 metadata-only 降级。
- Action Board、Capability owner、Tool/Skill/Workbench 分类与生成清单无漂移。

## 已执行结果

| 检查 | 结果 |
|---|---|
| `backend/venv/bin/python -m pytest -q` | 204 passed |
| `frontend/npm test` | 134 passed |
| `frontend/npm run build` | 通过，TypeScript 与 Vite production build 成功 |
| `git diff --check` | 通过 |

后端现有测试仍报告 Python/SQLAlchemy/FastAPI 的弃用警告，本次没有新增失败。视频实时能力另以只读实测确认 Bilibili 搜索可返回 BV 号、作者、时长和播放量，YouTube 搜索可返回元数据与字幕可用标志；自动化回归不依赖网络。

## 关键断言

- 不可解析契约、非法来源引用、scope 越界或答案泄露标记会进入 `fallback_ready`；即使传入非空正文也不能绕过门禁。
- fallback 至少包含目标、核心事实、最小示例、下一步和缺口，并固定 `mastery_inference=false`。
- 成熟度按 `outline_only -> content_ready -> guided_learning_ready -> practice_ready -> verification_ready` 单向累积；它不读取或覆盖学习者 `learning_status`。
- `inspect_learning_video` 拒绝非本轮候选 ID；取得字幕时返回时间点，取不到时返回 `metadata_only/asr_required`。
- 视频搜索、字幕核验与观看均不创建 EventContract、不写五核、不形成 LearningAttempt。
