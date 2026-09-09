# 默认预算描述性补测

教育 full / 2900 / 单次，共 1584 个原合成案例。没有追加 LoCoMo 或组件消融，不能混入 formal-03 的 12 × 2 教育矩阵。其他实际 policy 字段逐案例与正式 full 核对一致。

`descriptive-summary.json` 为实际计划、证据和动作统计；`validation-evidence.json` 记录四片执行结果、源 SHA、相同 policy 参数及同版 freshness v2 审计。最新失败评分的 138 个案例均生成诊断动作并引用最新合法来源，仍不代表教师认可或学生收益。原话未形成 Fact、69 例原题重做帮助等级与轨迹标注不同等既有缺口保留。

`run-metadata.json` 保存实际 CLI、时间、199 份驱动检查范围内的来源 SHA。复现时在新输出目录按四片相同参数运行冻结 `education.py`，再执行 `validation-evidence.json` 中的 freshness 命令。`summary-source.py` 是实际运行的单次汇总脚本原样快照；它记录原执行路径，复现时需将 ROOT 指向新 checkout，并把副本放到新 run 根目录运行，避免覆盖原制品。

逐条件指标、formation 与 freshness JSONL 均保留原始字节的 gzip。`storage.json` 提供输入、压缩与解压 hash。完整 packet/计划、数据库、日志保留在本地忽略的 runs；此处不包含这些原始内容或教师私密映射。
