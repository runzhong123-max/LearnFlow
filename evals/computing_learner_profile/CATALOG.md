# 任务族目录

本表列出72个任务族，每族3道题和22种合成学习经历。层级为作者建议，未经过学生难度标定；教学标签均待教师审核。

## 程序设计

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| programming_binary_packet_validation | 解析带长度与校验和的设备报文 | integrated | 按指定字节序读取长度，检查总长与模256校验和，并拒绝不完整报文。 | development |
| programming_csv_validation | 对库存导入文件进行规范化汇总 | integrated | 按照CSV语法解析行、规范化键、汇总合法数量并报告拒绝的数据行序号。 | development |
| programming_default_argument_lifetime | 修复批处理函数的跨次状态残留 | intermediate | 区分函数定义时创建的默认列表、显式传入列表与None哨兵每次新建列表。 | holdout |
| programming_finally_control_flow | 审核导出任务的资源清理与错误传播 | intermediate | 区分finally清理、副作用日志与return/exception被覆盖的控制流结果。 | development |
| programming_reference_ownership | 排查预处理列表互相污染 | foundation | 画出引用关系并准确给出赋值、浅复制和深复制后的嵌套列表内容。 | development |
| programming_short_circuit_validation | 验证可空数据入口的短路保护 | intermediate | 追踪短路求值顺序，指出异常发生位置并区分容器为空与首项为零。 | development |
| programming_signed_division | 计算环形日志的跨块位移 | foundation | 对带符号整数给出divmod结果，并核对被除数=商×除数+余数及余数的符号约束。 | validation |
| programming_unicode_boundaries | 修复UTF-8日志截断与字符计数 | intermediate | 分别计算Unicode码点数、UTF-8长度、NFC归一化长度和指定字节前缀的解码结果。 | holdout |

## 数据结构与算法

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| algorithms_bfs_reachability | 计算服务依赖图的最少跳数 | intermediate | 按层扩展有向图，处理重复到达、环与不可达目标。 | development |
| algorithms_coin_inventory | 计算实验耗材组合的最少件数 | intermediate | 求恰好满足容量的最少件数，验证贪心反例、不可达状态和有限库存约束。 | development |
| algorithms_dependency_topology | 安排构建任务并报告循环依赖 | intermediate | 给出确定的拓扑执行序列和无法消去的阻塞节点，区分多个就绪任务与循环。 | validation |
| algorithms_interval_objectives | 选择共享实验室的预约集合 | integrated | 根据区间边界和目标函数选择最优兼容子集的数量或收益，识别贪心适用前提。 | holdout |
| algorithms_linear_probing_tombstones | 维护开放寻址哈希表的删除链 | integrated | 追踪碰撞、墓碑复用、环绕与重复插入后的槽状态和查询下标。 | development |
| algorithms_lower_bound_boundary | 定位有序事件表的最早匹配位置 | foundation | 维护半开区间不变式并给出lower_bound在重复、缺失和右边界的返回下标。 | development |
| algorithms_stable_insertion_shifts | 审核稳定排序的顺序与移动成本 | foundation | 给出稳定排序后的带标签记录与严格逆序对对应的移动次数。 | development |
| algorithms_weighted_shortest_path | 核对非负路网的最短成本 | intermediate | 使用松弛更新正确计算最短距离，处理零成本边与不可达节点。 | holdout |

## 数据库

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| databases_group_filter_aggregation | 生成订单聚合与阈值报表 | intermediate | 按SQL执行顺序计算过滤、分组、HAVING与COUNT(DISTINCT)结果。 | development |
| databases_left_join_cardinality | 保留没有订单的客户统计 | foundation | 给出连接行并解释ON/WHERE位置及COUNT列与COUNT(*)的不同基数。 | validation |
| databases_null_three_valued_logic | 定位空值条件造成的筛选遗漏 | foundation | 预测等号、IS NULL和含NULL的NOT IN条件产生的实际结果。 | development |
| databases_recursive_reachability | 查询课程依赖的可达节点与路径条数 | intermediate | 解释递归CTE中UNION去重、UNION ALL路径保留及深度限制产生的结果。 | holdout |
| databases_relational_division | 筛选完成全部必修实验的学生 | integrated | 用双重NOT EXISTS解释全称条件，并处理重复完成记录与空要求集。 | development |
| databases_transaction_savepoints | 检查转账回滚与嵌套保存点 | intermediate | 按事务边界追踪UPDATE、SAVEPOINT、ROLLBACK TO和RELEASE对最终持久状态的影响。 | development |
| databases_unique_constraints_upsert | 设计选课计数表的唯一约束 | integrated | 根据唯一约束和冲突处理语句预测接受的行、拒绝的操作与最终计数。 | holdout |
| databases_window_peer_semantics | 生成并列成绩排名与累计指标 | intermediate | 准确计算ROW_NUMBER、RANK及RANGE累计窗口在并列键下的行为。 | development |

## Web 后端

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| web_backend_atomic_purchase | 定位订单事务失败后的回滚范围 | intermediate | 按事务边界计算成功和失败后的持久状态 | development |
| web_backend_conditional_update | 用条件请求避免库存被旧页面覆盖 | intermediate | 按实际版本与业务状态逐请求判定响应和最终库存 | development |
| web_backend_idempotent_charge | 验证支付重试不会重复扣款 | integrated | 追踪幂等键绑定的请求内容并计算账本变化 | validation |
| web_backend_keyset_pagination | 处理同时间记录的游标分页 | intermediate | 基于复合游标找出下一页及返回游标 | holdout |
| web_backend_patch_validation | 区分缺字段、零值和空值 | foundation | 根据类型和字段存在性进行原子部分更新 | holdout |
| web_backend_resource_authorization | 为团队文档实现对象级授权 | foundation | 对照登录身份与实际对象归属判定访问结果 | development |
| web_backend_sliding_rate_limit | 检查滑动窗口的边界与拒绝计数 | integrated | 精确模拟窗口淘汰与接受记录的变化 | development |
| web_backend_sql_input_boundary | 将用户输入限制在SQL数据位置 | integrated | 指出输入进入SQL语法的位置并给出保持需求的参数化修补 | development |

## Web 前端

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| frontend_async_search_race | 防止旧搜索结果覆盖最新意图 | integrated | 根据请求发起顺序过滤过期结果并保留最新错误状态 | development |
| frontend_batched_state_updates | 排查批量状态更新少加一次的问题 | foundation | 按值替换与函数更新的不同语义计算最终状态 | development |
| frontend_css_cascade | 查明保存按钮为何显示错误颜色 | foundation | 从匹配规则中按重要性、特异性和顺序找出最终声明 | holdout |
| frontend_dom_event_propagation | 定位事件委托与停止传播的影响 | intermediate | 根据事件路径与停止传播规则列出实际触发监听器 | development |
| frontend_event_loop_order | 解释页面异步日志的实际顺序 | foundation | 逐步区分同步执行、微任务排队和后续任务 | holdout |
| frontend_flex_distribution | 计算仪表盘卡片的伸缩宽度 | intermediate | 分别按增长因子和缩减权重计算布局宽度 | development |
| frontend_form_successful_controls | 还原表单实际发送的字段 | intermediate | 依据成功控件规则构造有序表单字段对 | validation |
| frontend_keyboard_focus_order | 检查键盘用户能否遍历操作区 | integrated | 从DOM属性计算顺序焦点路径并识别不可达控件 | development |

## 软件测试

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| testing_boundary_partitions | 补齐批量任务参数的边界测试 | foundation | 从明确输入范围推导边界集合并定位缺失用例 | development |
| testing_branch_coverage | 区分执行过代码与覆盖了分支 | foundation | 追踪输入对应的分支结果并计算覆盖缺口 | holdout |
| testing_concurrency_interleavings | 用确定交错复现计数丢失 | integrated | 从读写轨迹计算最终值并识别丢失更新 | validation |
| testing_fixture_isolation | 发现共享测试数据造成的顺序依赖 | intermediate | 比较共享与每测试重建数据时的观测结果 | development |
| testing_mcdc_independence | 验证复合授权条件的独立影响 | integrated | 从测试真值表找出唯一条件变化且改变决策的证据对 | development |
| testing_metamorphic_sort_properties | 用性质断言识别貌似正确的排序 | intermediate | 为给定实现和反例检查顺序、多重集和输入保持等有限性质 | holdout |
| testing_mock_contract_fidelity | 让测试替身覆盖真实上游失败合同 | intermediate | 提出能让当前错误实现失败的具体测试输入和断言，并说明替身未覆盖的边界 | development |
| testing_mutation_adequacy | 通过变异体找出遗漏的阈值断言 | integrated | 逐测试计算原函数与变异体输出并列出被发现及未发现的错误 | development |

## 计算机网络

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| networks_dns_cache_scope | 分析DNS变更后的缓存观测 | intermediate | 区分NODATA与NXDOMAIN缓存范围并判断过期边界 | development |
| networks_ipv4_mtu | 核对隧道路径的IPv4分片报告 | intermediate | 依据DF和8字节偏移单位制定合法分片或拒绝理由 | holdout |
| networks_nat_lifetime | 排查网关NAT映射与回包失败 | integrated | 根据方向、协议、端点约束和有效期判断转换或拒绝 | development |
| networks_ordered_acl | 复核无状态ACL放行工单 | foundation | 逐条匹配五元组并指出首条命中或隐含拒绝 | development |
| networks_route_precedence | 定位分支路由表选路异常 | intermediate | 按活动状态、最长前缀和同前缀metric顺序确定下一跳集合 | development |
| networks_subnet_boundary | 审查实验室静态地址工单 | foundation | 从前缀算出网络与广播地址，并判定候选地址是否可分配 | validation |
| networks_tcp_reassembly | 解释抓包中的累计ACK与重传 | intermediate | 根据乱序、重叠和重复段算累计ACK及缺口后的暂存字节 | holdout |
| networks_window_throughput | 解释跨机房备份吞吐受限 | integrated | 比较链路速率与窗口/RTT上界并求满速所需窗口 | development |

## Linux 与系统运维

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| systems_cache_recency | 核对文档服务LRU缓存日志 | foundation | 核对命中刷新、缓存失效及缺页计数 | development |
| systems_disk_accounting | 解释删除日志后空间未释放 | intermediate | 区分逻辑长度、物理块、硬链接和打开句柄 | holdout |
| systems_raid_incident | 核对阵列容量与失盘影响 | intermediate | 由布局和失盘位置判断有效容量与可读性 | development |
| systems_resource_admission | 审核双资源批作业准入快照 | integrated | 用剩余需求与资源归还过程检验安全性 | validation |
| systems_retry_atomicity | 排查任务重试后的重复扣费账本 | integrated | 按幂等标记和事务边界判断实际副作用及载荷冲突 | development |
| systems_run_queue | 复核单核构建Worker轮转日志 | intermediate | 还原就绪队列并核对完成时刻与等待时间 | holdout |
| systems_tail_latency | 复核服务p95与SLO报表 | intermediate | 计算加权p95及SLO分母并识别分位数平均错误 | development |
| systems_unix_permissions | 处理服务账号文件访问工单 | foundation | 结合umask、目录搜索位与互斥权限类别判断访问 | development |

## 数据分析与人工智能基础

| family_id | 专业任务 | 层级 | 可观察能力 | 集合 |
| --- | --- | --- | --- | --- |
| data_ai_distance_scaling | 复核最近邻检索的特征尺度 | intermediate | 按训练统计缩放后比较距离，处理常量与缺失列 | development |
| data_ai_group_split | 审核实体与内容隔离的测试划分 | intermediate | 按声明评估目标寻找训练测试重叠实体或内容并定位受影响测试行 | validation |
| data_ai_imbalance_metrics | 复核稀有故障检测模型指标 | foundation | 从混淆计数和明确弃权口径计算指标并识别分母误用 | development |
| data_ai_preprocessing_leakage | 审查离线建模流程的数据边界 | integrated | 指出预处理何时读到验证信息并给出相应折内修复位置 | development |
| data_ai_quality_contract | 复核延迟特征入库质量契约 | foundation | 按规则区分零值缺失、类型错误、等价重复与异值冲突并核算均值 | holdout |
| data_ai_stratified_drift | 区分总体错误率变化与分层退化 | integrated | 计算原始与标准化错误率并按明确阈值判断告警 | holdout |
| data_ai_temporal_visibility | 核对预测时刻可见的时序特征 | integrated | 按实体、窗口、可用时间与角色筛选记录并计算均值特征 | development |
| data_ai_threshold_constraints | 在成本与审核容量约束下选择阈值 | intermediate | 先过滤硬约束再按错误代价选择阈值，必要时拒绝所有候选 | development |
