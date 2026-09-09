# 教育记忆升级验证 v2

可执行的新版消融框架，复用冻结教育集与LoCoMo来源。旧结果完整保留。当前产品效果以实际运行制品为准；本目录的校准测试不代表真实学生收益。

- [协议和矩阵](PROTOCOL.md)
- [校准记录](CALIBRATION.md)
- [教师审核规则](teacher_review/RUBRIC.md)
- [旧数据来源与许可证](../joint_memory/SOURCES.md)

```bash
backend/venv/bin/python -m unittest discover -s evals/education_memory_v2 -p '*test*.py' -v
backend/venv/bin/python evals/education_memory_v2/education.py \
  --repo . --split development --limit 2 --variants full no_episodes no_bm25 no_memory \
  --budgets 1800 3200 --save-packets --output evals/education_memory_v2/runs/dev-pilot
backend/venv/bin/python evals/education_memory_v2/locomo.py \
  --repo . --host backend --dataset evals/joint_memory/runs/source/locomo10.json \
  --max-conversations 1 --max-questions 2 --output evals/education_memory_v2/runs/locomo-pilot
python3 evals/education_memory_v2/run_suite.py \
  --locomo-data evals/joint_memory/runs/source/locomo10.json \
  --output evals/education_memory_v2/runs/formal-01
python3 evals/education_memory_v2/collect.py \
  --run evals/education_memory_v2/runs/formal-01 \
  --locomo-data evals/joint_memory/runs/source/locomo10.json \
  --output evals/education_memory_v2/results/formal-01
python3 evals/education_memory_v2/report_results.py \
  --results evals/education_memory_v2/results/formal-01 \
  --output evals/education_memory_v2/results/formal-01/REPORT.md
python3 evals/education_memory_v2/export_review.py \
  --raw evals/education_memory_v2/runs/formal-01/education-00/raw.jsonl.gz \
  --output evals/education_memory_v2/runs/teacher-review-01
```

先在联网实验之外用旧fetch_locomo.py下载并核验固定源。runner默认教育4片、LoCoMo2片，可调并发与预先声明的variants。每个输出目录必须不存在；results只保留不含外部对话正文的数值、诊断计数与source hashes。完整原始packet和教师材料留在忽略的runs目录。所有评测使用现有后端Python运行时，不自动安装依赖。

教育12组/LoCoMo7组默认共65,820条件。正式汇总校验每case的实际声明条件集合；source变化、缺条件、执行错误或重复身份不会被静默略去。单次调用延迟不作受控性能结论。教师表生成后仍是pending，必须由真实审核者独立填写。
