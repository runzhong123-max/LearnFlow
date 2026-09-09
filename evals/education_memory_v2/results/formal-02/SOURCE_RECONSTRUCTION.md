# 修复前运行与源码重建

`formal-02` 是保留的修复前完整矩阵。教育 38,016 条件、LoCoMo 27,804 条件均完整，执行错误为 0，运行中源码漂移为 0。它包含已发现的旧评分选择问题，不能当作最终实现已通过时序语义验收的证据。

`suite.json.source_commit` 是运行开始时的 Git 基底提交；当时的升级实现尚未提交。因此实际测量源码以 `source_hashes` 的全部 186 个逐文件 SHA 为准，不能仅 checkout 该基底提交就声称复现了测量版本。

相对于包含本说明的最终提交，测量版本只差三份共享源文件。`restore-before-freshness-fix.patch` 保存了从最终源码恢复修复前源码的差分。在独立、干净的临时 checkout 中执行：

```bash
git apply evals/education_memory_v2/results/formal-02/restore-before-freshness-fix.patch
```

随后逐一重算 `suite.json.source_hashes` 中所有文件的 SHA，必须全部一致，再用其中记录的 CLI 在新输出目录重跑。不要在日常工作目录覆盖正在开发的实现。新增时序回归在修复前源码上预期出现失败；这正是本次保留的缺陷证据。

已检查补丁能匹配最终源码，并用保存的三份原始源码和其余现有源码组合验证 186 个 SHA 全部一致，记录见 `source-reconstruction-check.json`。原始轨迹留在本地忽略的 `runs/formal-02`；此目录不包含 LoCoMo 对话、问题或答案正文。后续的 `formal-03` 使用修复后的同一完整矩阵，前后结果分别保留。
