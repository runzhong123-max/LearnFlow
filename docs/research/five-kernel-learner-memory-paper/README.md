# 五核学习者记忆论文交付

论文题目：**面向计算机专业教育的五核学习者记忆建模与证据治理**。

正文围绕五核分别提供的能力及其与已有记忆、知识追踪和开放学习者模型的关系展开。包含综述、方法、实现、评价、完整结果、讨论、局限、数据声明及18项一手参考文献。DeepTutor 固定引用已核验的 v1，不虚填录用期刊。本文是完成的中文研究稿，尚未投稿；作者、单位、基金和期刊信息没有代填。

- [论文 PDF](five_kernel_learner_memory_zh.pdf)
- [可编辑 Word](five_kernel_learner_memory_zh.docx)
- [正文 Markdown](manuscript_zh.md)
- [补充材料 S1](SUPPLEMENT.md)
- [图形及来源 hash](figures/manifest.json)
- [参考文献与版本核验](sources/learnflow-five-kernel-literature.md)
- [BibTeX](sources/learnflow-five-kernel-literature.bib)

## 核心结论

五核的能力分别是学习位置、知识证据、当前支持条件、目标优先级和实践条件。其研究价值在于教育证据语义、统一权限链和实际消费约束，不能仅凭五个标签或更多上下文宣称优势。

新增15个原生能力案例全部通过，证明所列边界和消费者。既有768条真实模型响应则显示，资格注释的作用较稳定，五核分组的增量对条件与输出枚举敏感。严格主分数与事后归一同时报告，没有挑选更有利的一套。没有真实学生招募、新人工标注或新增模型调用，不能据此证明学习增益。

## 可复现性

正式模型实验的完整原始产物、失败开发记录和复现入口保持在 [既有反事实研究目录](../education-memory-counterfactual/REPRODUCE.md)。本稿不改旧数据和旧论文，不将其不同版本数字混合。

本轮核验运行基线为 `917b8a04e88c4f2afa7f72b477a127c3ef2249b7`。复现该历史运行时应使用此版本的产品源码，再加入本提交新增的 `evals/five_kernel_capabilities/`。运行前冻结实际源码 hash，不假定新版本与旧版本完全相同。

从项目根目录使用装有后端依赖的 Python，运行以下命令；输出目录必须不存在。

```bash
backend/venv/bin/python -B -m evals.five_kernel_capabilities.run \
  --repo "$PWD" --output /tmp/learnflow-native-reproduction-new

backend/venv/bin/python -m pytest -q -p no:cacheprovider \
  evals/five_kernel_capabilities evals/education_memory_counterfactual
```

原生核验使用一次性内存数据库，调用正式函数及事件网关，不执行网络模型调用；它不等于 HTTP 鉴权和 UI 端到端验收。主运行的原始数据位于 [native-02](native-capabilities/native-02/REPORT.md)。首次审计故障位于 [native-01](native-capabilities/native-01/REPORT.md)；失败时的8个评测源文件及逐字 hash 保存在 [原始审计与失败源码压缩包](native-capabilities/delivery-audit-and-failed-source.tar.gz)。

文稿构建使用 Codex bundled Python 的 `python-docx`、`reportlab` 和 `pdf2image`。先通过工作区依赖工具取得运行时路径，使用该 Python 执行 `build_figures.py` 和 `build_paper.py`。`render_paper.py --renderer <bundled documents/render_docx.py> --output-dir <new directory>` 调用同一运行时的 LibreOffice 与 Poppler，并通过临时 Fontconfig 只读加载本机中文字体，避免缺字。它不安装字体、不修改用户应用或受管运行时。Linux 等其他环境需要提供相应中文字体；这份构建脚本当前明确针对本次 macOS 环境。

图表使用固定的色盲友好配色、白底、实际轴值和分母，提供 PNG、SVG及矢量 PDF。`architecture`是说明图；`results`和`effects`直接读取既有冻结 aggregate，后者的区间仅作八个作者主题簇的探索性描述。

## 完成范围

**Contract impact：无。** 仅增加独立研究评测、论文与审计产物，未变更五核 schema、生产注册表、状态更新或消费者实现。

已执行：15项原生能力运行、源文件与产物 hash核验、独立原始记录复算、97项相关评测回归、文献核验、文档渲染及逐页视觉检查。首次原生审计失败和首轮字体渲染问题均在修复后重新验证，没有当作成功结果。

未执行：新增托管模型实验、全量产品后端回归、前端构建、浏览器或跨端最终消费验收、真实教育效果研究。本轮未修改这些产品模块，未据此宣称其验收通过。遵守本轮本地范围，不推送、不部署、不接触日常数据库。
