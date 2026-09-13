# 可选语义检索依赖与复现范围

默认安装 `learnflow-core` 仍要求 Python >=3.10，不安装或导入机器学习库。
BM25 使用标准库和既有查询规则。`memory-semantic` 是可选依赖组，只有显式启用
`mode="hybrid"` 才载入本地模型；缺包、模型不完整或编码失败会抛出
`SemanticModelUnavailable`，不会把词法回退报告成语义成功。

## 与宿主同时安装的依赖组合

`pyproject.toml` 的 `memory-semantic` 固定主要模型依赖；
[`requirements-semantic.txt`](requirements-semantic.txt) 固定在干净 Python 3.12.13 / macOS arm64
环境中实际解析的 42 个语义依赖及传递依赖。该清单由公开包的 `Requires-Dist`、环境标记和
实际解析结果计算，不包含从已有宿主虚拟环境借用的包，也不是整个宿主环境的 freeze。

关键版本如下：

| 依赖 | 兼容提案版本 | 约束依据 |
| --- | --- | --- |
| NumPy | 1.26.4 | 宿主 LangChain 0.3.0 / langchain-community 0.3.0 在 Python >=3.12 要求 `>=1.26,<2` |
| SciPy | 1.17.1 | 该版本要求 NumPy `>=1.26.4,<2.7`；原实验的 SciPy 1.18.1 要求 NumPy >=2 |
| HTTPX | 0.27.2 | 保留两端 requirements 的固定版本；Hugging Face Hub 1.26.0 允许 `>=0.23,<1` |
| PyTorch | 2.13.0 | 保留已执行语义检查的模型运行库版本 |
| sentence-transformers | 5.6.1 | 允许 NumPy >=1.20，满足此组合 |
| transformers / tokenizers | 5.14.1 / 0.22.2 | 固定已处理的分词器接口版本 |
| scikit-learn | 1.9.0 | 要求 NumPy >=1.24.1、SciPy >=1.10 |

完整 Web 与 Desktop requirements 加上该语义组合，在一个不通过 `.pth` 或其他路径注入旧宿主
site-packages 的全新 Python 3.12 环境中联合解析为 125 个包；随后按实际 wheel SHA-256
固定的清单安装。`pip check` 返回 `No broken requirements found.`。

## Python 与平台边界

- 干净宿主兼容组合的验证平台是 macOS arm64、Python 3.12.13、CPU 推理。该组固定版本不自动
  表示其他 Python、操作系统、CPU 架构或 GPU 后端已通过验证。
- 默认 core 的 Python >=3.10 契约不变。Python 3.10 不满足此固定 SciPy / scikit-learn 的
  Python >=3.11 元数据要求，安装 extra 会被依赖解析器拒绝。Python 3.11 的语义运行未验证；
  要复现本提案应使用 Python 3.12。
- 正式研究还实际使用了 Python 3.14.6，但使用的是另一个依赖组合。不能据此声明本文件中的
  宿主兼容 extra 在 Python 3.14 已通过安装或运行验证。
- PyTorch 的 Linux 包元数据会引入平台相关 CUDA 依赖。本文件不是 Linux CPU 或 GPU 的完整
  锁文件，也不保证其他平台能直接复用 macOS 的 wheel 或哈希。其他平台应独立解析并验收。
- 当前 provider 不增加单独的 Python 版本门禁；上述版本限制由依赖元数据和文档表达。
  不要绕过解析器安装不兼容包，再把能导入模块视为语义运行验收。

## 安装与离线模型

下面是从仓库根目录执行的复现模板。使用新环境，不覆盖已有 Web / Desktop 环境：

```bash
python3.12 -m venv /tmp/learnflow-semantic-repro
/tmp/learnflow-semantic-repro/bin/python -m pip install \
  -r apps/desktop/backend/requirements.txt \
  -r packages/learning-core/requirements-semantic.txt \
  './packages/learning-core[memory-semantic]'
/tmp/learnflow-semantic-repro/bin/python -m pip check
```

Web 宿主将第一个 requirements 路径替换为 `backend/requirements.txt`。本次联合解析同时
包含两端 requirements；上面的语义清单与两端声明兼容。安装 extra 本身不会下载模型。

模型应从官方完整快照准备，并在运行前记录文件哈希：

- 模型：`thenlper/gte-small`，英文模型；不据此承诺中文语义质量。
- 固定 revision：`17e1f347d17fe144873b1201da91788898c639cd`。
- [官方快照](https://huggingface.co/thenlper/gte-small/tree/17e1f347d17fe144873b1201da91788898c639cd)。
- `model.safetensors` SHA-256：`9a1eb90bbac323ea08aa5629b624fe6ae75db121b904799c2266a1e2c2de22d2`。
- 环境变量：`LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH` 指向含权重、配置、pooling 和完整词表的目录。
  仅有模型权重不够；缺词表可能使底层库构造退化词表，provider 会明确拒绝。

运行测试时显式设置：

```bash
export HF_HUB_OFFLINE=1
export LEARNFLOW_TEST_LOCAL_SEMANTIC=1
export LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH=/absolute/path/to/frozen-gte-small
export TOKENIZERS_PARALLELISM=false
export OMP_NUM_THREADS=1
export OPENBLAS_NUM_THREADS=1
export MKL_NUM_THREADS=1
```

分别在两个宿主目录、独立进程中设置 `PYTHONPATH` 指向仓库的
`packages/learning-core/src` 和相应宿主 backend。随后运行：

```bash
/tmp/learnflow-semantic-repro/bin/python -m pytest -q --disable-warnings
```

真实模型测试必须带 `LEARNFLOW_TEST_LOCAL_SEMANTIC=1`，并检查没有因为模型依赖缺失而跳过。
多进程评测使用 spawn，每个进程限制 CPU 线程；向量缓存只在各进程内生效。

## 已执行证据与研究环境的区别

此提案的干净环境位于 `/tmp/learnflow-memory-desktop-semantic-clean-venv`，未通过 `.pth`
读取任何旧宿主包。指定候选文件已执行 26 项测试，包含真实模型加载、零词法候选、窗口与公共
encoder 一致性、缓存及候选隔离；全部通过。随后在同一干净环境中依次执行两端完整回归：

| 检查 | 已执行结果 |
| --- | --- |
| 完整宿主与语义依赖联合解析、安装及 `pip check` | 125 个包联合解析；逐 wheel 哈希安装；无依赖冲突 |
| 真实模型候选测试 | 26 passed，0 skipped |
| Web 完整回归 | 1,138 passed，1 skipped，0 failed |
| Desktop 完整回归 | 1,158 passed，0 skipped，0 failed |

Web 的一项跳过是旧账户私有凭据 CRUD 被平台统一凭据取代的既有测试，与语义模型依赖无关。
完整日志与命令见 [`semantic-dependency-validation.json`](semantic-dependency-validation.json)。
这些回归与正式实验共享主机资源，耗时不作为排序依据或性能比较结果。

本轮依次存在三种环境，必须分开报告：

1. 正式实验运行库：Web Python 3.14.6，NumPy 2.5.1 等真实版本由实验 manifest 冻结。
2. 早期 Python 3.12 `.pth` 叠加验证：运行了 Desktop 1,158 项测试并通过，但 NumPy 2.5.1 /
   HTTPX 0.28.1 覆盖了宿主的声明约束。它证明了该叠加环境的执行结果，不是干净联合 lock。
3. 本提案的宿主兼容环境：全新 Python 3.12.13、NumPy 1.26.4、SciPy 1.17.1、HTTPX 0.27.2，
   完整宿主与语义依赖共同解析，`pip check` 通过。其回归不替换正式实验的版本或成绩。

运行中的模型组合身份位于 `CandidateRanking.diagnostics.semantic_model_sha256`，它包含
实际配置、分词器、float32 权重、pooling 和分段版本。该值不同于权重文件或依赖清单的哈希；
即使模型身份相同，也不能把两个 Python / NumPy 环境称为同一实验运行库。

详细临时证据包括 `learnflow-memory-semantic-clean-resolve.json`、
`learnflow-memory-semantic-clean-install.json`、`learnflow-memory-semantic-clean-runtime.json`
和 `learnflow-memory-v4-dependency-note.json`；主任务应将需要长期保存的记录纳入正式报告资产。
本次未更改用户已有虚拟环境、冻结模型、日常数据库或已安装应用，也没有执行桌面打包验收。
