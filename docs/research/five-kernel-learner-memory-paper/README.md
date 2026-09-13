# 五核学习者记忆论文交付

论文题目：**面向计算机专业教育的五核学习者记忆建模与证据治理**。

正文围绕五核分别提供的能力、它们与学习路径/学习任务/复习工作台的分工交互，以及长尾任务的能力边界展开。包含综述、方法、实现、评价、完整结果、讨论、局限、数据声明及18项一手参考文献。DeepTutor 固定引用已核验的 v1，不虚填录用期刊。本文是中文研究稿，尚未投稿；作者、单位、基金和期刊信息没有代填。

- [论文 PDF](five_kernel_learner_memory_zh.pdf)
- [可编辑 Word](five_kernel_learner_memory_zh.docx)
- [正文 Markdown](manuscript_zh.md)
- [补充材料 S1–S3](SUPPLEMENT.md)
- [图形及来源 hash](figures/manifest.json)
- [参考文献与版本核验](sources/learnflow-five-kernel-literature.md)
- [BibTeX](sources/learnflow-five-kernel-literature.bib)
- [教学对象交互的源码证据](sources/object-interaction-evidence.md)
- [对象交互验证报告](interaction-validation/delivery/REPORT.md)
- [长尾读取结果与失败分析](longtail-validation/SYNTHESIS.md)

## 核心结论

五核的能力分别是学习位置、知识证据、当前支持条件、目标优先级和实践条件。其研究价值在于教育证据语义、统一权限链和实际消费约束，不能仅凭五个标签或更多上下文宣称优势。

正文3.8和图2专门解释五核、业务对象与工作台：个人确认路线部分存于Structure并关联Value；LearningTask管理任务生命周期；ReviewSchedule管理复习排期；零核目标操作只保留审计，实际学习证据另经正式链写回。不能把任务完成、复习到期或延期当作掌握证据。正文3.9、4.6–4.7及补充结果将对象交互和长尾来源交付分开验证。

既有15个原生能力案例全部通过，证明所列边界和消费者。既有768条真实模型响应则显示，资格注释的作用较稳定，五核分组的增量对条件与输出枚举敏感。严格主分数与事后归一同时报告，没有挑选更有利的一套。新增研究不招募真实学生、不增加教师标注或托管模型调用，不能据此证明学习增益。

本次对象交互14/14完整执行，13/14情境通过，79/80主断言通过。保留真实失败：再次复习答错后工作台与短期状态已降级，长期Knowledge仍保留stable。长尾组完成228次真实读取和36份形成快照，全部完整性检查通过；两预算下，4/64/256条干扰的默认目标与限定共同交付为7/10、6/10、6/10，原文配置为9/10、8/10、7/10。原文配置在最长历史的错拼情境退化，不能称全面领先。详细分母、组件开关、词表外失败与前两轮驱动/核验器修订均公开。

## 可复现性

正式模型实验的完整原始产物、失败开发记录和复现入口保持在 [既有反事实研究目录](../education-memory-counterfactual/REPRODUCE.md)。本稿不改旧数据和旧论文，不将其不同版本数字混合。

十五项能力核验的历史基线为 `917b8a04e88c4f2afa7f72b477a127c3ef2249b7`；本次交互和长尾补充基线为 `62fd197236c4852b93bdf4a835020f095f2e8bb1`。复现应使用相应版本产品源码，再加入该组冻结的评测源码。运行前保存实际源码 hash，不假定新版本与旧版本完全相同。历史审计优先核对冻结版本，当前已变文件单列，不将正常产品迭代篡改为旧实验的源码漂移。

从项目根目录使用装有后端依赖的 Python，运行以下命令；输出目录必须不存在。

```bash
backend/venv/bin/python -B -m evals.five_kernel_capabilities.run \
  --repo "$PWD" --output /tmp/learnflow-native-reproduction-new

backend/venv/bin/python -m pytest -q -p no:cacheprovider \
  evals/five_kernel_capabilities evals/education_memory_counterfactual
```

原生核验使用一次性内存数据库，调用正式函数及事件网关，不执行网络模型调用；它不等于 HTTP 鉴权和 UI 端到端验收。主运行的原始数据位于 [native-02](native-capabilities/native-02/REPORT.md)。首次审计故障位于 [native-01](native-capabilities/native-01/REPORT.md)；失败时的8个评测源文件及逐字 hash 保存在 [原始审计与失败源码压缩包](native-capabilities/delivery-audit-and-failed-source.tar.gz)。

新增研究在对应基线中执行，输出路径必须不存在：

```bash
backend/venv/bin/python -B -m evals.five_kernel_interactions.run \
  --repo "$PWD" --output /tmp/learnflow-interactions-reproduction-new

backend/venv/bin/python -B -m evals.five_kernel_longtail.run prepare \
  --repo "$PWD" --output /tmp/learnflow-longtail-reproduction-new
backend/venv/bin/python -B -m evals.five_kernel_longtail.run execute \
  --output /tmp/learnflow-longtail-reproduction-new

backend/venv/bin/python -B -m pytest -q -p no:cacheprovider \
  evals/five_kernel_capabilities evals/education_memory_counterfactual \
  evals/five_kernel_interactions evals/five_kernel_longtail
```

交互正式结果保存在 `interaction-validation/run-02/`，首轮及完整harness快照保留于 `run-01/`。长尾正式run03位于 `longtail-validation/`，前两轮位于其 `failed-run-01/`、`failed-run-02/`。归档中的路径、Python与HEAD记录原运行环境；复现时需要使用相应冻结源码，不能按本机临时路径是否仍存在判断证据是否有效。`audit_paper.py` 从已交付原始字节复算并校验正文表格。

文稿构建使用 Codex bundled Python 的 `python-docx`、`reportlab` 和 `pdf2image`。先通过工作区依赖工具取得运行时路径，使用该 Python 执行 `build_figures.py` 和 `build_paper.py`。`render_paper.py --renderer <bundled documents/render_docx.py> --output-dir <new directory>` 调用同一运行时的 LibreOffice 与 Poppler，并通过临时 Fontconfig 只读加载本机中文字体，避免缺字。它不安装字体、不修改用户应用或受管运行时。Linux 等其他环境需要提供相应中文字体；这份构建脚本当前明确针对本次 macOS 环境。

图表使用固定的色盲友好配色、白底、实际轴值和分母，提供 PNG、SVG及矢量 PDF。`architecture`和`object_interaction`是说明图；`results`和`effects`直接读取既有冻结 aggregate，后者的区间仅作八个作者主题簇的探索性描述。新增读取图也直接取保存的聚合结果，不绘制虚构独立重复的误差棒。

## 完成范围

**Contract impact：无。** 仅增加独立研究评测、论文与审计产物，未变更五核 schema、生产注册表、状态更新或消费者实现。

已执行：历史15项原生能力及768模型响应的保存数据核验；本次14个对象交互情境、228次长尾读取；所有来源与产物hash核验、独立原始记录复算；集成后的154项评测回归；学习任务、复习、学习者状态及架构注册表63项产品回归；文稿渲染与逐页检查。154项包含旧97项、新交互43项和新长尾14项。实验失败不因验证器测试通过而被写成成功；所有故障轮次均保留。

未执行：新增托管模型实验、全量产品后端回归、前端构建、浏览器或跨端最终消费验收、真实教育效果研究。本轮只改评测与论文，未据此宣称无关产品模块验收通过。遵守本轮本地范围，不推送、不部署、不接触日常数据库。

## 2026-09-13 后续工程升级（与原论文结果分开）

可检查来源、反向关联与当前复习资格已实现；精确代码提交 `23fcb41` 的原 14 场景复测达到 14/14、80/80 项字段断言。原论文 13/14 的结果和冻结数据保留，不改写旧实验。新结果说明该失效问题已修复，不代表长尾排名或学生学习收益提高。详见[升级验收记录](../../validation/2026-09-13-memory-evidence.md)与[最终原始实验](experiments/memory-evidence-acceptance-20260913/REPORT.md)。论文 PDF/DOCX 本轮未重排。
