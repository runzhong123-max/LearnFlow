# 交付与复现

最终代码目录：`/tmp/learnflow-interaction-validation-20260913/evals/five_kernel_interactions/`，已停止写入。仅此新目录需要集成；没有生产代码、旧评测或论文文件改动，没有提交/推送。产品基线为 `62fd197236c4852b93bdf4a835020f095f2e8bb1`。

最终完整运行：`/tmp/learnflow-interactions-run-02/`。14/14 案例完整执行，13/14 案例通过，79/80 主字段断言通过，全部来源门通过，基础设施错误0；进程 exit0 表示执行与完整性成立，不表示全部业务安全标准通过。219 个来源 SHA256 无漂移，原始 JSONL 重开复算一致。校验器43项回归通过，不计入14个原生案例。

必须一同保留 `run-01/`：该轮完整执行，但旧 verifier 把原生失败复习转入纠错后的 `original` 角色误判为来源错误，初版12/14不作正式通过率。两轮都含完整 harness-source 快照和制品 manifest。修正只按真实 RemediationCase 闭包接受该角色转换；同14案例、同80主断言、同生产代码重新执行。所有首轮原始失败保留，不作为额外独立样本。详情见新评测目录的 INCIDENTS.md。

## 复现命令

在复制后的仓库根目录，用已有项目后端依赖的 Python 执行：

```bash
python -B -m pytest evals/five_kernel_interactions/test_verifier.py -q
python -B -m evals.five_kernel_interactions.run --repo /absolute/path/to/checkout --output /tmp/learnflow-interactions-run-new
```

输出目录必须不存在，运行器不覆盖既有实验。本次实用解释器为 `/Users/a1-6/LearnFlow/backend/venv/bin/python`。使用内存 SQLite、离线子进程、固定 UTC 业务时钟；不需要模型、网络或任何真实学生数据库。实际运行依赖版本随 freeze.json 保存。

## 保留的真实失败

`relapse_invalidates_current_stability` 的冻结断言 `/lens/long_stable == false` 实际为 true。9月22日满足规则稳定条件后，9月29日再次真实提交错误答案，工作台 evidence_state 已为 none、短期 retention 已为 needs_review，排期也进入 remediation；但长期 Knowledge 的 `mastery["review:concept:1"].level` 仍为 stable，证据仍引用事件2和3。Practice 的旧 proof_chain 也保留。它揭示的是当前读取与未限定长期标记之间的不一致，不能说工作台仍错误显示稳定掌握。9月29日是提前自愿复习，原排期到期日为11月21日。

完整阶段表见 RELAPSE_STAGES.json；读者报告见 REPORT.md；本轮重算与哈希收据见 AUDIT.json；另有独立审阅者的 independent-audit.json。不要在整合时将13/14改写成“全部通过”，也不要称这14个人造情境为真实长尾分布或真实学生学习收益。
