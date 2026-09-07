"""Bounded, pure operations for composable VisualSpec programs.

No expression evaluation, imports, IO, user code, or model-supplied checks execute
here.  The operation registry is also the source of the authoring capability list.
"""
from __future__ import annotations

import copy
import math
import re
from collections import Counter

MAX_MATRIX = 16
MAX_VECTOR = 128
MAX_OPERATIONS = 24
PATTERNS = (
    'trace', 'comparison', 'decomposition', 'transformation', 'parameter_sweep',
    'counterexample', 'repeated_sampling', 'linked_views', 'predict_observe_explain',
    'invariant_monitor', 'abstraction_ladder', 'tradeoff_exploration',
)
# required arguments, optional defaults, description, result type
OPERATION_CONTRACTS = {
    'conv2d': ({'input': 'matrix', 'kernel': 'matrix'}, {'stride': 1, 'padding': 0},
               '2D single-channel cross-correlation; zero padding, row-major windows; no kernel reversal.', 'matrix'),
    'relu': ({'input': 'numeric tensor'}, {}, 'Elementwise max(0,x), same shape.', 'same shape'),
    'max_pool': ({'input': 'matrix'}, {'size': 2, 'stride': 2}, 'Valid max pooling over square windows; floor output size.', 'matrix'),
    'flatten': ({'input': 'numeric tensor'}, {}, 'Row-major flattening; element count conserved.', 'vector'),
    'reshape': ({'input': 'numeric tensor', 'rows': 'integer', 'columns': 'integer'}, {}, 'Row-major reshape; element count must match.', 'matrix'),
    'transpose': ({'input': 'matrix'}, {}, 'Swap row/column axes.', 'matrix'),
    'matmul': ({'left': 'matrix', 'right': 'matrix'}, {}, 'Matrix multiplication; inner dimensions must match.', 'matrix'),
    'linear': ({'input': 'vector', 'weights': 'matrix'}, {'bias': None}, 'y[o]=sum(weights[o][i]*input[i])+bias[o]; weights shape [out,in].', 'vector'),
    'softmax': ({'input': 'vector'}, {}, 'Stable max-shift softmax; normalizes one vector, not trained-model inference.', 'vector'),
    'add': ({'left': 'numeric tensor', 'right': 'same shape'}, {}, 'Elementwise addition; no implicit broadcasting.', 'same shape'),
    'multiply': ({'left': 'numeric tensor', 'right': 'same shape'}, {}, 'Elementwise product; no implicit broadcasting.', 'same shape'),
    'scale': ({'input': 'numeric tensor', 'factor': 'number'}, {}, 'Multiply each element by one finite scalar.', 'same shape'),
    'global_average_pool': ({'input': 'numeric tensor'}, {}, 'Single-channel global average pooling; returns one-element vector for a following linear layer.', 'vector length 1'),
    'reduce_sum': ({'input': 'numeric tensor'}, {}, 'Sum every element.', 'number'),
    'sort': ({'input': 'vector'}, {'descending': False}, 'Insertion sort trace; finite numeric values; sorted order and multiset checked.', 'vector'),
    'graph_bfs': ({'graph': 'graph', 'start': 'node id'}, {}, 'BFS with lexically ordered neighbors; directed flag respected; shortest distances checked.', 'vector of node ids'),
}


def require(condition, path, reason):
    if not condition:
        raise ValueError(f'{path}: {reason}')


def number(value):
    return type(value) in (int, float) and abs(value) <= 1e100 and math.isfinite(value)


def tensor(value, path):
    if number(value):
        return ()
    require(isinstance(value, list) and 1 <= len(value) <= MAX_VECTOR, path, 'expected nonempty bounded numeric tensor')
    if all(number(x) for x in value):
        return (len(value),)
    require(len(value) <= MAX_MATRIX and all(isinstance(row, list) for row in value), path, 'matrix has at most 16 rows')
    width = len(value[0])
    require(1 <= width <= MAX_MATRIX and all(len(row) == width and all(number(x) for x in row) for row in value), path, 'expected rectangular finite matrix, at most 16 columns')
    return (len(value), width)


def matrix(value, path):
    shape = tensor(value, path)
    require(len(shape) == 2, path, 'expected matrix')
    return shape


def vector(value, path):
    shape = tensor(value, path)
    require(len(shape) == 1, path, 'expected vector')
    return shape[0]


def integer(value, low, high, path):
    require(type(value) is int and low <= value <= high, path, f'expected integer in [{low},{high}]')
    return value


def flatten(value):
    return [v for item in value for v in flatten(item)] if isinstance(value, list) else [value]


def mapped(value, fn):
    return [mapped(x, fn) for x in value] if isinstance(value, list) else fn(value)


def paired(left, right, fn):
    return [paired(a, b, fn) for a, b in zip(left, right)] if isinstance(left, list) else fn(left, right)


def all_cells(value):
    return [[r, c] for r, row in enumerate(value) for c in range(len(row))]


def active_defaults():
    return {
        'input_matrix': [[0]], 'kernel_matrix': [[0]], 'output_matrix': [[0]],
        'active_cells': [], 'output_cells': [], 'computed_cells': [],
        'values': [], 'active_indices': [], 'result': 0,
        'graph': {'nodes': ['state'], 'edges': [], 'directed': False}, 'active_node': None,
        'matrix_visible': False, 'kernel_visible': False, 'array_visible': False,
        'graph_visible': False, 'input_visible': False, 'output_visible': False,
        'expression': '', 'shape': '', 'window_origin': [0, 0],
    }


def project_result(value, active):
    """Populate stable generic primitive inputs without fabricating future results."""
    if isinstance(value, list) and value and isinstance(value[0], list):
        active.update(output_matrix=copy.deepcopy(value), computed_cells=all_cells(value),
                      matrix_visible=True, output_visible=True, shape=f'{len(value)}×{len(value[0])}')
    elif isinstance(value, list):
        active.update(values=copy.deepcopy(value), array_visible=True, shape=str(len(value)))
    elif number(value):
        active['result'] = value
    return active


def frame(active, phase='complete', detail=''):
    return {'active': copy.deepcopy(active), 'phase': phase, 'detail': detail}


def matrix_product(left, right):
    # Straight row/column implementation is deliberately separate from traced loops.
    return [[math.fsum(a*b for a, b in zip(row, col)) for col in zip(*right)] for row in left]


def run_operation(op, args, path):
    require(isinstance(op, str) and op in OPERATION_CONTRACTS, path + '/op', 'unsupported operation')
    required, optional, _, _ = OPERATION_CONTRACTS[op]
    require(isinstance(args, dict) and set(required) <= set(args) <= set(required) | set(optional), path + '/args', f'arguments must be {list(required)} with optional {list(optional)}')
    args = {**copy.deepcopy(optional), **args}
    active = active_defaults()
    trace = []
    ap = path + '/args'
    if op in {'conv2d', 'max_pool'}:
        source = args['input']; h, w = matrix(source, ap + '/input')
        stride = integer(args['stride'], 1, MAX_MATRIX, ap + '/stride')
        if op == 'conv2d':
            kernel = args['kernel']; kh, kw = matrix(kernel, ap + '/kernel')
            padding = integer(args['padding'], 0, 4, ap + '/padding')
        else:
            kh = kw = integer(args['size'], 1, MAX_MATRIX, ap + '/size')
            kernel = [[0]]; padding = 0
        oh, ow = (h + 2*padding - kh)//stride + 1, (w + 2*padding - kw)//stride + 1
        require(1 <= oh <= MAX_MATRIX and 1 <= ow <= MAX_MATRIX, ap, 'window does not fit or output exceeds 16×16')
        require(oh*ow <= 96, ap, 'window trace exceeds 96 cells; use a smaller pedagogical input')
        output = [[0.0 for _ in range(ow)] for _ in range(oh)]
        active.update(input_matrix=source, kernel_matrix=kernel, output_matrix=output,
                      matrix_visible=True, input_visible=True, output_visible=True,
                      kernel_visible=op == 'conv2d', shape=f'{h}×{w} → {oh}×{ow}')
        trace.append(frame(active, 'start', '输出中的未计算单元格保持空白。'))
        for r in range(oh):
            for c in range(ow):
                cells, patch, products = [], [], []
                for kr in range(kh):
                    row = []
                    for kc in range(kw):
                        ir, ic = r*stride + kr-padding, c*stride + kc-padding
                        x = source[ir][ic] if 0 <= ir < h and 0 <= ic < w else 0
                        row.append(x)
                        if 0 <= ir < h and 0 <= ic < w:
                            cells.append([ir, ic])
                        products.append(x*kernel[kr][kc] if op == 'conv2d' else x)
                    patch.append(row)
                result = sum(products) if op == 'conv2d' else max(products)
                # A dot-product oracle using fsum is independent of accumulation order.
                oracle = math.fsum(x*y for x, y in zip(flatten(patch), flatten(kernel))) if op == 'conv2d' else sorted(flatten(patch))[-1]
                require(math.isclose(result, oracle, rel_tol=1e-10, abs_tol=1e-10), path, 'window oracle mismatch')
                output[r][c] = result
                active.update(output_matrix=output, active_cells=cells, output_cells=[[r, c]],
                              result=result, window_origin=[r*stride-padding, c*stride-padding],
                              expression=(' + '.join(f'{x:g}×{y:g}' for x, y in zip(flatten(patch), flatten(kernel))) if op == 'conv2d' else 'max(' + ', '.join(f'{x:g}' for x in flatten(patch)) + ')') + f' = {result:g}')
                active['computed_cells'].append([r, c])
                trace.append(frame(active, 'window', f'输出[{r},{c}] = {result:g}；窗口起点 {active["window_origin"]}。'))
        # Independent oracle builds a padded grid and slices windows rather than
        # reusing the trace's coordinate/bounds branch or its collected patch.
        padded = [[0]*(w+2*padding) for _ in range(padding)] + [[0]*padding + row[:] + [0]*padding for row in source] + [[0]*(w+2*padding) for _ in range(padding)]
        for r in range(oh):
            for c in range(ow):
                window = [row[c*stride:c*stride+kw] for row in padded[r*stride:r*stride+kh]]
                oracle = math.fsum(a*b for a, b in zip(flatten(window), flatten(kernel))) if op == 'conv2d' else sorted(flatten(window))[-1]
                require(math.isclose(output[r][c], oracle, rel_tol=1e-10, abs_tol=1e-10), path, 'independent padded-window oracle mismatch')
        result = output
        active.update(active_cells=[], output_cells=[])
    elif op in {'matmul', 'linear'}:
        if op == 'matmul':
            left, right = args['left'], args['right']
            m, k = matrix(left, ap + '/left'); kr, n = matrix(right, ap + '/right')
            require(k == kr, ap, 'inner dimensions must match')
            bias = [0]*n
        else:
            x, weights = args['input'], args['weights']
            k = vector(x, ap + '/input'); n, kw = matrix(weights, ap + '/weights')
            require(k == kw, ap, 'weights columns must match input length')
            bias = args['bias'] if args['bias'] is not None else [0]*n
            require(vector(bias, ap + '/bias') == n, ap + '/bias', 'bias length must match output length')
            left, right, m = [x], [list(col) for col in zip(*weights)], 1
        require(m*n <= 96, ap, 'matrix-product trace exceeds 96 cells')
        output = [[0.0]*n for _ in range(m)]
        active.update(input_matrix=left, kernel_matrix=right, output_matrix=output,
                      matrix_visible=True, kernel_visible=True, input_visible=True, output_visible=True)
        trace.append(frame(active, 'start'))
        for r in range(m):
            for c in range(n):
                output[r][c] = sum(left[r][i]*right[i][c] for i in range(k)) + bias[c]
                active.update(result=output[r][c], active_cells=[[r, i] for i in range(k)], output_cells=[[r, c]])
                active['computed_cells'].append([r, c])
                trace.append(frame(active, 'window', f'行 {r} 与列 {c} 点乘得到 {output[r][c]:g}。'))
        oracle = matrix_product(left, right)
        require(all(math.isclose(output[r][c], oracle[r][c]+bias[c], rel_tol=1e-10, abs_tol=1e-10) for r in range(m) for c in range(n)), path, 'matrix product oracle mismatch')
        result = output[0] if op == 'linear' else output
        active.update(active_cells=[], output_cells=[])
    elif op == 'graph_bfs':
        graph = args['graph']
        require(isinstance(graph, dict) and {'nodes', 'edges'} <= set(graph) <= {'nodes', 'edges', 'directed', 'labels'}, ap + '/graph', 'graph shape')
        nodes, edges = graph['nodes'], graph['edges']; directed = graph.get('directed', False)
        require(isinstance(nodes, list) and 1 <= len(nodes) <= 24 and all(isinstance(n, str) and 0 < len(n) <= 40 for n in nodes) and len(set(nodes)) == len(nodes), ap + '/graph/nodes', 'expected unique bounded node ids')
        require(type(directed) is bool and isinstance(edges, list) and len(edges) <= 64 and all(isinstance(e, list) and len(e) == 2 and all(n in nodes for n in e) for e in edges), ap + '/graph/edges', 'invalid graph edges')
        require(args['start'] in nodes, ap + '/start', 'unknown start')
        adjacency = {n: set() for n in nodes}
        for a, b in edges:
            adjacency[a].add(b)
            if not directed: adjacency[b].add(a)
        queue, order, distances = [args['start']], [], {args['start']: 0}
        active.update(graph=graph, graph_visible=True, array_visible=True, values=queue.copy())
        trace.append(frame(active, 'start', '队列从左侧出队，右侧入队。'))
        while queue:
            node = queue.pop(0); order.append(node)
            for neighbor in sorted(adjacency[node]):
                if neighbor not in distances:
                    distances[neighbor] = distances[node] + 1; queue.append(neighbor)
            active.update(active_node=node, values=queue.copy(), result=distances[node])
            trace.append(frame(active, 'visit', f'访问 {node}，最短边数 {distances[node]}。'))
        oracle = {n: math.inf for n in nodes}; oracle[args['start']] = 0
        for _ in nodes:
            for a, b in edges:
                oracle[b] = min(oracle[b], oracle[a]+1)
                if not directed: oracle[a] = min(oracle[a], oracle[b]+1)
        require(distances == {n: d for n, d in oracle.items() if math.isfinite(d)}, path, 'BFS distance oracle mismatch')
        result = order
    else:
        source = args.get('input', args.get('left'))
        shape = tensor(source, ap + ('/left' if 'left' in args else '/input'))
        if len(shape) == 2:
            active.update(input_matrix=source, input_visible=True)
        if op == 'relu': result = mapped(source, lambda x: max(0, x))
        elif op == 'flatten': result = flatten(source)
        elif op == 'reshape':
            r = integer(args['rows'], 1, MAX_MATRIX, ap + '/rows')
            c = integer(args['columns'], 1, MAX_MATRIX, ap + '/columns')
            values = flatten(source)
            require(len(values) == r*c, ap, 'reshape must conserve element count')
            result = [values[i*c:(i+1)*c] for i in range(r)]
        elif op == 'transpose':
            matrix(source, ap + '/input'); result = [list(row) for row in zip(*source)]
        elif op == 'softmax':
            vector(source, ap + '/input')
            exp = [math.exp(v-max(source)) for v in source]; total = math.fsum(exp)
            result = [v/total for v in exp]
            require(all(0 <= v <= 1 for v in result) and math.isclose(math.fsum(result), 1, rel_tol=1e-12), path, 'softmax mass invariant')
        elif op in {'add', 'multiply'}:
            require(tensor(args['right'], ap + '/right') == shape, ap, 'elementwise shapes must match; broadcasting is not implicit')
            result = paired(source, args['right'], (lambda a, b: a+b) if op == 'add' else (lambda a, b: a*b))
        elif op == 'scale':
            require(number(args['factor']), ap + '/factor', 'expected finite scalar'); result = mapped(source, lambda x: x*args['factor'])
        elif op == 'global_average_pool': result = [math.fsum(flatten(source))/len(flatten(source))]
        elif op == 'reduce_sum': result = math.fsum(flatten(source))
        elif op == 'sort':
            vector(source, ap + '/input'); require(type(args['descending']) is bool, ap + '/descending', 'expected boolean')
            result = source.copy(); active.update(values=result, array_visible=True)
            trace.append(frame(active, 'start'))
            for i in range(1, len(result)):
                j = i
                while j > 0 and ((result[j-1] < result[j]) if args['descending'] else (result[j-1] > result[j])):
                    result[j-1], result[j] = result[j], result[j-1]; j -= 1
                active.update(values=result, active_indices=list(range(j, i+1)))
                trace.append(frame(active, 'insert', f'将位置 {i} 的元素插入有序前缀，落在位置 {j}。'))
            require(Counter(result) == Counter(source) and result == sorted(source, reverse=args['descending']), path, 'sort permutation/order invariant')
        else: raise ValueError(path + '/op: unsupported operation')
        if op != 'sort': trace.append(frame(active, 'start'))
    # Guard numeric growth and shape before publishing any completed result.
    if op != 'graph_bfs':
        tensor(result, path + '/result')
    active = project_result(result, active)
    active['active_indices'] = []
    trace.append(frame(active, 'complete', '本步运算完成。'))
    return copy.deepcopy(result), trace


def operation_manifest():
    return [{
        'id': op, 'version': '1.0.0', 'required_args': required,
        'optional_args': optional, 'description': description, 'result': result,
    } for op, (required, optional, description, result) in OPERATION_CONTRACTS.items()]


def operation_narration(op, arguments, result, phase, detail):
    """Describe actual registered semantics; author notes are retained separately."""
    args = {**OPERATION_CONTRACTS[op][1], **arguments}

    def shape(value):
        if not isinstance(value, list):
            return '标量'
        if value and isinstance(value[0], list):
            return f'{len(value)}×{len(value[0])} 矩阵'
        return f'长度 {len(value)} 的向量'

    if op == 'conv2d':
        caption = f'用同一个 {shape(args["kernel"])} 卷积核对 {shape(args["input"])} 做互相关（不翻转核）；步长 {args["stride"]}，零填充 {args["padding"]}，输出为 {shape(result)}。'
    elif op == 'relu':
        caption = f'对当前输入逐元素计算 max(0, x)：负数变为零，非负数保持不变；输出保持为 {shape(result)}。'
    elif op == 'max_pool':
        caption = f'在当前输入的每个 {args["size"]}×{args["size"]} 窗口取最大值，步长 {args["stride"]}，不填充；输出为 {shape(result)}。'
    elif op == 'flatten':
        caption = f'把 {shape(args["input"])} 按逐行顺序展平为 {shape(result)}，元素与顺序保持不变。'
    elif op == 'reshape':
        caption = f'把 {shape(args["input"])} 按逐行顺序重排为 {shape(result)}，元素总数保持不变。'
    elif op == 'transpose':
        caption = f'交换当前输入矩阵的行与列：输入为 {shape(args["input"])}，输出为 {shape(result)}；输出位置 [j,i] 对应输入位置 [i,j]。'
    elif op == 'matmul':
        caption = f'计算左侧 {shape(args["left"])} 与右侧 {shape(args["right"])} 的矩阵乘积；每个输出单元格由左行与右列点乘得到，输出为 {shape(result)}。'
    elif op == 'linear':
        caption = f'将当前 {shape(args["input"])} 做线性变换：每个输出是一个权重行与输入的点乘再加偏置；图中权重按参与点乘的转置方向显示，输出为 {shape(result)}。'
    elif op == 'softmax':
        caption = '对当前输入向量减去最大值后取指数，再除以指数总和，得到总和为一的当前概率向量；这一步归一化本身不证明模型预测准确。'
    elif op == 'add':
        caption = f'对两个同形状输入逐元素相加，不进行隐式广播；输出为 {shape(result)}。'
    elif op == 'multiply':
        caption = f'对两个同形状输入逐元素相乘，不进行隐式广播；输出为 {shape(result)}。'
    elif op == 'scale':
        caption = f'将当前输入的每个元素乘以系数 {args["factor"]:g}，输出保持为 {shape(result)}。'
    elif op == 'global_average_pool':
        caption = f'对当前单通道输入的全部元素求平均值，得到 {shape(result)}；输入空间大小可以变化。'
    elif op == 'reduce_sum':
        caption = '将当前输入的全部元素相加，输出一个标量。'
    elif op == 'sort':
        direction = '降序' if args['descending'] else '升序'
        caption = f'使用插入排序把当前数组按{direction}排列：每次把一个元素插入已有序的前缀；元素及其出现次数保持不变。'
    elif op == 'graph_bfs':
        direction = '沿有向边' if args['graph'].get('directed', False) else '沿无向边'
        caption = f'从节点 {args["start"]} 开始{direction}广度优先搜索，同层邻居按节点标识排序；队列左侧出队、右侧入队，每个节点首次发现时确定最短边数。'
    else:
        raise ValueError('unsupported operation narration')
    phase_label = {'start': '准备运算', 'window': '计算当前窗口', 'complete': '本步运算完成', 'insert': '插入有序前缀', 'visit': '访问当前节点'}[phase]
    suffix = '' if detail in ('', '本步运算完成。') else ' ' + detail
    return caption + ' ' + phase_label + '。' + suffix


def pipeline(program, env, pointer, cap):
    require(isinstance(program, dict) and set(program) == {'steps'}, '/data/program', 'expected {steps:[...]}')
    steps = program['steps']
    require(isinstance(steps, list) and 1 <= len(steps) <= MAX_OPERATIONS, '/data/program/steps', 'expected 1 to 24 operations')
    seen, results, states = set(), {}, []

    def resolve(value, path):
        if isinstance(value, dict):
            if 'source' in value:
                require(set(value) == {'source'} and isinstance(value['source'], str), path, 'binding must contain only source')
                source = value['source']
                require(source.startswith(('/data/', '/params/', '/state/results/')), path, 'only data, params and completed earlier results may be read')
                try: return copy.deepcopy(pointer({**env, 'state': {'results': results}}, source))
                except ValueError as error: raise ValueError(f'{path}: {error}') from error
            return {k: resolve(v, path + '/' + k) for k, v in value.items()}
        if isinstance(value, list): return [resolve(v, path + '/' + str(i)) for i, v in enumerate(value)]
        return value

    for index, step in enumerate(steps):
        path = f'/data/program/steps/{index}'
        require(isinstance(step, dict) and {'id', 'op', 'args', 'title', 'narration'} <= set(step) <= {'id', 'op', 'args', 'title', 'narration'}, path, 'expected id,op,args,title,narration')
        ident = step['id']
        require(isinstance(ident, str) and re.fullmatch(r'[a-z][a-z0-9_.-]{0,79}', ident) and ident not in seen and ident not in {'constructor', 'prototype'}, path + '/id', 'invalid or duplicate operation id')
        require(all(isinstance(step[k], str) and 0 < len(step[k]) <= 2000 for k in ('title', 'narration')), path, 'title and narration must be bounded text')
        args = resolve(step['args'], path + '/args')
        result, frames = run_operation(step['op'], args, path)
        require(len(states) + len(frames) <= cap, path, 'resource budget: trace exceeds max_steps; reduce input or operation count')
        for local in frames:
            if local['phase'] == 'complete': results[ident] = result
            states.append({
                'step': len(states), 'title': step['title'],
                'narration': operation_narration(step['op'], args, result, local['phase'], local['detail']),
                'authored_note': step['narration'],
                'operation_id': ident, 'operation': step['op'], 'phase': local['phase'],
                'results': copy.deepcopy(results), 'active': local['active'],
            })
        seen.add(ident)
    return states


def sequence(stages, cap):
    require(isinstance(stages, list) and 1 <= len(stages) <= cap, '/data/stages', 'authored sequence must have 1 to max_steps stages')
    states, seen = [], set()
    for index, stage in enumerate(stages):
        path = f'/data/stages/{index}'
        require(isinstance(stage, dict) and set(stage) == {'id', 'title', 'narration', 'content'}, path, 'expected id,title,narration,content')
        ident = stage['id']
        require(isinstance(ident, str) and re.fullmatch(r'[a-z][a-z0-9_.-]{0,79}', ident) and ident not in seen, path + '/id', 'invalid or duplicate stage id')
        require(all(isinstance(stage[k], str) and 0 < len(stage[k]) <= 2000 for k in ('title', 'narration')), path, 'title and narration must be bounded text')
        require(isinstance(stage['content'], dict) and not set(stage['content']) & {'step', 'stage_id', 'title', 'narration'}, path + '/content', 'content cannot replace runtime identity or narration')
        states.append({**copy.deepcopy(stage['content']), 'step': index, 'stage_id': ident,
                       'title': stage['title'], 'narration': stage['narration']})
        seen.add(ident)
    return states
