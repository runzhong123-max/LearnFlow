# Harness

被测实现是当前共享 `learnflow_core` 和Web宿主的真实Python服务，不是新写的记忆算法或模拟规划器。

教育：已有教学输入/概念提交API函数 → record_event → reducer → Mutation → State/Fact → 真正的确定性memory worker → build_five_kernel_context → _scoped_planner_context → generate_learning_task_plan无模型路径。API函数接收隔离身份，HTTP鉴权中间件、浏览器、在线自然语言判题不在范围。

通用：build_five_kernel_context读取LoCoMo原始turn的中立节点投影；没有原生学习事件、生成摘要、LLM回答或官方QA裁判。

禁止接触gold/rubric/未来未见题；评测控制端持有这些资料，传给产品的参数和数据库只包括允许输入。差异和未适配行为逐条记录。产品源码全程不修改。

用户已经授权结合两类数据实际运行消融，本文件记录可复核边界；不是Harbor任务或人工审批证明。
