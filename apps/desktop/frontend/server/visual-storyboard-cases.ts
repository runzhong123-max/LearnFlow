import { VISUAL_STORYBOARD_VERSION, type VisualStoryboardContext } from '../src/visual-storyboard.ts'

const presentation = { preferredDirection: 'auto', pacing: 'step', preserveIdentity: true, showGroupSummary: true } as const
const provenance = (caseId: string) => ({ source: 'authored_eval' as const, caseId })
const frame = (
  id: string,
  title: string,
  narration: string,
  operations: VisualStoryboardContext['frames'][number]['operations'],
  assertions: VisualStoryboardContext['frames'][number]['assertions'] = [],
) => {
  if (!assertions.length) {
    const operation = [...operations].reverse().find(item => item.op !== 'focus')
    if (operation?.op === 'set_property') assertions = [{ type: 'property', targetId: operation.targetId, key: operation.key, equals: operation.value }]
    else if (operation?.op === 'set_group_members') assertions = [{ type: 'group_members', groupId: operation.groupId, equals: operation.memberIds }]
    else if (operation?.op === 'reorder') assertions = [{ type: 'order', groupId: operation.groupId, equals: operation.itemIds }]
    else if (operation?.op === 'create_entity' || operation?.op === 'remove_entity') assertions = [{ type: 'visible', targetId: operation.targetId, equals: operation.op === 'create_entity' }]
    else if (operation?.op === 'connect' || operation?.op === 'disconnect') assertions = [{ type: 'visible', targetId: operation.relationId, equals: operation.op === 'connect' }]
  }
  return { id, title, narration, operations, assertions }
}

export const VISUAL_STORYBOARD_CASES: VisualStoryboardContext[] = [
  {
    version: VISUAL_STORYBOARD_VERSION, id: 'huffman_tree', title: '哈夫曼树：逐次合并最小权重',
    learningGoal: '观察森林如何从六棵单节点树，经五次最小权重合并变成一棵树。',
    explanation: '字符频率为 A5、B9、C12、D13、E16、F45。每轮从当前森林选出权重最小的两棵树，创建权重为两者之和的父节点，再把新树放回森林；最终根权重为 100。',
    entities: [
      ['a','A(5)'],['b','B(9)'],['c','C(12)'],['d','D(13)'],['e','E(16)'],['f','F(45)'],
      ['n14','14'],['n25','25'],['n30','30'],['n55','55'],['root100','100'],
    ].map(([id,label]) => ({ id, label, kind: id.startsWith('n') || id.startsWith('root') ? 'result' as const : 'value' as const })),
    relations: [
      ['r14a','n14','a'],['r14b','n14','b'],['r25c','n25','c'],['r25d','n25','d'],
      ['r30n14','n30','n14'],['r30e','n30','e'],['r55n25','n55','n25'],['r55n30','n55','n30'],
      ['r100f','root100','f'],['r100n55','root100','n55'],
    ].map(([id,from,to]) => ({ id, from, to, label: '子节点', kind: 'link' as const })),
    groups: [{ id: 'forest', label: '当前森林根', layout: 'row' }],
    initial: { visibleIds: ['a','b','c','d','e','f'], groupMembers: { forest: ['a','b','c','d','e','f'] }, properties: { a:{weight:5},b:{weight:9},c:{weight:12},d:{weight:13},e:{weight:16},f:{weight:45} } },
    frames: [
      frame('merge_14','合并 A 与 B','当前最小权重 5 和 9 合并为 14。',[{op:'create_entity',targetId:'n14'},{op:'connect',relationId:'r14a'},{op:'connect',relationId:'r14b'},{op:'set_property',targetId:'n14',key:'weight',value:14},{op:'set_group_members',groupId:'forest',memberIds:['c','d','n14','e','f']},{op:'focus',targetIds:['a','b','n14']}],[{type:'visible',targetId:'n14',equals:true},{type:'group_members',groupId:'forest',equals:['c','d','n14','e','f']}]),
      frame('merge_25','合并 C 与 D','当前最小权重 12 和 13 合并为 25。',[{op:'create_entity',targetId:'n25'},{op:'connect',relationId:'r25c'},{op:'connect',relationId:'r25d'},{op:'set_property',targetId:'n25',key:'weight',value:25},{op:'set_group_members',groupId:'forest',memberIds:['n14','e','n25','f']},{op:'focus',targetIds:['c','d','n25']}],[{type:'property',targetId:'n25',key:'weight',equals:25}]),
      frame('merge_30','合并 14 与 E','当前最小权重 14 和 16 合并为 30；14 的整棵子树保持不变。',[{op:'create_entity',targetId:'n30'},{op:'connect',relationId:'r30n14'},{op:'connect',relationId:'r30e'},{op:'set_property',targetId:'n30',key:'weight',value:30},{op:'set_group_members',groupId:'forest',memberIds:['n25','n30','f']},{op:'focus',targetIds:['n14','e','n30']}]),
      frame('merge_55','合并 25 与 30','两棵子树 25 和 30 合并为 55。',[{op:'create_entity',targetId:'n55'},{op:'connect',relationId:'r55n25'},{op:'connect',relationId:'r55n30'},{op:'set_property',targetId:'n55',key:'weight',value:55},{op:'set_group_members',groupId:'forest',memberIds:['f','n55']},{op:'focus',targetIds:['n25','n30','n55']}]),
      frame('merge_root','生成根节点','最后合并 F(45) 与 55，根权重为 100。',[{op:'create_entity',targetId:'root100'},{op:'connect',relationId:'r100f'},{op:'connect',relationId:'r100n55'},{op:'set_property',targetId:'root100',key:'weight',value:100},{op:'set_group_members',groupId:'forest',memberIds:['root100']},{op:'focus',targetIds:['f','n55','root100']}],[{type:'property',targetId:'root100',key:'weight',equals:100}]),
      frame('assign_codes','标注编码','约定左边为 0、右边为 1，叶子得到前缀编码。',[{op:'set_property',targetId:'f',key:'code',value:'0'},{op:'set_property',targetId:'c',key:'code',value:'100'},{op:'set_property',targetId:'d',key:'code',value:'101'},{op:'set_property',targetId:'e',key:'code',value:'110'},{op:'set_property',targetId:'a',key:'code',value:'1110'},{op:'set_property',targetId:'b',key:'code',value:'1111'},{op:'focus',targetIds:['a','b','c','d','e','f']}],[{type:'property',targetId:'f',key:'code',equals:'0'}]),
    ],
    invariants: ['每轮只替换当前森林中的两个根，已有子树内部结构不变。','父节点权重始终等于两个子节点权重之和。'], misconceptions: ['相同权重可能产生不同但同样最优的左右排列。'], claimBoundary: '只演示给定频率和左0右1约定下的一棵合法哈夫曼树。', presentation, provenance: provenance('case_01'),
  },
  {
    version: VISUAL_STORYBOARD_VERSION, id:'quick_sort_partition', title:'快速排序：一次分区', learningGoal:'观察基准 5 如何把数组分成小于、等于和大于三组。',
    explanation:'对数组 [8,3,5,1,9] 选择 5 为基准。扫描完成后，小于 5 的元素进入左组，5 固定在中间，大于 5 的元素进入右组；随后左右子数组可独立递归。',
    entities:[8,3,5,1,9].map(value=>({id:`v${value}`,label:String(value),kind:'value' as const})), relations:[], groups:[{id:'pending',label:'待分区',layout:'row'},{id:'less',label:'小于基准',layout:'row'},{id:'equal',label:'基准',layout:'row'},{id:'greater',label:'大于基准',layout:'row'}],
    initial:{visibleIds:['v8','v3','v5','v1','v9'],groupMembers:{pending:['v8','v3','v5','v1','v9'],less:[],equal:[],greater:[]},orders:{pending:['v8','v3','v5','v1','v9']}},
    frames:[
      frame('choose_pivot','选择基准 5','基准只作比较标准，身份在各帧保持稳定。',[{op:'set_property',targetId:'v5',key:'role',value:'pivot'},{op:'focus',targetIds:['v5']}]),
      frame('classify_left','归入较小元素','3 和 1 小于 5，进入左侧集合。',[{op:'set_group_members',groupId:'less',memberIds:['v3','v1']},{op:'set_group_members',groupId:'pending',memberIds:['v8','v5','v9']},{op:'focus',targetIds:['v3','v1']}]),
      frame('classify_right','归入较大元素','8 和 9 大于 5，进入右侧集合；5 单独归位。',[{op:'set_group_members',groupId:'greater',memberIds:['v8','v9']},{op:'set_group_members',groupId:'equal',memberIds:['v5']},{op:'set_group_members',groupId:'pending',memberIds:[]},{op:'focus',targetIds:['v8','v9','v5']}]),
      frame('partition_done','完成分区','本轮只保证左右相对基准的大小关系，不保证两侧内部已排序。',[{op:'reorder',groupId:'less',itemIds:['v3','v1']},{op:'reorder',groupId:'greater',itemIds:['v8','v9']},{op:'set_property',targetId:'v5',key:'status',value:'fixed'},{op:'focus',targetIds:['v5']}],[{type:'property',targetId:'v5',key:'status',equals:'fixed'}]),
    ], invariants:['所有元素恰好属于一个分区集合。'], misconceptions:['一次分区不等于整个数组已经有序。'], claimBoundary:'只演示三路分区的语义，不绑定某个原地交换实现。', presentation, provenance:provenance('case_02'),
  },
  {
    version:VISUAL_STORYBOARD_VERSION,id:'bfs_queue',title:'BFS：队列驱动的层序访问',learningGoal:'观察节点如何从未发现集合进入队列，再进入已访问集合。',
    explanation:'从 A 开始，先把 A 入队。每次取出队首节点并访问，把尚未发现的邻居按顺序入队；因此 B、C 的距离为 1，D 的距离为 2。',
    entities:['a','b','c','d'].map(id=>({id,label:id.toUpperCase(),kind:'item' as const})),relations:[{id:'ab',from:'a',to:'b',kind:'link'},{id:'ac',from:'a',to:'c',kind:'link'},{id:'bd',from:'b',to:'d',kind:'link'},{id:'cd',from:'c',to:'d',kind:'link'}],groups:[{id:'unseen',label:'未发现',layout:'row'},{id:'queue',label:'队列',layout:'row'},{id:'visited',label:'已访问',layout:'row'}],
    initial:{visibleIds:['a','b','c','d','ab','ac','bd','cd'],groupMembers:{unseen:['a','b','c','d'],queue:[],visited:[]}},frames:[
      frame('enqueue_a','A 入队','起点 A 的距离设为 0。',[{op:'set_group_members',groupId:'unseen',memberIds:['b','c','d']},{op:'set_group_members',groupId:'queue',memberIds:['a']},{op:'set_property',targetId:'a',key:'distance',value:0},{op:'focus',targetIds:['a']}]),
      frame('visit_a','访问 A','A 出队并访问；未发现邻居 B、C 依次入队。',[{op:'set_group_members',groupId:'queue',memberIds:['b','c']},{op:'set_group_members',groupId:'visited',memberIds:['a']},{op:'set_group_members',groupId:'unseen',memberIds:['d']},{op:'set_property',targetId:'b',key:'distance',value:1},{op:'set_property',targetId:'c',key:'distance',value:1},{op:'focus',targetIds:['a','b','c']}]),
      frame('visit_b','访问 B','B 出队；发现 D，把 D 放到 C 后面。',[{op:'set_group_members',groupId:'queue',memberIds:['c','d']},{op:'set_group_members',groupId:'visited',memberIds:['a','b']},{op:'set_group_members',groupId:'unseen',memberIds:[]},{op:'set_property',targetId:'d',key:'distance',value:2},{op:'focus',targetIds:['b','d']}]),
      frame('finish_bfs','完成遍历','继续访问 C、D，最终访问顺序为 A、B、C、D。',[{op:'set_group_members',groupId:'queue',memberIds:[]},{op:'set_group_members',groupId:'visited',memberIds:['a','b','c','d']},{op:'reorder',groupId:'visited',itemIds:['a','b','c','d']},{op:'focus',targetIds:['a','b','c','d']}],[{type:'order',groupId:'visited',equals:['a','b','c','d']}]),
    ],invariants:['节点第一次入队时即标记为已发现，避免重复入队。'],misconceptions:['BFS 保证无权图最短边数，不保证带权图最短距离。'],claimBoundary:'邻居顺序固定为 B 后 C。',presentation,provenance:provenance('case_03'),
  },
  {
    version:VISUAL_STORYBOARD_VERSION,id:'tcp_handshake',title:'TCP 三次握手',learningGoal:'观察客户端与服务端如何通过 SYN、SYN-ACK、ACK 同步连接状态。',
    explanation:'客户端先发送 SYN 并进入 SYN-SENT；服务端收到后回复 SYN-ACK 并进入 SYN-RECEIVED；客户端确认 ACK 后双方进入 ESTABLISHED。',
    entities:[{id:'client',label:'客户端',kind:'actor'},{id:'server',label:'服务端',kind:'actor'}],relations:[{id:'syn',from:'client',to:'server',label:'1. SYN',kind:'message'},{id:'syn_ack',from:'server',to:'client',label:'2. SYN-ACK',kind:'message'},{id:'ack',from:'client',to:'server',label:'3. ACK',kind:'message'}],groups:[{id:'peers',label:'连接双方',layout:'row'}],initial:{visibleIds:['client','server'],groupMembers:{peers:['client','server']},properties:{client:{state:'CLOSED'},server:{state:'LISTEN'}}},frames:[
      frame('send_syn','发送 SYN','客户端发起连接。',[{op:'connect',relationId:'syn'},{op:'set_property',targetId:'client',key:'state',value:'SYN-SENT'},{op:'focus',targetIds:['client','syn']}]),
      frame('send_syn_ack','回复 SYN-ACK','服务端确认客户端序号并发送自己的 SYN。',[{op:'connect',relationId:'syn_ack'},{op:'set_property',targetId:'server',key:'state',value:'SYN-RECEIVED'},{op:'focus',targetIds:['server','syn_ack']}]),
      frame('send_ack','发送最终 ACK','客户端确认后双方建立连接。',[{op:'connect',relationId:'ack'},{op:'set_property',targetId:'client',key:'state',value:'ESTABLISHED'},{op:'set_property',targetId:'server',key:'state',value:'ESTABLISHED'},{op:'focus',targetIds:['ack','client','server']}],[{type:'property',targetId:'server',key:'state',equals:'ESTABLISHED'}]),
    ],invariants:['每条消息方向与握手次序保持不变。'],misconceptions:['三次握手建立的是双方序号与连接状态，不代表应用数据已经传输。'],claimBoundary:'省略具体序号值、重传和异常路径。',presentation,provenance:provenance('case_04'),
  },
  {
    version:VISUAL_STORYBOARD_VERSION,id:'cnn_convolution',title:'CNN 卷积到池化',learningGoal:'观察局部窗口如何生成特征响应并经过 ReLU、池化。',
    explanation:'3×3 卷积核在输入图像上滑动，每个位置做逐元素乘加产生一个特征值；完整扫描形成特征图，ReLU 把负响应归零，最大池化保留局部最大响应。',
    entities:[{id:'input',label:'输入图像',kind:'item'},{id:'kernel',label:'3×3 卷积核',kind:'operator'},{id:'window',label:'当前窗口',kind:'state'},{id:'feature',label:'特征图',kind:'result'},{id:'relu',label:'ReLU',kind:'operator'},{id:'pooled',label:'池化结果',kind:'result'}],relations:[{id:'input_feature',from:'input',to:'feature',label:'逐位置乘加',kind:'flow'},{id:'kernel_feature',from:'kernel',to:'feature',label:'共享权重',kind:'flow'},{id:'feature_relu',from:'feature',to:'relu',kind:'flow'},{id:'relu_pool',from:'relu',to:'pooled',kind:'flow'}],groups:[{id:'pipeline',label:'处理链',layout:'row'}],initial:{visibleIds:['input','kernel','window'],groupMembers:{pipeline:['input','kernel','window']},properties:{window:{position:'(0,0)'}}},frames:[
      frame('slide_window','窗口滑动','窗口从左上向右移动，输入区域改变但卷积核权重不变。',[{op:'set_property',targetId:'window',key:'position',value:'(0,1)'},{op:'focus',targetIds:['window','kernel']}]),
      frame('build_feature','形成特征图','所有合法位置完成乘加，得到完整特征图。',[{op:'create_entity',targetId:'feature'},{op:'connect',relationId:'input_feature'},{op:'connect',relationId:'kernel_feature'},{op:'set_group_members',groupId:'pipeline',memberIds:['input','kernel','feature']},{op:'set_property',targetId:'feature',key:'shape',value:'Hout×Wout'},{op:'focus',targetIds:['feature']}]),
      frame('apply_relu','应用 ReLU','负响应归零，正响应保留。',[{op:'create_entity',targetId:'relu'},{op:'connect',relationId:'feature_relu'},{op:'set_group_members',groupId:'pipeline',memberIds:['input','kernel','feature','relu']},{op:'set_property',targetId:'relu',key:'rule',value:'max(0,x)'},{op:'focus',targetIds:['relu']}]),
      frame('max_pool','最大池化','每个局部区域只保留最大响应，空间尺寸缩小。',[{op:'create_entity',targetId:'pooled'},{op:'connect',relationId:'relu_pool'},{op:'set_group_members',groupId:'pipeline',memberIds:['input','kernel','feature','relu','pooled']},{op:'set_property',targetId:'pooled',key:'effect',value:'downsample'},{op:'focus',targetIds:['pooled']}]),
    ],invariants:['同一卷积核在所有空间位置共享权重。'],misconceptions:['池化不等同于卷积，也不会学习新的卷积核。'],claimBoundary:'不声称具体数值，因案例未提供像素矩阵。',presentation,provenance:provenance('case_05'),
  },
  {
    version:VISUAL_STORYBOARD_VERSION,id:'gradient_descent',title:'梯度下降：沿负梯度移动',learningGoal:'观察参数 x 如何逐步靠近二次函数最低点。',explanation:'对 f(x)=(x-2)²，从 x=-2 开始，每轮计算梯度 2(x-2)，再按 x←x-0.25·gradient 更新；位置依次为 -2、0、1、1.5，逐步接近最优点 2。',
    entities:[{id:'minimum',label:'最优点 x=2',kind:'result'},{id:'x0',label:'x₀=-2',kind:'value'},{id:'x1',label:'x₁=0',kind:'value'},{id:'x2',label:'x₂=1',kind:'value'},{id:'x3',label:'x₃=1.5',kind:'value'}],relations:[{id:'step1',from:'x0',to:'x1',label:'−α∇f',kind:'flow'},{id:'step2',from:'x1',to:'x2',label:'−α∇f',kind:'flow'},{id:'step3',from:'x2',to:'x3',label:'−α∇f',kind:'flow'},{id:'toward_min',from:'x3',to:'minimum',label:'继续逼近',kind:'flow'}],groups:[{id:'trajectory',label:'迭代轨迹',layout:'row'}],initial:{visibleIds:['minimum','x0'],groupMembers:{trajectory:['x0','minimum']},properties:{x0:{loss:16}}},frames:[
      frame('gd_step_1','第 1 次更新','梯度为 -8，更新后 x=0，损失降为 4。',[{op:'create_entity',targetId:'x1'},{op:'connect',relationId:'step1'},{op:'set_property',targetId:'x1',key:'loss',value:4},{op:'set_group_members',groupId:'trajectory',memberIds:['x0','x1','minimum']},{op:'focus',targetIds:['x1']}]),
      frame('gd_step_2','第 2 次更新','梯度为 -4，更新后 x=1，损失降为 1。',[{op:'create_entity',targetId:'x2'},{op:'connect',relationId:'step2'},{op:'set_property',targetId:'x2',key:'loss',value:1},{op:'set_group_members',groupId:'trajectory',memberIds:['x0','x1','x2','minimum']},{op:'focus',targetIds:['x2']}]),
      frame('gd_step_3','第 3 次更新','梯度为 -2，更新后 x=1.5，损失降为 0.25。',[{op:'create_entity',targetId:'x3'},{op:'connect',relationId:'step3'},{op:'set_property',targetId:'x3',key:'loss',value:0.25},{op:'set_group_members',groupId:'trajectory',memberIds:['x0','x1','x2','x3','minimum']},{op:'focus',targetIds:['x3']}]),
      frame('gd_trend','继续逼近','固定学习率下仍会继续向 x=2 靠近。',[{op:'connect',relationId:'toward_min'},{op:'set_property',targetId:'minimum',key:'gradient',value:0},{op:'focus',targetIds:['minimum']}]),
    ],invariants:['每步更新使用同一学习率 0.25。'],misconceptions:['下降并不保证任意函数和任意学习率都单调。'],claimBoundary:'只对给定二次函数与前三次更新成立。',presentation,provenance:provenance('case_06'),
  },
  {
    version:VISUAL_STORYBOARD_VERSION,id:'matrix_product_cell',title:'矩阵乘法：计算一个单元格',learningGoal:'观察 A 的一行与 B 的一列如何通过点积得到 C₁₁。',explanation:'取 A 第一行 [1,2,0] 与 B 第一列 [2,0,4]，对应元素相乘再求和：1×2+2×0+0×4=2，因此 C₁₁=2。',
    entities:[{id:'row_a',label:'A 第1行 [1,2,0]',kind:'item'},{id:'col_b',label:'B 第1列 [2,0,4]',kind:'item'},{id:'products',label:'[2,0,0]',kind:'state'},{id:'sum',label:'求和',kind:'operator'},{id:'c11',label:'C₁₁=2',kind:'result'}],relations:[{id:'pair_a',from:'row_a',to:'products',label:'逐项相乘',kind:'flow'},{id:'pair_b',from:'col_b',to:'products',label:'逐项相乘',kind:'flow'},{id:'to_sum',from:'products',to:'sum',kind:'flow'},{id:'to_c11',from:'sum',to:'c11',kind:'flow'}],groups:[{id:'calculation',label:'计算链',layout:'row'}],initial:{visibleIds:['row_a','col_b'],groupMembers:{calculation:['row_a','col_b']}},frames:[
      frame('select_row_column','选择行与列','输出位置 (1,1) 决定使用 A 第 1 行和 B 第 1 列。',[{op:'set_property',targetId:'row_a',key:'selected',value:true},{op:'set_property',targetId:'col_b',key:'selected',value:true},{op:'focus',targetIds:['row_a','col_b']}]),
      frame('multiply_terms','逐项相乘','得到三个乘积 2、0、0。',[{op:'create_entity',targetId:'products'},{op:'connect',relationId:'pair_a'},{op:'connect',relationId:'pair_b'},{op:'set_group_members',groupId:'calculation',memberIds:['row_a','col_b','products']},{op:'focus',targetIds:['products']}]),
      frame('sum_terms','求和写入 C','2+0+0=2，写入 C₁₁。',[{op:'create_entity',targetId:'sum'},{op:'create_entity',targetId:'c11'},{op:'connect',relationId:'to_sum'},{op:'connect',relationId:'to_c11'},{op:'set_property',targetId:'c11',key:'value',value:2},{op:'set_group_members',groupId:'calculation',memberIds:['row_a','col_b','products','sum','c11']},{op:'focus',targetIds:['c11']}]),
    ],invariants:['行长度必须等于列长度。'],misconceptions:['矩阵乘法不是对应位置直接相乘。'],claimBoundary:'只计算 C₁₁，不代表完整乘积矩阵。',presentation,provenance:provenance('case_07'),
  },
  {
    version:VISUAL_STORYBOARD_VERSION,id:'binary_search',title:'二分查找：收缩搜索区间',learningGoal:'观察有序数组中的左右边界如何排除一半候选。',explanation:'在 [1,3,5,7,9,11,13] 中查找 11。先看中点 7，目标更大，所以丢弃左半；再看 11，命中目标。',
    entities:[1,3,5,7,9,11,13].map(value=>({id:`n${value}`,label:String(value),kind:'value' as const})),relations:[],groups:[{id:'interval',label:'当前搜索区间',layout:'row'},{id:'discarded',label:'已排除',layout:'row'}],initial:{visibleIds:['n1','n3','n5','n7','n9','n11','n13'],groupMembers:{interval:['n1','n3','n5','n7','n9','n11','n13'],discarded:[]},orders:{interval:['n1','n3','n5','n7','n9','n11','n13']}},frames:[
      frame('middle_7','检查中点 7','11 大于 7，目标只能在右半区间。',[{op:'set_property',targetId:'n7',key:'role',value:'mid'},{op:'focus',targetIds:['n7']}]),
      frame('shrink_right','收缩到右半','排除 1、3、5、7，保留 9、11、13。',[{op:'set_group_members',groupId:'discarded',memberIds:['n1','n3','n5','n7']},{op:'set_group_members',groupId:'interval',memberIds:['n9','n11','n13']},{op:'reorder',groupId:'interval',itemIds:['n9','n11','n13']},{op:'focus',targetIds:['n9','n11','n13']}]),
      frame('found_11','命中 11','新区间中点为 11，查找结束。',[{op:'set_property',targetId:'n11',key:'status',value:'found'},{op:'set_property',targetId:'n7',key:'role',value:'checked'},{op:'focus',targetIds:['n11']}],[{type:'property',targetId:'n11',key:'status',equals:'found'}]),
    ],invariants:['输入数组保持升序。'],misconceptions:['边界更新必须排除已经比较过的中点，否则可能死循环。'],claimBoundary:'按整数下取整中点策略演示。',presentation,provenance:provenance('case_08'),
  },
  {
    version:VISUAL_STORYBOARD_VERSION,id:'event_loop',title:'JavaScript 事件循环顺序',learningGoal:'观察同步栈、微任务队列和任务队列如何决定输出 A、D、C、B。',explanation:'脚本先同步输出 A，setTimeout 回调进入任务队列，Promise.then 回调进入微任务队列，再同步输出 D；当前调用栈清空后先清空微任务输出 C，最后执行任务输出 B。',
    entities:[{id:'sync_a',label:'输出 A',kind:'result'},{id:'timer_b',label:'setTimeout → B',kind:'item'},{id:'promise_c',label:'Promise.then → C',kind:'item'},{id:'sync_d',label:'输出 D',kind:'result'},{id:'output_c',label:'输出 C',kind:'result'},{id:'output_b',label:'输出 B',kind:'result'}],relations:[{id:'promise_to_c',from:'promise_c',to:'output_c',kind:'flow'},{id:'timer_to_b',from:'timer_b',to:'output_b',kind:'flow'}],groups:[{id:'stack',label:'调用栈',layout:'column'},{id:'microtasks',label:'微任务队列',layout:'row'},{id:'tasks',label:'任务队列',layout:'row'},{id:'outputs',label:'输出序列',layout:'row'}],initial:{visibleIds:['timer_b','promise_c'],groupMembers:{stack:[],microtasks:[],tasks:[],outputs:[]}},frames:[
      frame('sync_phase','执行同步代码','同步输出 A 和 D，同时把两个异步回调分别登记到队列。',[{op:'create_entity',targetId:'sync_a'},{op:'create_entity',targetId:'sync_d'},{op:'set_group_members',groupId:'microtasks',memberIds:['promise_c']},{op:'set_group_members',groupId:'tasks',memberIds:['timer_b']},{op:'set_group_members',groupId:'outputs',memberIds:['sync_a','sync_d']},{op:'focus',targetIds:['sync_a','sync_d']}]),
      frame('drain_microtasks','清空微任务','调用栈为空后，Promise 回调先执行并输出 C。',[{op:'create_entity',targetId:'output_c'},{op:'connect',relationId:'promise_to_c'},{op:'set_group_members',groupId:'microtasks',memberIds:[]},{op:'set_group_members',groupId:'outputs',memberIds:['sync_a','sync_d','output_c']},{op:'focus',targetIds:['promise_c','output_c']}]),
      frame('run_task','执行任务','微任务清空后，setTimeout 回调执行并输出 B。',[{op:'create_entity',targetId:'output_b'},{op:'connect',relationId:'timer_to_b'},{op:'set_group_members',groupId:'tasks',memberIds:[]},{op:'set_group_members',groupId:'outputs',memberIds:['sync_a','sync_d','output_c','output_b']},{op:'focus',targetIds:['timer_b','output_b']}]),
      frame('event_order','确认输出顺序','最终输出序列为 A、D、C、B。',[{op:'reorder',groupId:'outputs',itemIds:['sync_a','sync_d','output_c','output_b']},{op:'set_property',targetId:'output_b',key:'order',value:4},{op:'focus',targetIds:['sync_a','sync_d','output_c','output_b']}],[{type:'order',groupId:'outputs',equals:['sync_a','sync_d','output_c','output_b']}]),
    ],invariants:['一轮任务结束时会先清空微任务队列。'],misconceptions:['setTimeout(...,0) 不是立即执行。'],claimBoundary:'采用常见浏览器事件循环教学模型，不展开 Node.js 多阶段事件循环。',presentation,provenance:provenance('case_09'),
  },
  {
    version:VISUAL_STORYBOARD_VERSION,id:'federated_round',title:'联邦学习的一轮聚合',learningGoal:'观察全局模型如何下发、在本地训练、上传更新并聚合为新版本。',explanation:'服务器把同一全局模型 v0 下发给三个客户端；每个客户端只用本地数据训练得到更新 Δ1、Δ2、Δ3；服务器接收更新并按权重聚合，产生全局模型 v1。原始数据不离开客户端。',
    entities:[{id:'server',label:'聚合服务器',kind:'actor'},{id:'client1',label:'客户端 1',kind:'actor'},{id:'client2',label:'客户端 2',kind:'actor'},{id:'client3',label:'客户端 3',kind:'actor'},{id:'global_v0',label:'全局模型 v0',kind:'state'},{id:'delta1',label:'更新 Δ1',kind:'value'},{id:'delta2',label:'更新 Δ2',kind:'value'},{id:'delta3',label:'更新 Δ3',kind:'value'},{id:'aggregate',label:'加权聚合',kind:'operator'},{id:'global_v1',label:'全局模型 v1',kind:'result'}],relations:[{id:'down1',from:'global_v0',to:'client1',label:'下发',kind:'message'},{id:'down2',from:'global_v0',to:'client2',label:'下发',kind:'message'},{id:'down3',from:'global_v0',to:'client3',label:'下发',kind:'message'},{id:'up1',from:'delta1',to:'aggregate',label:'上传',kind:'message'},{id:'up2',from:'delta2',to:'aggregate',label:'上传',kind:'message'},{id:'up3',from:'delta3',to:'aggregate',label:'上传',kind:'message'},{id:'aggregate_v1',from:'aggregate',to:'global_v1',label:'生成',kind:'flow'}],groups:[{id:'clients',label:'参与客户端',layout:'row'},{id:'server_side',label:'服务器侧',layout:'row'}],initial:{visibleIds:['server','client1','client2','client3','global_v0'],groupMembers:{clients:['client1','client2','client3'],server_side:['server','global_v0']},properties:{global_v0:{version:0}}},frames:[
      frame('broadcast_model','下发全局模型','三个客户端收到相同的 v0。',[{op:'connect',relationId:'down1'},{op:'connect',relationId:'down2'},{op:'connect',relationId:'down3'},{op:'focus',targetIds:['global_v0','client1','client2','client3']}]),
      frame('local_training','本地训练','各客户端用本地数据产生参数更新，原始数据不上传。',[{op:'create_entity',targetId:'delta1'},{op:'create_entity',targetId:'delta2'},{op:'create_entity',targetId:'delta3'},{op:'set_property',targetId:'client1',key:'status',value:'trained'},{op:'set_property',targetId:'client2',key:'status',value:'trained'},{op:'set_property',targetId:'client3',key:'status',value:'trained'},{op:'set_group_members',groupId:'clients',memberIds:['client1','delta1','client2','delta2','client3','delta3']},{op:'focus',targetIds:['delta1','delta2','delta3']}]),
      frame('upload_updates','上传更新','服务器接收 Δ1、Δ2、Δ3，准备聚合。',[{op:'create_entity',targetId:'aggregate'},{op:'connect',relationId:'up1'},{op:'connect',relationId:'up2'},{op:'connect',relationId:'up3'},{op:'set_group_members',groupId:'server_side',memberIds:['server','global_v0','aggregate']},{op:'focus',targetIds:['delta1','delta2','delta3','aggregate']}]),
      frame('new_global_model','形成 v1','加权聚合完成，服务器得到新的全局模型 v1。',[{op:'create_entity',targetId:'global_v1'},{op:'connect',relationId:'aggregate_v1'},{op:'set_property',targetId:'global_v1',key:'version',value:1},{op:'set_group_members',groupId:'server_side',memberIds:['server','global_v0','aggregate','global_v1']},{op:'focus',targetIds:['aggregate','global_v1']}],[{type:'property',targetId:'global_v1',key:'version',equals:1}]),
    ],invariants:['原始训练数据始终留在客户端。'],misconceptions:['参数更新仍可能泄露信息，联邦学习不等于天然隐私安全。'],claimBoundary:'只展示一轮同步聚合，不声称具体聚合权重或隐私机制。',presentation,provenance:provenance('case_10'),
  },
]
