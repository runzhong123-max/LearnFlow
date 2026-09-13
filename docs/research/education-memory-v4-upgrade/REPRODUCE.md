# 复现说明

成绩必须与具体源码、数据、模型和运行环境一起解释。正式运行使用工作树中的升级源码，基础提交为 `0d0802f34e1099dfc468a1ca77316c583870440f`；该提交本身不含本轮全部改动，逐文件 SHA 才是实际实验源码身份。最终本地集成提交另在交付记录中说明。

## 模型与数据

本轮使用 `thenlper/gte-small`，revision `17e1f347d17fe144873b1201da91788898c639cd`。从公开模型仓取得 [semantic-model-manifest.json](semantic-model-manifest.json) 中的 10 个推理文件，逐文件核对 SHA-256，并将该清单复制为模型目录下的 `learnflow_snapshot_manifest.json`。不要只准备权重文件；完整分词器是必要输入。

正式驱动会在开始与结束时复核文件，报告器还会检查实际运行中记录的组合模型身份 `88d0602e36126d904c5d4e15dbca817aee0e282abff8dc22a8d7b994473abe55`。文件清单校验通过不能替代实际模型执行核验。

教育数据来自仓库 `evals/computing_learner_profile/data`，由原有 frozen source 清单校验。LoCoMo 使用原始 `locomo10.json`，SHA-256 为 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`。原始对话不会自动复制到公开报告目录。

## 正式运行命令

从仓库根目录执行，使用一个全新的输出目录。以下路径变量由复现者指向已有环境、完整模型和数据：

```bash
HF_HUB_OFFLINE=1 \
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
TOKENIZERS_PARALLELISM=false \
"$EVAL_PYTHON" evals/education_memory_upgrade/run_suite.py \
  --repo . --python "$EVAL_PYTHON" \
  --model-path "$EVAL_MODEL_DIR" \
  --locomo-data "$EVAL_LOCOMO_FILE" \
  --output "$EVAL_OUTPUT_DIR" \
  --education-shards 4 --locomo-shards 10 --workers 6
```

默认即为 9 配置、1800/3200 两档预算、教育 1584 案例与 LoCoMo 1986 问题，每个条件一次。三个教育 split 都是作者已见数据；不能称为外部或未见测试。并发运行有资源争用，测得时延只能描述本次执行，不能据此排列生产性能。

本轮正式实验使用既有 Web Python 3.14.6 及 NumPy 2.5.1 / SciPy 1.18.1 的实际运行环境。另建的干净 Python 3.12 兼容环境使用 NumPy 1.26.4 / SciPy 1.17.1，仅用来验证可安装性和两端回归。两套环境的记录分别保留；不把干净环境的测试通过写成在那里重跑了整个正式矩阵。

## 审计与作图

驱动结束后先检查 `suite.json` 的状态、全部子进程退出码、源与模型漂移，再由报告器逐条审核 packet、plan、checks、formation 和条件集合。部分运行不能进入最终排名。不能通过删掉失败行、改评分分母或修改来源内容来取得有效报告。

自动报告与输出采用排他创建，已经存在的输出不覆盖。独立复核报告时，应复制完整原始运行到一个新的审计目录，并保留原始报告及其 hash；若报告器有修复，应同时披露新旧报告器身份。

```bash
"$EVAL_PYTHON" docs/research/education-memory-v4-upgrade/plot_results.py \
  --aggregate "$EVAL_OUTPUT_DIR/aggregate.json" \
  --output "$EVAL_FIGURE_DIR"
```

图中数字直接读取通过完整性核验的聚合结果，采用固定 0–100 色阶；行序不构成排名。探针主表是按探针数汇总的比率，配对区间是按任务族或对话聚类、等权重计算的差值，二者不能混为同一估计量。

## 本轮已完成制品

正式结果为 [aggregate.json](aggregate.json)，冻结计划与逐文件源码身份为 [suite.json](suite.json)，协议为 [PROTOCOL.md](PROTOCOL.md)。原始机器报告另存为 [machine-report.md](machine-report.md)，中文解读由 `build_report.py` 从聚合制品生成。

完整 110 文件、429,195,098 字节运行已复制到本仓本地 `evals/education_memory_upgrade/runs/formal-03/`，所有文件与原始运行 SHA 一致，其中 109 个文件受冻结制品清单校验。该目录由 `.gitignore` 排除；公开报告目录只包含统计、协议和索引，不能把这个部分副本当作完整原始运行。见 [归档收据](local-archive-receipt.json) 与 [发布边界](publication-manifest.json)。测试日志也保存在本地忽略目录，hash 见 [日志索引](validation-log-manifest.json)。

重建中文报告需要全新的报告输出目录：

```bash
"$EVAL_PYTHON" docs/research/education-memory-v4-upgrade/build_report.py \
  --aggregate "$EVAL_OUTPUT_DIR/aggregate.json" --output "$EVAL_REPORT_DIR"
```

后补的 24 案例、96 条件原生 Fact 源文探针在 `evals/education_memory_source_probe/` 独立保存；该试验不是主实验的补分，也不是新的未见教育测试集。

## 提交时的格式差异

暂存检查发现实验 CLI `evals/education_memory_upgrade/run_suite.py:169` 的一处尾空格。正式实验结束后仅移除了这个空格，Python AST 完全一致；其余 210 个冻结源码文件逐字节一致。为避免把提交源码冒充实验时的精确字节，保留 [格式差异回执](source-formatting-provenance.json) 和 [原脚本压缩快照](frozen-source/run_suite.py.gz)。需要与 `suite.json` 精确匹配时，在新的复现 checkout 中解压还原该单文件；正常重新运行则冻结提交版本的新 hash。原实验工作树、suite、成绩和制品清单均未改写。SVG 另做行尾空格清理，XML 结构及归一化属性相同，PNG 未改变。
