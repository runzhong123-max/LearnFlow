# 结果制品索引

- `formal-03/`：最终完整矩阵，教育 38,016 条件、LoCoMo 27,804 条件。`REPORT.md` 是冻结评分器生成的分组表；解释、负结果与工程限制见仓库 `docs/competition/EDUCATION_MEMORY_V2_REPORT.md`。
- `formal-02/`：保留的修复前完整矩阵；含 192 个旧评分引用问题。`SOURCE_RECONSTRUCTION.md` 与恢复补丁可重建该次测量源码。
- `formal-02-freshness-v2/`、`formal-03-freshness-v2/`：同一校正后的事后审计；后者含逐案例配对汇总。没有实际评分动作的条件记为 NA。
- `formal-02-freshness/`：有已知缺口的初版事后审计及工具快照，只用于保存审计修订记录。
- `calibration/`：正式运行前的评分器校准证据。
- `default-budget-2900/`：产品默认预算的 1584 个教育 full 案例描述性补测，单独归档，不改变 formal-03 矩阵。

大型 JSON/JSONL 使用 gzip 保存原始字节。`analysis-storage.json`、`locomo-analysis-storage.json` 或 `storage.json` 记录压缩与解压 SHA；没有重新计算或删除失败行。可用 Python 标准库 `gzip.open(path, "rt")` 读取。若要对已归档制品重新调用 `report_results.py`，先将结果目录复制到新的临时目录，把两个 `*-analysis.json.gz` 解压为原 JSON 文件名，再向新路径生成报告。

`suite.json.source_commit` 是运行时的基线提交，实际未提交实现由逐文件 SHA 标识；`formal-03/final-source-check.json` 已核对 186 个冻结文件。原始 packet、计划、隔离数据库及教师私密映射只保存在本地忽略的 `runs/`，不在公开制品中。LoCoMo 不发布对话、问题或答案正文；其证据检索指标不等于官方问答成绩。

教师材料准备不代表已有教师评分。`formal-03/teacher-review-preparation.json` 记录最终真实计划导出和 reviewer-only 分发包来源；实际评分为 0，审核状态为 pending。
