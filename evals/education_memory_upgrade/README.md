# Read-only memory upgrade evaluation

Read [PROTOCOL.md](PROTOCOL.md) before interpreting scores. The defaults retain the original 1584 education cases and 1986 LoCoMo questions, with 9 explicit configurations and budgets 1800/3200. No teacher or learner outcome score is invented.

Use an existing backend environment and the original local LoCoMo source. A fresh output directory is required:

```bash
LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH=/tmp/learnflow-gte-small-complete \
backend/venv/bin/python evals/education_memory_upgrade/run_suite.py \
  --repo . --locomo-data evals/joint_memory/runs/source/locomo10.json \
  --output /tmp/learnflow-memory-upgrade-formal \
  --education-shards 4 --locomo-shards 2 --workers 1
```

`--plan-only` freezes the exact planned matrix, code/data/model hashes and commands without running a condition. `--workers 2` or more permits disjoint shards to run concurrently and labels timings as affected by resource contention. The fixed model identity and public inference-file hashes are verified before and after execution; no model files are copied into result bundles.

The runner reuses the existing production drivers and independent scorer. It preserves raw packets/plans/checks, validates each exact condition and source hash, then emits `aggregate.json`, `REPORT.md`, compressed trials and per-condition diagnostics, plus an artifact hash manifest. A failed job or integrity check retains its files and cannot generate a valid formal ranking. A safety/quality gate failure in a complete education run is shown in the report and excluded from the descriptive priority groups.

To audit retained complete runs separately:

```bash
backend/venv/bin/python evals/education_memory_upgrade/report.py --results /tmp/learnflow-memory-upgrade-formal
```

Outputs are exclusive-create. Do not replace previous reports in place. Preserve any report-generation failure and reconstruct a fresh review directory if a presentation bug is corrected; disclose the report code hash separately from the frozen experiment source.

Pure-data compatibility and adversarial scorer checks, without product/model execution:

```bash
python3 -m unittest discover -s evals/education_memory_v2 -p 'test*.py'
python3 -m unittest discover -s evals/education_memory_upgrade -p 'test*.py'
```

`education_full_no_paths` disables output relation paths only. It does not remove the separate concept attachment. `education_full` names this round's combination, not a complete implementation of every method in the cited papers. LoCoMo remains evidence retrieval, not official answer accuracy. The raw LoCoMo text is retained locally; this runner does not publish it.
