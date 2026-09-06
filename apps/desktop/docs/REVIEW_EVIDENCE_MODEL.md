# 复习证据、熟练度与记忆模型

## 一句话契约

学习任务只负责把已验证题目交给复习；复习通过主动检索产生 `LearningAttempt` 与 `EvidenceEvent`；五核保存可追溯事实；熟练度和 D/S/R 只是可重建的解释与排序投影，不是第二套掌握权威。

```text
LearningTask verify
  -> 已判分 Attempt
  -> ReviewSchedule
  -> /review 主动检索
  -> review_attempt_evaluated
  -> five_kernel_reducer
  -> Knowledge（理解、误解、保持）+ Practice（独立性、迁移、复习历史）
  -> 熟练度 / D-S-R 重投影
```

## 科学模型与工程取舍

`concept-proficiency-v1` 使用五个可解释维度：作答可靠性 35%、当前可提取性 20%、独立完成 20%、变式迁移 15%、间隔稳定性 10%。原始得分还受确定性证据上限约束：只有辅助成功最高 40，一次独立成功最高 65，没有独立变式最高 80，少于两次间隔复测最高 88，近期遗忘最高 72。因而一次答对、带提示成功和原题重做不能伪装成稳定掌握。

记忆状态采用 D/S/R 词汇：Difficulty 表示当前提取难度，Stability 表示预计仍有 90% 可提取率的天数，Retrievability 表示当前可提取概率。冷启动公式为：

```text
R(t, S) = (1 + factor * t / S)^(-0.5)
factor = 0.9^(1 / -0.5) - 1
```

所以当 `t = S` 时 `R = 0.9`。当前 `S` 来自 `review-policy-v1` 的 1/3/7/14/30/60 天阶梯；它明确标记为 `cold_start_schedule_proxy_not_user_trained`。积累足够的时间戳、作答、辅助、变式和遗忘日志后，才能离线拟合人群或个人参数并以离线评估替换冷启动值。模型不得在线自行改写评分门槛。

研究依据：

- Cepeda 等的间隔效应元分析说明最佳间隔依赖目标保持时长，不存在一条适合所有人的固定“艾宾浩斯百分比表”。
- Roediger 与 Karpicke 的测试效应研究支持使用主动检索，而不是把重复阅读当作掌握证据。
- Settles 与 Meeder 的 Half-Life Regression 说明遗忘参数应由真实时序日志训练。
- Ye、Su、Cao 的调度研究说明个体化排程需要记忆状态、日志和明确优化目标。
- FSRS 的 D/S/R 形式被用作状态表达参考；当前实现不是已训练 FSRS。

来源 URL 固化在 `review_proficiency.py::RESEARCH_SOURCES`，并在复习页面中可检查。

## 数字之外的记忆

每个复习项同时投影带 provenance 的具体记忆：

- `misconception`：由 `RemediationCase` 的错误分类和误解标签产生；
- `insight`：纠错闭环后真正有效的讲法，或学习者明确写入的启发；
- `strength`：无提示独立完成、独立变式迁移等可核验表现；
- `support`：学习者明确指出的无效讲法；
- `question`：仍待解决的问题。

学习者手写反思进入 `review_reflection_recorded`，固定携带 `user_self_input`、`verification=unverified`、`mastery_inference=false`、`correctable=true`，再经 reducer 写入 Knowledge 的概念历程。它可以帮助下一次教学，但不会升级掌握。

## Agent 工具边界

`review_context_reader` 是 Tutor 的只读感知工具。它只返回答案隔离后的到期项、熟练度、D/S/R、具体记忆、学习任务引用和 Knowledge/Practice 投影。`review_proficiency_projector` 是服务端确定性投影，不向模型开放。`review_reflection_gateway` 只接受学习者显式操作并走统一事件入口。

Tutor 可以根据这些观察解释“为什么现在复习”和“下一条最有价值的证据”，但不能决定分数、判题、间隔、掌握或长期记忆。工作流有明确终止条件：提交后确定性判题；失败进入纠错；通过后重排到期；跳过、延期、暂停只改变运行状态。
