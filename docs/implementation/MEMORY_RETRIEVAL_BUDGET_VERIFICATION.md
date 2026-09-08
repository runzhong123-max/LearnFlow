# 完整记忆检索升级验收

> 历史固定回归记录。后续已完成推送、部署与 35 类扩展实验；当前比赛展示请优先引用[扩展消融报告](../competition/MEMORY_ABLATION_REPORT.md)。下文 100% 仅适用于原 14 类固定回归，不能代表扩展场景。原始运行数字和当时未部署状态保留供追溯。

日期：2026-09-08。共享核心 `0.2.2`；策略 `relevance-budget.v1`；Web / Desktop registry `2026-09-08.5` / `2026-09-08.5-desktop`。实现与兼容性见 [升级说明](MEMORY_RETRIEVAL_BUDGET_UPGRADE.md)。

## 固定回归实验

保留原 1.1 协议与评分器：12 条合成轨迹、14 类查询、6 组消融、2 档预算、每条件重复 3 次。每端 168 条查询、2,016 条条件、6,048 次检索；两端共 12,096 次。重复次数和两个宿主不作为独立样本扩充。

新旧 fixture + gold SHA-256 完全相同：
`bb5b8f2ac85ea2afdc34cbf49b76e138d75b927d865b523c641dc261b04fffbc`。

Web 完整系统前后对照：

| 指标 | 旧版 / 2,800 | 升级 / 2,800 | 旧版 / 5,600 | 升级 / 5,600 |
|---|---:|---:|---:|---:|
| 必要证据平均召回 | 96.59% | 100.00% | 100.00% | 100.00% |
| 必要证据全部找齐的查询比例 | 93.18% | 100.00% | 100.00% | 100.00% |
| 严格 gold 证据精确率 | 12.06% | 16.42% | 11.64% | 13.52% |
| 平均上下文 token 估算 | 2,716.98 | 2,364.10 | 4,414.45 | 3,845.30 |
| 检索延迟中位数（毫秒） | 16.80 | 20.84 | 14.81 | 18.23 |
| 检索延迟 p95（毫秒） | 23.99 | 30.31 | 19.97 | 23.15 |

2,800 档上下文用量减少 12.99%；5,600 档减少 12.89%。2,800 档新增约 4.04 ms 的检索中位延迟，不能称为检索加速。前后为独立时段运行，有机器负载差异；两个宿主使用 Python 3.14 / 3.12，不比较它们的延迟优劣。

升级完整系统在 12 个依赖关系案例、12 个八项汇总案例中均找齐必要证据。升级后的仅事实组在 2,800 档仍为 98.86% 平均召回、90.91% 全部找齐，汇总场景仍少一项。这支持保留摘要层并改进读取，不能推出摘要在所有任务中更优。

所有基于证据的指标仅统计有 gold 的查询（每轨迹 11 条，合计 132 条）；其余为 Human 适配与无覆盖控制。严格精确率会把不属于该题必要 gold 的背景内容算入分母，因此目前仍显示明显的背景冗余。

原无覆盖模板仍可能因“学习/证据”等弱词项返回背景，empty-on-uncovered 仍为 0。新增零词项匹配回归通过，并不等于解决自然语言拒答或全部长尾问题。本轮没有在反复调参中建立独立保留集；100% 是固定回归集结果，不是真实用户总体准确率。

## 双端与边界审计

`compare_runs.py` 已实际执行并通过：

- 2,016 个配对条件的非计时结果一致；首条轨迹的完整 ContextPacket 审计快照一致。
- 测试范围内越权/敏感泄漏/证据等级变化：0。
- 超预算：0；重复运行不稳定：0；网络尝试：0。
- 缓存重建与缓存读取的已核对选中节点、可见证据、历史证据、路径数量和 token 一致。
- SQLite 只访问驱动创建的临时数据库；未打开日常学习数据库。

额外开发回归采用独立英文场景和不同数据结构，每端 9 个参数化用例，包含超过 240 个近期主题记录、90 条支持边、纠正与依赖并存、同前缀不同尾部、辅助与独立证据、无关热摘要、scope/答案/人因/撤回/瞬时状态过滤。这些属于开发回归，不冒充保留测试集。

## 实际检查记录

集成到主工作区后重新验证（主分支同期已有其他功能提交，因此数量高于隔离基线）：

| 检查 | 结果 |
|---|---|
| Web 后端完整 pytest | **778 passed, 1 skipped**，135.04 s |
| Desktop 后端完整 pytest | **831 passed**，139.70 s |
| Web 前端 `npm run test:profile` | **28 passed** |
| Desktop 前端 `npm run test:profile` | **27 passed** |
| 两端 `npm run build` | **通过** |
| 跨端共享契约检查 | **通过**：同源 6 个 Python 模块、25 个 API、4 个 TS 源、148 个共同事件 |
| 消融评分器/隔离测试 | **7 passed** |
| 差异空白检查 | **通过** |

Web 唯一跳过是仓库既有的账户私有密钥 CRUD 测试，原因是产品已采用平台统一凭据；没有新增跳过或删除关键断言。既有 datetime 弃用和前端大 chunk / 动态导入警告仍存在。

隔离 worktree 首轮亦执行完整后端回归（715 passed + 1 skipped / 740 passed），并执行两端前端相关测试与构建。初始新增边界测试发现“第二条必要关系遗漏”和“概念附件绕过过滤”，修复后定向 36 项通过，再执行上述最终全量检查。

## 离线 demo

复用原 `start.sh demo` 流程的临时副本，仅固定隔离 worktree 根目录、替换独立 PID/日志路径并关闭自动打开浏览器，避免停止或覆盖日常实例；运行时复用已安装的 Python 3.12。没有修改正式启动脚本。

- 隔离数据库播种完成，`/api/demo/status`：enabled=true。
- `/api/architecture/validate`：valid=true。
- `/health` 正常；`/review`、`/demo` 返回 HTTP 200 HTML（仅入口检查，不等于浏览器交互验收）。
- 用隔离 demo 账号通过真实 HTTP 读取 `/api/learner-state/context`：ContextPacket v2、`relevance-budget.v1`、answer_free=true，预算 2,900，实际估算 1,221，2 个节点。
- 最初受 sandbox 限制不能绑定 loopback，获自动审批后成功运行；不是应用逻辑失败。
- 未执行人工逐屏的完整演示交互；纠错/复习行为由两端完整后端回归覆盖。未打包/安装桌面应用，未调用在线 LLM，未部署或迁移真实数据。

## 复现与交付

```bash
backend/venv/bin/python scripts/evals/memory_retrieval/run_ablation.py --output /tmp/memory-new-web
apps/desktop/backend/venv/bin/python scripts/evals/memory_retrieval/run_ablation.py --host "$PWD/apps/desktop/backend" --output /tmp/memory-new-desktop
python3 scripts/evals/memory_retrieval/compare_runs.py --baseline /path/to/frozen-web-v1 --web /tmp/memory-new-web --desktop /tmp/memory-new-desktop --output /tmp/memory-comparison
backend/venv/bin/python -m pytest scripts/evals/memory_retrieval/test_ablation.py -q
```

本次完整原始实验保存在本地交付目录 `memory-upgrade/`，包含新旧汇总、两端逐条件输出、fixture/gold、内容快照、审计、demo smoke 和源文件 hash。实验运行基线为隔离 worktree 的 `bd1d92e` 加任务补丁，运行实现 SHA-256：
`8318a21d947d7032a8379f7bab51dee2e3cd20f061a20cab3b453ccdf73f07db`。
集成后共享检索和两端概念图过滤实现逐文件核对相同；最终集成另做完整回归。Git 提交只包含源码、协议、测试和文档，不包含数据库、生成结果、环境、缓存或日志。本轮仅本地交付，不推送、不部署。
