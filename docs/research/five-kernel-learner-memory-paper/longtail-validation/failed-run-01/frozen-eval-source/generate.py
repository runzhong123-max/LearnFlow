"""Author-written educational scenarios; no product or scorer imports.

History length and query variants are correlated conditions, never new learners.
The background bank is a finite stress corpus, not natural long-tail frequency.
"""
import json
from pathlib import Path

HISTORIES = (4, 64, 256)
BUDGETS = (1800, 3200)
BACKGROUND = (
    '我不懂堆排序建堆阶段，画出了父子节点下标。',
    '我不懂矩阵乘法的维度检查，暂时用两行三列核对。',
    '我不懂浮点舍入误差，分别保存了十进制显示和二进制表示。',
    '我不懂递归调用栈，已经标记每一层的局部变量。',
    '我不懂正则表达式的贪婪边界，只能解释最短输入。',
    '我不懂网页样式的层叠优先级，先检查选择器来源。',
    '我不懂关系代数中的投影操作，记录了重复行处理方式。',
    '我不懂单元用例的隔离，已经分开准备输入和共享状态。',
    '我不懂指令流水线的气泡，正在逐周期画时序。',
    '我不懂磁盘寻道的开销，保留了顺序读取的对照。',
    '我不懂补码的符号扩展，只验证了八位输入。',
    '我不懂哈夫曼编码树的合并次序，先保存了频率表。',
    '我不懂分页地址中的偏移位数，重新划分了虚拟地址。',
    '我不懂归并排序的临时空间，记下了数组复制次数。',
    '我不懂可视化坐标轴的单位，重新标注了毫秒和秒。',
    '我不懂交叉验证的分层抽样，保留了类别占比。',
    '我不懂梯度下降的步长，记录了两次迭代的损失。',
    '我不懂图像卷积的填充尺寸，核对了输出宽度。',
    '我不懂贝叶斯公式的分母，分别列出了三个互斥事件。',
    '我不懂正则化系数的影响，只改变了一个超参数。',
    '我不懂命令行文件权限，记录了所有者和组的不同权限。',
    '我不懂版本合并冲突，保留了两个分支的独立修改。',
    '我不懂构建产物路径，重新核对了相对目录。',
    '我不懂依赖锁文件的用途，保留了解析前后的版本列表。',
    '我不懂排序稳定性的含义，比较了相同关键字的相对次序。',
    '我不懂二叉搜索树的删除，分开画了三个子节点情形。',
    '我不懂文件缓冲刷新，只验证了正常退出。',
    '我不懂链接器如何解析符号，先检查每个目标文件。',
    '我不懂负载均衡的权重，分别统计了三组请求。',
    '我不懂日志时区，保存了同一时刻的两种表示。',
    '我不懂编辑距离的转移，画出了相邻状态的来源。',
    '我不懂进程退出码，核对了命令输出和返回值。',
)


def pad(text, size):
    filler = '我逐项整理运行笔记，并保留当时使用的输入和环境。'
    return text + (filler * (size // len(filler) + 1))[:max(0, size-len(text))]


def question(identifier, query, target='target', terms=(), qualifier='', **extra):
    return {'id':identifier,'query':query,'target_operation':target,
            'required_terms':list(terms),'qualifier':qualifier,**extra}


def scenarios():
    rows = [
      {'id':'rare_wakeup','family':'old_rare_exact','topic':'条件变量唤醒',
       'events':{'target':'我不懂 condition-variable spurious wakeup。条件变量的虚假唤醒还没有排除；仅记录了单等待者，多个等待者尚未验证。'},
       'queries':[question('exact','condition-variable spurious wakeup',terms=('虚假唤醒还没有排除',),qualifier='多个等待者尚未验证')]},
      {'id':'alias_mvcc','family':'alias','topic':'数据库快照',
       'events':{'target':'我不懂多版本并发控制。快照可见性仍有疑问；只追踪了两次读取，写冲突尚未验证。'},
       'queries':[question('alias','MVCC',terms=('快照可见性仍有疑问',),qualifier='写冲突尚未验证',ablation='aliases')]},
      {'id':'alias_breadth','family':'alias','topic':'迷宫层序搜索',
       'events':{'target':'我不懂 breadth-first search。迷宫的逐层入队次序尚不清楚；仅无环输入完成，重复访问尚未验证。'},
       'queries':[question('alias','广度优先搜索',terms=('逐层入队次序尚不清楚',),qualifier='重复访问尚未验证',ablation='aliases')]},
      {'id':'typo_scheduler','family':'unique_typo','topic':'调度器抢占',
       'events':{'target':'我不懂 scheduler。抢占时机仍然解释不清；仅一个就绪队列完成，多核迁移尚未验证。'},
       'queries':[question('typo','schedulr',terms=('抢占时机仍然解释不清',),qualifier='多核迁移尚未验证',ablation='fuzzy')]},
      {'id':'ambiguous_cache','family':'ambiguous_typo','topic':'缓存与用例歧义',
       'events':{'cache':'我不懂 cache 的淘汰顺序。缓存命中只能解释一个请求。','case':'我不懂 case 的输入分支。单个用例尚未覆盖空输入。'},
       'queries':[question('ambiguous','cashe',target=None,ablation='fuzzy',negative='ambiguous_term_no_unique_resolution')]},
      {'id':'oov_ttl','family':'out_of_alias_vocabulary','topic':'过期时间',
       'events':{'target':'我不懂存活时间。缓存条目过期后的删除时机还没厘清；只看了整秒设置，亚秒过期尚未验证。'},
       'queries':[question('oov','time to live',terms=('删除时机还没厘清',),qualifier='亚秒过期尚未验证')]},
      {'id':'split_lru','family':'separated_qualifier','topic':'LRU并发边界',
       'events':{'target':pad('我不懂LRU缓存。最近最少使用淘汰顺序已画出。',335)+'限制条件：仅单线程通过，并发访问尚未验证。'},
       'queries':[question('split','LRU缓存',terms=('最近最少使用淘汰顺序已画出',),qualifier='仅单线程通过，并发访问尚未验证')]},
      {'id':'tail_aba','family':'source_tail','topic':'无锁栈版本检查',
       'events':{'target':pad('我不懂这段无锁栈操作，先保留排查过程。',315)+'尾部观察：ABA版本回绕仍有疑问。限制条件：仅单次弹栈完成，多次复用尚未验证。'},
       'queries':[question('tail','ABA版本回绕',terms=('ABA版本回绕仍有疑问',),qualifier='多次复用尚未验证')]},
      {'id':'history_tcp','family':'historical_vs_current','topic':'TCP重传疑问变化',
       'events':{'target':'我不懂TCP重传的连续丢包处理。最初疑问是连续丢包，尚未进入窗口收缩。',
                 'current':'我不懂TCP重传的窗口收缩。当前疑问已转为窗口收缩；此前连续丢包仅为旧自述，不代表正式测评通过。'},
       'queries':[question('earliest','最初TCP重传',terms=('最初疑问是连续丢包',),qualifier='尚未进入窗口收缩',ablation='temporal',temporal=True),
                  question('current','当前TCP重传',target='current',terms=('当前疑问已转为窗口收缩',),qualifier='不代表正式测评通过',ablation='temporal',temporal=True)]},
      {'id':'scope_dns','family':'scope_pollution','topic':'域名递归查询',
       'events':{'target':'我不懂DNS递归查询。本人项目只观察了本地域名；权威服务器超时尚未验证。'},
       'queries':[question('owned','DNS递归查询',terms=('本人项目只观察了本地域名',),qualifier='权威服务器超时尚未验证')]},
      {'id':'uncovered_grover','family':'uncovered_exact','topic':'无量子检索经历',
       'events':{},'queries':[question('absent','Grover振幅放大',target=None,negative='no_matching_history')]},
      {'id':'uncovered_quantum','family':'uncovered_generic','topic':'无量子纠错经历',
       'events':{},'queries':[question('absent','目前量子纠错的诊断证据是什么',target=None,negative='no_matching_history')]},
    ]
    for row in rows:
        row['histories']=list(HISTORIES)
        for text in row['events'].values():
            assert '不懂' in text and len(text)<=500
        for q in row['queries']:
            if q['target_operation']:
                source=row['events'][q['target_operation']]
                assert all(term in source for term in q['required_terms']) and q['qualifier'] in source
    assert len(rows)==12 and len({r['id'] for r in rows})==12
    return rows


def noise(row, index):
    # The 32 semantic situations repeat with changing artifact coordinates.
    # They are explicitly correlated distractors, not extra task samples.
    text=BACKGROUND[index % len(BACKGROUND)]
    if row['id']=='history_tcp':
        text='我不懂TCP重传的日志对齐。记录了时钟和报文编号，尚未得出结果。'
    return text+f'练习片段编号为{index+1}，对照输入位置为{(index*7)%101}。'


def variants(q):
    common=['default','source']
    if q.get('ablation'):
        common += [f'default_no_{q["ablation"]}',f'source_no_{q["ablation"]}']
    return common


if __name__=='__main__':
    path=Path(__file__).with_name('data')/'scenarios.jsonl'
    with path.open('x',encoding='utf-8') as stream:
        for row in scenarios():stream.write(json.dumps(row,ensure_ascii=False,sort_keys=True)+'\n')
    print(json.dumps({'scenarios':12,'queries':sum(len(r['queries']) for r in scenarios()),'path':str(path)}))
