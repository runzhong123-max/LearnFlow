# 教育画像与通用会话记忆联合消融

本目录把计算机专业群的学习经历重放与LoCoMo的公开长会话检索放在同一份冻结协议下，**分别计分，不生成联合准确率**。

- [协议与精确消融边界](PROTOCOL.md)
- [数据来源、版本和许可证](SOURCES.md)
- [实验报告](REPORT.md)
- [运行入口和保真边界](harness.md)、[隔离环境](environment.md)、[判据](task.md)

教育侧使用1,584条合成轨迹、6组、两个预算；真实判题由已独立复算的答案映射为封闭候选后提交，真实事件链与worker产生记忆。它不验证原始自由回答判分或真实学生学习效果。完整原话和题目标题交付是不同强度的诊断探针，不是教学质量评分。

通用侧使用LoCoMo全部10段对话、1,986个问题；主比较full/recent_facts/no_memory三组。它测试真实检索器读取原文节点投影，不运行LLM问答或官方QA裁判。未激活的摘要/关系组仅在pilot作为负控制。13条无/坏引用、446条对抗问题及外部知识类的处理见报告，不能把空分母算作满分。

## 复现

已有Web后端虚拟环境与共享包即可，无新依赖安装。首先单独下载并校验公开数据；随后运行的实验子进程禁止网络及生产SQLite访问：

```bash
python3 evals/joint_memory/fetch_locomo.py --output evals/joint_memory/runs/source/locomo10.json
python3 -m unittest discover -s evals/joint_memory -p '*test*.py' -v
python3 evals/joint_memory/run_suite.py \
  --locomo-data evals/joint_memory/runs/source/locomo10.json \
  --output evals/joint_memory/runs/my-new-run
python3 evals/joint_memory/collect.py \
  --run evals/joint_memory/runs/my-new-run \
  --locomo-data evals/joint_memory/runs/source/locomo10.json \
  --output evals/joint_memory/results/my-new-results
python3 evals/joint_memory/report_tables.py \
  --results evals/joint_memory/results/my-new-results
gzip -n evals/joint_memory/results/my-new-results/education-analysis.json
```

每次输出目录必须全新；已有结果不可覆盖。默认教育按72任务族分4进程，通用按10对话分2进程；可减小shards参数降低资源并发，完整数据和实验条件不变。并行时延仅作描述，不是精密性能排名。

collect先校验全部case和条件集合、重复身份、形成记录和执行错误，再按两条轨道分别输出指标与按任务族/对话聚类的成对差值。结果中的数字字段不都越大越好，例如延迟和错误数；不能把这些列平均成总分。

report_tables只读取固定指标，单独生成LoCoMo有效主类1/2/4的表与配对区间，并将教育完整原话、题目标题探针分开汇总。机械全字段analysis的overall不用于替代这些分层结论。

教育全维度analysis行数较多，归档为无损gzip，全部维度和分母仍保留；可用`gzip -dc`查看，压缩前后hash与往返一致性记录在verification.json。

`runs/`保留本地完整packet、状态、操作、源文件快照与下载数据，不提交真实数据库或外部对话原文。版本化结果只保留不含对话正文的指标、source hashes与原始制品manifest。复现需要重新下载固定外部数据，SHA不符时拒绝运行。

Contract impact：无；仅增加独立实验工具与报告，不修改产品契约。本实验使用Web宿主；其他宿主的抽样检查必须与Web全量结果分开说明。
