# Programming / algorithms / databases 题族作者说明

这批数据由项目内原创合成题组成，不含真实学生记录。覆盖 24 个不同题族、72 道探针；programming、algorithms、databases 各 8 族、24 题。每个领域按 foundation 2 族、intermediate 4 族、integrated 2 族分布。每族包含 base、near_transfer、delayed_transfer 三题，以及领域化补救、独立证据后的下一步项目任务、返回锚点和两个可区分的目标。`source_basis: ["cs2023"]` 仅表示课程范围对齐；不表示 CS2023 编写或审核了这些题。

## 编写假设与证据边界

- 输入、查询、执行顺序和输出序列化约定写在 artifact 中，使用小规模封闭数据，不需要网络、外部服务或已有数据库。
- Python 问题以 Python 3 语义为准；字符计数是 Unicode 码点，不等同于字素簇。数据库问题明确采用 SQLite 语义，包括 NULL、UNIQUE、窗口函数和保存点行为。
- 算法题的状态、端点协议、有限库存、队列仲裁和不可达值均在题面定义，避免把未写明的约定当评分依据。
- 每个探针的迁移改变至少一个边界、输入结构或计算目标，例如别名到浅/深复制、条件保护到零值回退、半开区间到闭区间再到带权优化、唯一可达节点到有界路径行计数。它们不是仅替换名字或常数的复本。
- `delayed_transfer` 是将来轨迹生成器安排延时验证时使用的题目角色。单独的题库文件并不证明已经经过时间延迟、用户独立完成或产生学习效果。
- correct_response 和 incorrect_response 是合成学生回答模板。计算校验能证明前者符合题设、后者不符合题设，不能证明错误答案唯一、错误认知普遍存在，或学习者确实持有此误解。
- 补救活动含支架撤除和独立重试，但活动完成本身不应升级为独立成功。next_activity 需要独立证据；原题重做、辅助成功、模型生成内容都不构成稳定掌握或变式迁移证据。
- 教师审核状态仍是 pending。本批不运行 LearnFlow 产品、不调用模型，也不做记忆或规划消融实验。

## 已实际执行的校验

在 2026-09-08 执行：

```bash
python3 /private/tmp/learnflow-computing-dataset/foundations_check.py --catalog /private/tmp/learnflow-computing-dataset/foundations.json
python3 /private/tmp/learnflow-computing-dataset/foundations_check.py /private/tmp/learnflow-computing-dataset/foundations.json
```

两种调用均成功，实际逐题检查 72 个唯一 oracle_id。stdout JSON 的 `checked_oracle_ids` 完整列出本次成功检查的 ID，每题同时检查：

1. artifact 含与 oracle_input 完全一致的结构化题目输入；SQL 题另核对查询文本存在。
2. 独立重新计算所得结果与保存的 correct_response 一致。
3. 保存的 incorrect_response 与重新计算所得结果不同。

总计 72 次正确答案比较、72 次错误答案比较，另有 72 次输入与题面一致性检查。所有 72 题均标记 executable，无 reasoned_draft 题。脚本没有把硬编码答案串当计算依据，也没有对 Python 题面使用 eval/exec。

各领域计算方式：

- Programming 24 题：有限对象引用操作器、divmod 及乘加/余数约束、默认容器状态模型、真实短路/异常/finally 行为、Unicode 标准化与 UTF-8 编解码、csv.DictReader、二进制长度与校验和运算。
- Algorithms 24 题：bisect 独立核对手写二分题；稳定排序与严格逆序对交叉核对插入移动；简单路径枚举核对 BFS；Bellman-Ford 核对非负最短路；前驱消除核对拓扑仲裁；全子集枚举核对区间目标；有限计数组合核对零钱库存；有限探测表模拟核对墓碑删除。
- Databases 24 题：每题创建独立 SQLite `:memory:` 库并执行真实查询/事务/约束操作。SQL 使用进度预算、长度/行数上限和 authorizer，禁止 ATTACH/DETACH/PRAGMA/外部读写扩展等；无持久数据库。

实际运行环境为 Python 3.14.6、SQLite 3.53.4。Python 对示例语义所需的 finally-return 发出 SyntaxWarning（会覆盖待传播异常）；进程仍退出 0，stdout 保持合法 JSON。这条警告不是产品运行结果，也不应从报告中改写为失败或静默忽略其教学含义。

额外执行一轮结构校验，确认完整必需字段、各领域题族数、题目顺序、2–4 个先修项、每族不同目标、三题的题面/输入不同及各领域难度分布。

另在临时副本分别做三种反向突变，并逐次运行 `--catalog`；均得到非零退出码和 AssertionError：

- 将第一题正确回答改为 null；
- 将第一题错误回答改成正确回答；
- 只改变第一题 oracle_input，保留旧 artifact。

这些反向检查证明脚本会拒绝上述不一致，不等于穷尽校验器的所有缺陷。

当前 foundations.json SHA-256：`32606b8d962f62c6cad7928549de5f9598c3f2fb8e1040627453d59368b60560`。

## 待审内容与适用限制

- Python 展示代码未作为任意程序执行；独立 oracle 依据题目结构化输入进行运算。部分 artifact 是有限伪代码或函数片段，不能声称已通过整段代码编译/执行验证。题面代码、自然语言解释与计算模型的语义对应仍需课程人员审核。
- 自动校验没有测量题目难度、阅读负荷、内容效度、补救有效性、延时保持或跨人群公平性。72 道小题不能独立覆盖三个领域的完整课程。
- 暂不提供自然语言答案评分器；示例回答使用中文前缀加 JSON，使参考输出可精确核验。日后对自由作答进行判定，需要单独验证等价表达和部分得分规则。
- 转移题共享族内能力，但题间难度没有经真实学生标定；不同学习经历不应只因探针 id 或合成目标字段而被判定成功。
- 题目答案与补救建议是评估侧材料。后续生成学生可见内容时，应只选 task_prompt、当次 probe.prompt/artifact 等必要字段，避免把正确答案、错误假设、目标推荐或后续题泄露给被测系统。
