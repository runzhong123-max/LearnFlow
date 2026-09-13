# 长尾验证交付摘要

run-03 全228条件及36形成快照完成，原始包落盘后独立重验通过；0网络、0模型、0源漂移。14个verifier负例测试通过。基线62fd197，实际Web Python3.14。没有修改生产或旧实验。

两个预算1800/3200的结果相同，分别保留完整分层表：

|后续干扰|default目标进候选|source目标进候选|default同条item目标+限定|source同条item目标+限定|各组严格空负控|各组时序首项|
|---:|---:|---:|---:|---:|---:|---:|
|4|10/10|10/10|7/10|9/10|3/3|2/2|
|64|10/10|10/10|6/10|8/10|3/3|2/2|
|256|8/10|10/10|6/10|7/10|3/3|2/2|

局部组件关闭的同item主指标（均为相关条件计数）：alias两组开启8/12→关闭0/12；唯一错拼default6/6→0/6、source4/6→0/6，歧义错拼开启/关闭均严格空6/6；时序两组12/12→6/12，损失全部来自最初查询，当前查询仍成功，时序首项同样12/12→6/12。

反例保留：词表外time to live两组均0/6；BFS别名在64/256历史下真实目标进入候选却未交付，实际返回了包含搜索/优先级词片段的二叉搜索树和CSS笔记；source在256条历史下514个文档触发fuzzy512上限，唯一错拼失败，default则成功。source对分离限定和尾部目标各由0/6提升到6/6，不能据此声称source处处更好。

全部180个目标适用条件中，path-only共同交付为0/180；未出现路径独自补齐主item缺失的情况。所有非Human head summary均无正文。head源引用可出现，但导航引用不补算正文交付。路径字段是识别原生SAME_SUBJECT后新增的次要诊断，不改变既定item主终点。

边界：12作者编写情境、13问题，不是12真实学生或自然长尾频率；历史长度和预算不是新独立样本。主要节点为Knowledge自述Fact，不是五核逐核消融或掌握效果。source同时改变4096候选扫描、原文及元数据预算；别名/错拼/时间局部关闭是组件整体作用，配对候选是否相同见aggregate。默认策略保持五核读取面和自然SAME_SUBJECT路径；无模型参与。

run-01：全228条件在环境形成前失败、0次读取，Roadmap唯一键问题；发现active Fact可同关卡跨session后在无性能可见时纠正错误session负控，保留learner/project/checkpoint三类污染。run-02：真实228读取，但66合法路径被误判未激活、8候选跟踪因大小碰撞被保守拒绝。两轮完整raw、事故原因和冻结评测源码均保留；run-03未改scenario/query/gold/policy。不得把run01未执行读取计入性能均值，也不得将run02完整性拒绝写成产品检索故障。

复现：使用具备当前Web后端依赖的Python，在仓库根运行 `python -m pytest -q evals/five_kernel_longtail`；再用 `python evals/five_kernel_longtail/run.py prepare --repo <repo> --output <new-empty-dir>` 与 `python evals/five_kernel_longtail/run.py execute --output <same-dir>`。只从保存制品复算用 `python evals/five_kernel_longtail/run.py reverify --output <run-dir>`，不加载生产/模型。
