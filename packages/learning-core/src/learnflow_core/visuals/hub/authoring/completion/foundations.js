/* Authored teaching mechanisms. Candidate status is assigned only by host review. */
{
    const range = (id, label, min, max, value, step = 1) => ({ id, label, type: 'range', min, max, step, value });
    const choice = (id, label, items, value) => ({ id, label, type: 'select', options: items.map(([value, label]) => ({ value, label })), value: value || items[0][0] });
    const frame = (svg, note, values) => ({ svg, note, values });
    const round = n => Math.round(n * 10000) / 10000;
    const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const curve = (f, a, b, n = 81) => seq(n, i => { const x = a + (b - a) * i / (n - 1); return [x, f(x)]; });
    const plot = (series, extra = {}) => Viz.plot({ series, ...extra });
    const pointPlot = (f, a, b, points = [], label = '函数') => plot([{ points: curve(f, a, b), label }], { points });
    const sum = a => a.reduce((s, x) => s + x, 0);
    const add = (session, title, question, controls, scope, takeaway, compute) => register({ id: 'course-' + session.replace(/\./g, '-'), session, title, question, description: takeaway, controls, scope, takeaway, compute });
    const result = (svg, note, values) => ({ frames: [frame(svg, note, values)] });
    const graph = (labels, edges, active = [], layout = 'flow') => Viz.graph({ nodes: labels.map((label, i) => ({ id: String(i), label: String(label), active: active.includes(i) })), edges: edges.map(([a, b, label]) => ({ from: String(a), to: String(b), label: String(label ?? '') })), directed: true, layout });
    function rng(seed) { let x = seed >>> 0; return () => { x = (1664525 * x + 1013904223) >>> 0; return x / 4294967296; }; }
    function gantt(rows, total) { const w = 510 / Math.max(1, total); return Viz.svg(rows.map((row, i) => Viz.text(40, 45 + i * 55, row.name, 13) + row.slots.map(([a, b, label]) => Viz.rect(80 + a * w, 25 + i * 55, Math.max(1, (b - a) * w), 32, Viz.colors[i % 5], '#fff') + Viz.text(80 + (a + b) / 2 * w, 46 + i * 55, label, 12)).join('')).join('') + Viz.text(330, rows.length * 55 + 35, '时间 → 0 … ' + total, 12), 600, rows.length * 55 + 65); }
    function table(headers, rows) { const w = 550 / headers.length; return Viz.svg([headers, ...rows].map((row, r) => row.map((v, c) => Viz.rect(25 + c * w, 20 + r * 34, w, 34, r ? '#f3f7f5' : '#dcebe5', '#bccdc4') + Viz.text(25 + (c + .5) * w, 42 + r * 34, String(v), 13)).join('')).join(''), 600, 55 + (rows.length + 1) * 34); }
    add('math-functions.c1.s1', '绝对值是距离，不是去掉负号的口令', '改变中心以后，|x−a| 的几何意义还相同吗？', [range('x', '位置 x', -8, 8, 3), range('a', '区间中心 a', -4, 4, 0)], '实数轴；闭区间 [a−2,a+2]。', 'x 与 a 的距离是 |x−a|；区间边界上的点也属于闭区间。', p => { const d = Math.abs(p.x - p.a); return result(plot([], { segments: [[-9, 0, 9, 0], [p.a - 2, 0, p.a + 2, 0], [p.a, 0.4, p.x, 0.4]], points: [[p.x, 0], [p.a, 0]], xDomain: [-9, 9], yDomain: [-1, 1], xLabel: '数轴' }), `|${p.x}−${p.a}|=${d}，${d <= 2 ? '属于' : '不属于'}闭区间 [${p.a - 2},${p.a + 2}]。把 x 移到边界，检验 ≤ 与 < 的区别。`, { distance: d, inside: d <= 2 }); });
    add('math-functions.c1.s2', '坐标尺度改变后，距离怎样变化', '横轴拉伸会把直线距离和网格距离一起改变吗？', [range('x', '横向坐标', 1, 6, 3), range('scale', '横向单位尺度', .5, 3, 1, .5)], '固定点 (x,4)，横向每单位实际长 scale；比较欧氏与曼哈顿度量。', '先换算单位再求距离；图上接近不等于实际代价相同。', p => { const x = p.x * p.scale, d = Math.hypot(x, 4); return result(plot([], { segments: [[0, 0, x, 4], [0, 0, x, 0], [x, 0, x, 4]], points: [[0, 0], [x, 4]], equalAspect: true, xDomain: [0, 18], yDomain: [0, 6], xLabel: '实际横向长度', yLabel: '实际纵向长度' }), `直线距离 √(${x}²+4²)=${round(d)}；沿网格走 ${x + 4}。只有一轴位移为0时两种距离才相等。`, { euclidean: d, manhattan: x + 4 }); });
    add('math-functions.c2.s1', '函数把每个输入映射到唯一输出', '同一个输入能否对应两个输出？', [choice('model', '关系', [['linear', 'y=2x+1'], ['square', 'y=x²'], ['circle', 'x²+y²=9（反例）']]), range('x', '输入 x', -3, 3, 1, .25)], '实数关系的垂直线检验；圆在区间[-3,3]内显示。', '多对一可以是函数，一对多不可以；平方丢失符号但仍是函数。', p => { let ys, series; if (p.model === 'circle') {
        const y = Math.sqrt(Math.max(0, 9 - p.x * p.x));
        ys = y === 0 ? [0] : [y, -y];
        series = [{ points: curve(x => Math.sqrt(Math.max(0, 9 - x * x)), -3, 3), label: '上半圆' }, { points: curve(x => -Math.sqrt(Math.max(0, 9 - x * x)), -3, 3), label: '下半圆' }];
    }
    else {
        const f = p.model === 'square' ? x => x * x : x => 2 * x + 1;
        ys = [f(p.x)];
        series = [{ points: curve(f, -3, 3), label: 'y=f(x)' }];
    } return result(plot(series, { points: ys.map(y => [p.x, y]), segments: [[p.x, -4, p.x, 10]], equalAspect: p.model === 'circle', xDomain: [-3, 3], yDomain: p.model === 'circle' ? [-4, 4] : [-4, 10] }), `x=${p.x} 的输出为 ${ys.map(round).join('、')}。${p.model === 'circle' ? '圆整体不是 y 关于 x 的函数；端点恰好只有一个交点也不能证明整体是函数。' : '一个输入只有一个输出；不同输入可以得到相同输出。'}`, { outputs: ys, isFunction: p.model !== 'circle' }); });
    add('math-functions.c3.s1', '指数与对数：同一映射的往返', '底数改变时，指数增长和对数逆映射怎样对应？', [range('base', '底数 b', 1.2, 3, 2, .2), range('x', '指数 x', 0, 4, 2, .25)], 'b>1，log_b 在正数上定义；纵轴仅显示选定区间。', '指数把加法变成乘法，对数把倍数差异还原为加法差异。', p => { const y = p.base ** p.x; return result(plot([{ points: curve(x => p.base ** x, 0, 4), label: 'b^x' }, { points: curve(x => Math.log(x) / Math.log(p.base), .1, 4), label: 'log_b(x)' }], { points: [[p.x, y]], xDomain: [0, 4], yDomain: [-4, Math.max(5, p.base ** 4)] }), `b^x=${round(y)}，log_b(b^x)=${round(Math.log(y) / Math.log(p.base))}；b^(x+1)/b^x=${round(p.base)}。b=1 不存在这样的对数逆映射。`, { exponential: y, inverse: Math.log(y) / Math.log(p.base), ratio: p.base }); });
    add('math-functions.c3.s2', '正弦波的频率和相位', '频率改变会缩短周期，还是只移动波形？', [range('frequency', '频率', 1, 4, 1), range('phase', '相位 φ', 0, 6.28, 0, .314)], '连续信号 sin(2πft+φ)，幅度固定1，时间范围0到2秒。', '相位移动起点，频率决定每秒重复次数；两者不应混为一谈。', p => result(plot([{ points: curve(t => Math.sin(2 * Math.PI * p.frequency * t + p.phase), 0, 2, 161), label: '当前信号' }, { points: curve(t => Math.sin(2 * Math.PI * t), 0, 2, 161), label: '1 Hz，零相位' }], { xLabel: '秒', yDomain: [-1.2, 1.2] }), `当前周期 T=${round(1 / p.frequency)} 秒，t=0 时 y=${round(Math.sin(p.phase))}。相位加2π后波形相同；频率翻倍则周期减半。`, { period: 1 / p.frequency, initial: Math.sin(p.phase) }));
    add('math-calculus.c1.s1', '函数值与极限可以不同', '挖掉一个点，附近的趋势会改变吗？', [range('h', '靠近距离 h', .01, 1, .2, .01), choice('case', '函数', [['hole', 'x²，但 f(1)=3'], ['jump', 'x<1 为0，否则为2'], ['smooth', 'x²']])], '比较 x→1 的两侧采样；有限采样展示机制，不构成一般极限证明。', '连续需要极限存在且等于函数值；只改一个点不会改变邻域极限。', p => { const f = x => p.case === 'jump' ? (x < 1 ? 0 : 2) : x * x; const value = p.case === 'hole' ? 3 : f(1), left = f(1 - p.h), right = f(1 + p.h); return result(plot(p.case === 'jump' ? [{ points: [[0, 0], [1, 0]], label: 'x<1' }, { points: [[1, 2], [2, 2]], label: 'x≥1' }] : [{ points: curve(f, 0, 2), label: '邻域曲线' }], { points: [[1 - p.h, left], [1 + p.h, right], [1, value]], openPoints: p.case === 'hole' ? [[1, 1]] : p.case === 'jump' ? [[1, 0]] : [], xDomain: [0, 2], yDomain: p.case === 'jump' ? [-.3, 2.5] : [0, 4] }), `左样本 ${round(left)}，右样本 ${round(right)}，f(1)=${value}。${p.case === 'jump' ? '两侧分别趋向0和2，双侧极限不存在。' : p.case === 'hole' ? '两侧趋向1但点值为3，因此不连续。' : '两侧趋向1且函数值也是1。'}`, { left, right, value, limit: p.case === 'jump' ? null : 1, continuous: p.case === 'smooth' }); });
    add('math-calculus.c2.s1', '黎曼和怎样逼近面积', '增加矩形数量后，左端点与右端点的误差如何变化？', [range('n', '矩形数量', 2, 24, 6), choice('side', '取样位置', [['left', '左端点'], ['right', '右端点'], ['mid', '中点']])], 'f(x)=x²，区间[0,1]；精确积分1/3。', '单调函数的左和、右和分别低估和高估；中点并不对所有函数都精确。', p => { const offset = p.side === 'left' ? 0 : p.side === 'right' ? 1 : .5, heights = seq(p.n, i => ((i + offset) / p.n) ** 2), area = sum(heights) / p.n; let body = ''; heights.forEach((h, i) => { body += Viz.rect(45 + i * 500 / p.n, 270 - h * 220, 500 / p.n, Math.max(.1, h * 220), '#b5dcd7'); }); body += Viz.line(45, 270, 550, 270) + Viz.text(300, 305, '每个矩形宽度 1/' + p.n, 13); return result(Viz.svg(body), `矩形面积和 ${round(area)}，精确值 1/3，误差 ${round(area - 1 / 3)}。切换取样位置，看误差方向改变。`, { area, exact: 1 / 3, error: area - 1 / 3 }); });
    add('math-calculus.c2.s2', '累积函数的斜率来自哪里', '移动积分上限时，新增面积怎样变成导数？', [range('x', '积分上限 x', .5, 4, 2, .1), range('h', '上限增量 h', .02, .8, .2, .02)], 'f(t)=2t，F(x)=∫₀ˣ2t dt=x²；用差商观察基本定理。', '累积面积的瞬时变化率是上边界的函数高度，不是平均高度。', p => { const F = p.x * p.x, difference = ((p.x + p.h) ** 2 - F) / p.h; return result(plot([{ points: curve(t => t * t, 0, 5), label: '面积函数 F(x)' }, { points: curve(t => 2 * p.x * (t - p.x) + F, Math.max(0, p.x - .7), Math.min(5, p.x + .7)), label: '切线' }], { points: [[p.x, F], [p.x + p.h, (p.x + p.h) ** 2]], xDomain: [0, 5], yDomain: [0, 25] }), `ΔF/h=${round(difference)}，f(x)=2x=${round(2 * p.x)}，差=${round(p.h)}。缩小h，差商趋向边界高度。`, { area: F, differenceQuotient: difference, derivative: 2 * p.x }); });
    add('math-calculus.c3.s1', '梯度为何指向最快上升方向', '同一点换一个方向，变化率如何改变？', [range('x', '位置 x', -2, 2, 1, .25), range('angle', '方向角 θ', 0, 360, 45, 15)], '曲面 f(x,y)=x²+2y²，固定y=1；方向向量单位化。', '偏导是沿坐标轴的变化率；梯度与单位方向点乘得到方向导数。', p => { const a = p.angle * Math.PI / 180, u = [Math.cos(a), Math.sin(a)], g = [2 * p.x, 4], d = g[0] * u[0] + g[1] * u[1]; return result(plot([], { segments: [[0, 0, ...g], [0, 0, u[0] * 3, u[1] * 3]], points: [g, [u[0] * 3, u[1] * 3]], equalAspect: true, xDomain: [-5, 5], yDomain: [-5, 5], xLabel: '梯度与方向（方向线放大3倍）' }), `∇f=(${g})，单位方向=(${u.map(round)})，方向导数=${round(d)}。方向反转时符号反转；与梯度垂直时为0。`, { gradient: g, unit: u, directional: d }); });
    add('math-calculus.c3.s2', '链式法则沿路径累乘', '中间变化快，最终变化一定更快吗？', [range('t', '路径参数 t', -.9, 2, 1, .1), choice('path', '路径', [['line', 'x=t,y=t'], ['curve', 'x=t,y=t²']])], '复合函数 f=x²+y²；解析求导与中心差分相互核对。', '各分支的局部导数乘路径速度后相加；方向导数需要单位方向，而路径导数含速度。', p => { const t = p.t, y = p.path === 'line' ? t : t * t, dx = 1, dy = p.path === 'line' ? 1 : 2 * t, d = 2 * t * dx + 2 * y * dy; const f = s => s * s + (p.path === 'line' ? s * s : s ** 4), eps = .0001, numerical = (f(t + eps) - f(t - eps)) / (2 * eps); return result(graph([`t=${round(t)}`, `x=${round(t)}`, `y=${round(y)}`, `f=${round(f(t))}`], [[0, 1, 'dx/dt=1'], [0, 2, 'dy/dt=' + round(dy)], [1, 3, '2x'], [2, 3, '2y']]), `df/dt=2x·1+2y·${round(dy)}=${round(d)}；中心差分=${round(numerical)}。t=0时输出变化率为0，即使dx/dt=1。`, { derivative: d, numerical, value: f(t) }); });
    add('math-linear.c1.s1', '线性组合：沿两个向量搭出终点', '系数为负时，几何路径怎样变化？', [range('a', '向量 u 的系数', -3, 3, 1, .5), range('b', '向量 v 的系数', -3, 3, 1, .5)], 'u=(2,1)，v=(-1,2)，二维实向量。', '缩放再相加，终点与平移后的首尾相接路径一致；负系数反向。', p => { const u = [2 * p.a, p.a], v = [-p.b, 2 * p.b], out = [u[0] + v[0], u[1] + v[1]]; return result(plot([], { segments: [[0, 0, ...u], [...u, ...out], [0, 0, ...out]], points: [u, out], equalAspect: true, xDomain: [-10, 10], yDomain: [-10, 10] }), `${p.a}(2,1)+${p.b}(-1,2)=(${out})。试把一个系数改为0，再改为负数，比较终点移动方向。`, { u, v, result: out }); });
    add('math-linear.c1.s2', '两根向量何时真的张成平面', '两根不同长度的箭头一定构成二维基吗？', [range('s', '两向量分离量 s', 0, 2, 1, .25), range('target', '目标点高度', -2, 2, 1, .25)], 'u=(1,s)，v=(1,-s)，目标(0,h)；s=0为共线反例。', '向量数量不等于维数；共线时无法表示线外目标。', p => { const u = [1, p.s], v = [1, -p.s], det = -2 * p.s, possible = p.s !== 0 || p.target === 0; return result(plot([], { segments: [[0, 0, ...u], [0, 0, ...v]], points: [[0, p.target]], equalAspect: true, xDomain: [-3, 3], yDomain: [-3, 3] }), `det[u v]=${det}，张成维数=${p.s === 0 ? 1 : 2}。目标${possible ? '可表示' : '不可表示'}${p.s ? `：系数 (${round(p.target / (2 * p.s))},${round(-p.target / (2 * p.s))})` : ''}。`, { rank: p.s === 0 ? 1 : 2, det, possible, coefficients: p.s ? [p.target / (2 * p.s), -p.target / (2 * p.s)] : null }); });
    add('math-linear.c2.s2', '方程组的交点、零空间和秩', '两条约束平行后，是无解还是无限多解？', [range('a', '第二条线的斜率系数', .5, 1.5, 1, .1), range('b', '第二条线的右端值', 1, 3, 2, .25)], '方程 x+y=2，x+a·y=b；用解析行列式判别。', '秩降低时必须再检查右端项是否一致，不能一律说无解。', p => { const singular = Math.abs(p.a - 1) < 1e-9, consistent = Math.abs(p.b - 2) < 1e-9; const solution = singular ? null : [2 - (p.b - 2) / (p.a - 1), (p.b - 2) / (p.a - 1)]; const xmin = Math.min(-4, solution ? solution[0] - 1 : -4), xmax = Math.max(5, solution ? solution[0] + 1 : 5), ymin = Math.min(-4, solution ? solution[1] - 1 : -4), ymax = Math.max(5, solution ? solution[1] + 1 : 5); return result(plot([{ points: curve(x => 2 - x, xmin, xmax), label: 'x+y=2' }, { points: curve(x => (p.b - x) / p.a, xmin, xmax), label: 'x+a y=b' }], { points: solution ? [solution] : [], equalAspect: true, xDomain: [xmin, xmax], yDomain: [ymin, ymax] }), singular ? `秩1，零空间沿(1,-1)。${consistent ? '两线重合，无穷多解。' : '两线平行但不重合，无解。'}` : `秩2，唯一解 (${solution.map(round)})，零空间只有零向量。`, { rank: singular ? 1 : 2, solution, solutionCount: singular ? (consistent ? 'infinite' : 'none') : 'one', nullity: singular ? 1 : 0 }); });
    add('math-linear.c3.s1', '特征向量为何不改变所在直线', '所有向量经过矩阵后都只缩放吗？', [range('lambda', '纵向特征值', -2, 2, 1, .5), range('angle', '输入方向角', 0, 180, 45, 15)], 'A=diag(3,λ)，输入为单位向量；λ范围避开重复特征值3。', '沿特征方向只缩放或反向；一般方向会偏转，零向量不是特征向量。', p => { const t = p.angle * Math.PI / 180, v = [Math.cos(t), Math.sin(t)], out = [3 * v[0], p.lambda * v[1]], cross = v[0] * out[1] - v[1] * out[0]; return result(plot([], { segments: [[0, 0, ...v], [0, 0, ...out]], points: [v, out], equalAspect: true, xDomain: [-4, 4], yDomain: [-3, 3] }), `v=(${v.map(round)})，Av=(${out.map(round)})；二维叉积=${round(cross)}。${Math.abs(cross) < 1e-8 ? '输入是特征方向。' : '方向改变，因此不是特征向量。'}负特征值会反向。`, { vector: v, transformed: out, eigenDirection: Math.abs(cross) < 1e-8 }); });
    add('math-linear.c3.s2', '截断奇异值如何压扁空间', '保留最大奇异值，丢失的到底是什么？', [range('small', '第二奇异值 σ₂', 0, 2, 1, .25), choice('rank', '保留秩', [['one', '秩1近似'], ['two', '完整秩2']])], '合成矩阵 A=diag(3,σ₂)，奇异值可直接读出；不是任意图像压缩实现。', '截断最小奇异值丢掉该方向的信息；误差由被丢弃的奇异值决定。', p => { const second = p.rank === 'one' ? 0 : p.small; return result(plot([{ points: seq(101, i => [3 * Math.cos(i * 2 * Math.PI / 100), p.small * Math.sin(i * 2 * Math.PI / 100)]), label: '完整变换' }, { points: seq(101, i => [3 * Math.cos(i * 2 * Math.PI / 100), second * Math.sin(i * 2 * Math.PI / 100)]), label: '当前近似' }], { equalAspect: true, xDomain: [-3.5, 3.5], yDomain: [-2.5, 2.5] }), `奇异值 (3,${p.small})；Frobenius误差=${p.rank === 'one' ? p.small : 0}。σ₂=0 时秩1已经精确；σ₂增大时丢弃方向变得重要。`, { singularValues: [3, p.small], rank: second === 0 ? 1 : 2, error: p.rank === 'one' ? p.small : 0 }); });
    add('math-discrete.c1.s1', '蕴含式为什么在前件为假时为真', '“如果 P 那么 Q”何时被真正反驳？', [choice('formula', '公式', [['implies', 'P → Q'], ['and', 'P ∧ Q'], ['xor', 'P 异或 Q']]), range('row', '选择输入行', 0, 3, 2)], '经典二值命题逻辑；不模拟日常语言的因果或相关性。', '蕴含只有真前件、假后件这一行是假；并不表达P导致Q。', p => { const rows = seq(4, i => { const a = Boolean(i & 2), b = Boolean(i & 1), v = p.formula === 'and' ? a && b : p.formula === 'xor' ? a !== b : !a || b; return [Number(a), Number(b), Number(v)]; }); return result(Viz.matrix(rows, { active: [p.row * 3, p.row * 3 + 1, p.row * 3 + 2], title: '每行依次为 P、Q、公式值' }), `当前 P=${rows[p.row][0]}，Q=${rows[p.row][1]}，结果=${rows[p.row][2]}。P真Q假是蕴含的唯一反例。`, { table: rows, selected: rows[p.row] }); });
    add('math-discrete.c1.s2', '归纳证明需要每一步都能接上', '公式通过 n=1，就能推广到所有 n 吗？', [range('n', '递推终点 n', 1, 12, 6), choice('formula', '候选闭式', [['correct', 'n(n+1)/2'], ['wrong', 'n²（反例）']])], '递推 S₀=0，Sₙ=Sₙ₋₁+n，考察前12项；数值检验不是归纳证明本身。', '基例通过不能替代归纳步骤，错误公式会在下一步暴露。', p => { let total = 0; return { frames: seq(p.n, i => { const n = i + 1, prev = total; total += n; const proposed = p.formula === 'correct' ? n * (n + 1) / 2 : n * n; return frame(Viz.cells([prev, '+' + n, '=' + total, '候选 ' + proposed], { active: [2, 3] }), `S${n}=S${n - 1}+${n}=${total}；候选=${proposed}，${total === proposed ? '此项一致' : '出现反例'}。`, { n, sum: total, proposed, matches: total === proposed }); }) }; });
    add('math-discrete.c2.s1', '集合运算以后，映射如何合并元素', '并集有多少个元素，映射后还保留这些数量吗？', [range('cutoff', 'A 的最大元素', 2, 8, 5), choice('operation', '集合操作', [['union', 'A ∪ 偶数集'], ['intersect', 'A ∩ 偶数集'], ['diff', 'A − 偶数集']])], '全集{1,…,8}，A={1,…,k}，B为偶数；映射 f(x)=x mod 2。', '集合不重复计数，多对一映射通常会减少像集的元素数。', p => { const A = seq(p.cutoff, i => i + 1), B = [2, 4, 6, 8], out = p.operation === 'union' ? [...new Set([...A, ...B])].sort((a, b) => a - b) : A.filter(x => p.operation === 'intersect' ? B.includes(x) : !B.includes(x)), image = [...new Set(out.map(x => x % 2))].sort(); return result(graph([...out.map(x => 'x=' + x), ...image.map(x => '像 ' + x)], out.map((x, i) => [i, out.length + image.indexOf(x % 2), 'mod 2'])), `结果集合 {${out}} 有${out.length}项；像集 {${image}} 有${image.length}项。例如1和3映射到同一个1，这不是一一映射。`, { set: out, image }); });
    add('math-discrete.c2.s2', '等价类与偏序表达不同的关系', '双向可达的同类关系，与只向上走的整除关系有何区别？', [range('n', '集合上界', 3, 8, 6), choice('relation', '关系', [['mod', '模3同余'], ['divides', '整除偏序']])], '有限集合{1,…,n}；同余显示不同元素间双向边，整除显示严格关系边；自反边省略。', '等价关系把集合分组；偏序允许不可比较元素，不能强行排成一条总序。', p => { const xs = seq(p.n, i => i + 1), edges = []; for (let i = 0; i < xs.length; i++)
        for (let j = 0; j < xs.length; j++)
            if (i !== j && (p.relation === 'mod' ? (xs[i] - xs[j]) % 3 === 0 : xs[j] % xs[i] === 0))
                edges.push([i, j]); return result(graph(xs, edges, [], 'circle'), p.relation === 'mod' ? `按余数分成 ${[0, 1, 2].map(r => '{' + xs.filter(x => x % 3 === r) + '}').join('、')}。1与4同类。` : '2与3互不整除，不能比较；1整除每个元素。图中省略自反边，但定义包含它。', { edges: edges.map(([i, j]) => [xs[i], xs[j]]), classes: p.relation === 'mod' ? [0, 1, 2].map(r => xs.filter(x => x % 3 === r)) : null }); });
    add('math-discrete.c3.s1', '重复计数怎样被消除', '选3个人排队与只选3个人，为什么差一个3!？', [range('n', '候选人数 n', 3, 8, 5), choice('mode', '计数问题', [['ordered', '选3人并排序'], ['unordered', '只选3人'], ['union', '1…n 中2或3的倍数']])], '小规模精确枚举；不使用大数近似。', '排列除去内部次序得到组合；并集必须减掉交集的重复计数。', p => { const perms = p.n * (p.n - 1) * (p.n - 2), comb = perms / 6, A = seq(p.n, i => i + 1).filter(x => x % 2 === 0), B = seq(p.n, i => i + 1).filter(x => x % 3 === 0), over = A.filter(x => B.includes(x)), count = p.mode === 'ordered' ? perms : p.mode === 'unordered' ? comb : A.length + B.length - over.length; return result(p.mode === 'union' ? Viz.cells(seq(p.n, i => i + 1), { active: [...new Set([...A, ...B])].map(x => x - 1) }) : Viz.bars([perms, comb], ['有序', '无序']), p.mode === 'union' ? `|A∪B|=${A.length}+${B.length}−${over.length}=${count}；6会被重复数两次，必须减去一次。` : `有序${perms}，无序${comb}，比值为3!=6；改变n不会改变每组三人的内部排列数。`, { count, permutations: perms, combinations: comb, intersection: over }); });
    add('math-discrete.c3.s2', '边数相同，为什么不一定是一棵树', 'n−1 条边足以证明图是树吗？', [choice('shape', '图形', [['path', '路径'], ['cycle', '环加孤立点'], ['star', '星形']]), range('n', '节点数', 4, 8, 5)], '简单无向有限图；用遍历计算连通分量。', '无向图是树需要连通且无环，边数n−1单独不够。', p => { const edges = p.shape === 'path' ? seq(p.n - 1, i => [i, i + 1]) : p.shape === 'star' ? seq(p.n - 1, i => [0, i + 1]) : [...seq(p.n - 2, i => [i, i + 1]), [p.n - 2, 0]]; const seen = new Set(); let components = 0; for (let i = 0; i < p.n; i++)
        if (!seen.has(i)) {
            components++;
            const stack = [i];
            while (stack.length) {
                const x = stack.pop();
                if (seen.has(x))
                    continue;
                seen.add(x);
                edges.forEach(([a, b]) => { if (a === x && !seen.has(b))
                    stack.push(b); if (b === x && !seen.has(a))
                    stack.push(a); });
            }
        } const tree = components === 1 && edges.length === p.n - 1; return result(Viz.graph({ nodes: seq(p.n, i => ({ id: String(i), label: String(i) })), edges: edges.map(([a, b]) => ({ from: String(a), to: String(b) })), directed: false, layout: 'circle' }), `${p.n}点、${edges.length}边、${components}个连通分量：${tree ? '是树' : '不是树'}。环加孤立点同样有n−1条边，却不连通。`, { nodes: p.n, edges: edges.length, components, tree }); });
    add('math-probability.c1.s1', '条件概率：先缩小样本空间再计数', '给定和较大以后，掷出某个点数会更容易吗？', [range('threshold', '条件：两骰子之和至少', 3, 11, 8), range('face', '事件：第一颗骰子点数', 1, 6, 6)], '两枚独立公平六面骰，36个等可能结果全部枚举。', 'P(A|B)的分母是B中的样本数；条件会改变分布，不能沿用1/6。', p => { const matrix = seq(6, i => seq(6, j => i + j + 2 >= p.threshold ? (i + 1 === p.face ? 2 : 1) : 0)); let denominator = 0, numerator = 0; matrix.flat().forEach(v => { if (v)
        denominator++; if (v === 2)
        numerator++; }); return result(Viz.matrix(matrix, { title: '行=第一骰；列=第二骰；0排除，1满足B，2同时满足A和B' }), `符合条件B的结果${denominator}个，其中第一骰为${p.face}的${numerator}个。P(A|B)=${numerator}/${denominator}=${round(numerator / denominator)}；无条件P(A)=1/6。`, { numerator, denominator, conditional: numerator / denominator, unconditional: 1 / 6 }); });
    add('math-probability.c2.s2', '样本均值趋稳，但并不单调逼近', '换一组随机样本，置信区间还一定包含真值吗？', [range('n', '样本量', 20, 200, 100, 20), range('seed', '合成样本种子', 1, 9, 1)], '固定真实Bernoulli概率0.6；种子控制伪随机样本；区间采用Wilson 95%公式。', '大数定律不保证每一步更接近；95%覆盖率描述重复抽样方法而非本次真值的随机性。', p => { const random = rng(p.seed); let successes = 0; const points = seq(p.n, i => { successes += Number(random() < .6); return [i + 1, successes / (i + 1)]; }); const q = successes / p.n, z = 1.96, d = 1 + z * z / p.n, center = (q + z * z / (2 * p.n)) / d, half = z * Math.sqrt(q * (1 - q) / p.n + z * z / (4 * p.n * p.n)) / d; return result(plot([{ points, label: '运行成功率' }, { points: [[1, .6], [p.n, .6]], label: '真实p=0.6' }], { segments: [[p.n, center - half, p.n, center + half]], xDomain: [1, p.n], yDomain: [0, 1] }), `${successes}/${p.n}=${round(q)}；Wilson区间[${round(center - half)},${round(center + half)}]，${center - half <= .6 && center + half >= .6 ? '包含' : '不包含'}真实p。更换种子就是换一次样本，不是改变真实概率。`, { successes, estimate: q, lower: center - half, upper: center + half, trueProbability: .6 }); });
    const normalCDF = x => { const t = 1 / (1 + .2316419 * Math.abs(x)); const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t * (.319381530 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x >= 0 ? 1 - tail : tail; };
    add('math-probability.c3.s1', '显著性与检验功效的交换', '把拒绝门槛调高，会同时减少两类错误吗？', [range('cutoff', '双侧z阈值', 1, 3, 1.96, .02), range('effect', '真实均值变化', 0, 2, 1, .1)], '已知σ=3、n=36的正态均值z检验；零假设均值0；数值CDF近似。', '提高门槛降低第一类错误，却可能增加第二类错误；未拒绝不等于证明无差异。', p => { const mu = p.effect * 2, alpha = 2 * (1 - normalCDF(p.cutoff)), beta = normalCDF(p.cutoff - mu) - normalCDF(-p.cutoff - mu); return result(plot([{ points: curve(x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI), -5, 7), label: '零假设z~N(0,1)' }, { points: curve(x => Math.exp(-((x - mu) ** 2) / 2) / Math.sqrt(2 * Math.PI), -5, 7), label: '真实差异分布' }], { segments: [[-p.cutoff, 0, -p.cutoff, .45], [p.cutoff, 0, p.cutoff, .45]], xDomain: [-5, 7], yDomain: [0, .45] }), `第一类错误α≈${round(alpha)}，第二类错误β≈${round(beta)}，功效≈${round(1 - beta)}。真实差异为0时，拒绝率就是α。`, { alpha, beta, power: 1 - beta, meanZ: mu }); });
    add('math-probability.c3.s2', '合并数据为什么可能翻转回归方向', '组内趋势相同，合并后的趋势还能相反吗？', [range('within', '组内斜率', -1, 1, -.5, .25), range('confound', '组间偏移强度', 0, 5, 3, .5)], '两组合成数据；x的组均值为±2，结果y=组内斜率·x+组偏移；无真实人群因果结论。', '混杂让组间差异进入总斜率；相关和回归线本身不能确认因果。', p => { const groups = [-1, 1].map(g => seq(7, i => { const x = 2 * g + (i - 3) * .25; return [x, p.within * x + p.confound * g]; })), points = groups.flat(), mx = sum(points.map(v => v[0])) / 14, my = sum(points.map(v => v[1])) / 14, slope = sum(points.map(([x, y]) => (x - mx) * (y - my))) / sum(points.map(([x]) => (x - mx) ** 2)); return result(plot([{ points: groups[0], label: '组A' }, { points: groups[1], label: '组B' }, { points: curve(x => my + slope * (x - mx), -3, 3), label: '合并回归' }], { points, xDomain: [-3, 3], yDomain: [-8, 8] }), `两组内部斜率都是${p.within}；合并斜率=${round(slope)}。${slope * p.within < 0 ? '出现方向翻转：遗漏了组别。' : '调高组间偏移，观察组间差异是否压过组内趋势。'}`, { withinSlope: p.within, pooledSlope: slope, points }); });
    add('math-optimization.c1.s2', '凸函数与非凸函数：驻点不一定是最优点', '梯度为零时，是否就能停下并宣称最小？', [choice('shape', '目标函数', [['convex', 'x²'], ['double', '(x²−1)²']]), range('start', '起点 x₀', -2, 2, 0, .25)], '一维解析函数；固定学习率0.05，执行18次梯度下降；有限轨迹不证明一般收敛。', '凸函数的驻点可为全局最优；非凸函数在x=0可停在局部最大点。', p => { const f = p.shape === 'convex' ? x => x * x : x => (x * x - 1) ** 2, g = p.shape === 'convex' ? x => 2 * x : x => 4 * x * (x * x - 1); let x = p.start; return { frames: seq(19, i => { const value = f(x), state = x; const svg = pointPlot(f, -2, 2, [[x, value]]); x -= .05 * g(x); return frame(svg, `第${i}步，x=${round(state)}，f=${round(value)}，梯度=${round(g(state))}。${p.shape === 'double' && state === 0 ? '停在0但两侧±1更低，这是驻点非最优反例。' : '比较相同起点在两种曲线上的轨迹。'}`, { iteration: i, x: state, loss: value, gradient: g(state) }); }) }; });
    add('math-optimization.c2.s1', '约束最优点为什么与梯度平行', '改变约束额度时，最优值怎样变化？', [range('c', '约束 x+y=c', 1, 6, 3, .5), range('weight', 'y² 的权重', .5, 3, 1, .5)], '最小化x²+w y²，线性等式约束；解析解x=wc/(w+1)，y=c/(w+1)。', '最优点处目标梯度与约束法向平行；乘子描述约束变化的边际代价。', p => { const y = p.c / (1 + p.weight), x = p.weight * y, value = x * x + p.weight * y * y, lambda = 2 * x; return result(plot([{ points: [[0, p.c], [p.c, 0]], label: '可行直线' }], { points: [[x, y]], segments: [[x, y, x + lambda / 5, y + lambda / 5]], equalAspect: true, xDomain: [0, 6], yDomain: [0, 6] }), `最优(${round(x)},${round(y)})，目标=${round(value)}。∇f=(${round(2 * x)},${round(2 * p.weight * y)})与(1,1)平行；边际最优值变化率λ=${round(lambda)}。`, { x, y, minimum: value, lambda }); });
    add('math-optimization.c2.s2', '线性规划的最优点落在哪里', '约束收紧时，原来的最优角点还可行吗？', [range('budget', '总资源 x+y≤b', 1, 8, 5), range('price', 'x 的收益系数', 1, 5, 3)], '最大化 price·x+2y，x≤3，y≤4，x,y≥0；枚举所有边界交点精确求解。', '线性目标可在极点取最优；一条边上可能有多个最优点，不能总声称唯一。', p => { const points = [[0, 0], [Math.min(3, p.budget), 0], [0, Math.min(4, p.budget)], [3, Math.min(4, p.budget - 3)], [Math.min(3, p.budget - 4), 4]].filter(([x, y]) => x >= 0 && y >= 0 && x + y <= p.budget); let best = points[0]; points.forEach(v => { if (p.price * v[0] + 2 * v[1] > p.price * best[0] + 2 * best[1])
        best = v; }); const objective = p.price * best[0] + 2 * best[1], duals = [0, 2, p.price].map(u => ({ u, v: Math.max(0, p.price - u), w: Math.max(0, 2 - u) })); const dual = duals.reduce((a, b) => p.budget * a.u + 3 * a.v + 4 * a.w <= p.budget * b.u + 3 * b.v + 4 * b.w ? a : b), dualValue = p.budget * dual.u + 3 * dual.v + 4 * dual.w; const boundary = [...points].sort((a, b) => Math.atan2(a[1] - 1, a[0] - 1) - Math.atan2(b[1] - 1, b[0] - 1)); boundary.push(boundary[0]); return result(plot([{ points: boundary, label: '可行域边界' }], { points: [best], xDomain: [0, 4], yDomain: [0, 5] }), `最优角点(${best})，收益=${objective}。${p.price === 2 ? '总量约束活跃时沿x+y=b的可行线段收益相同，并非唯一最优。' : '改变收益系数可让最优角点切换。'}对偶价格(u,v,w)=(${dual.u},${dual.v},${dual.w})给出上界${dualValue}，与最优值相等。`, { vertices: points, best, objective, dual, dualValue }); });
    add('math-optimization.c3.s1', '消去相近数为何放大舍入误差', '同一个公式换个等价写法，结果会更稳定吗？', [range('digits', '模拟有效十进制位数', 3, 8, 4), range('x', '输入 x', 1, 1000, 100, 1)], '用十进制有效位舍入模拟有限精度，比较√(x²+1)−x与倒数有理化；不是IEEE逐位仿真。', '问题条件与算法稳定性不同；代数等价的式子在有限精度下会丢失不同信息。', p => { const fl = x => Number(x.toPrecision(p.digits)), root = fl(Math.sqrt(fl(fl(p.x * p.x) + 1))), naive = fl(root - p.x), stable = fl(1 / fl(root + p.x)), exact = 1 / (Math.sqrt(p.x * p.x + 1) + p.x); return result(Viz.bars([naive, stable, exact], ['相近数相减', '有理化', '双精度参考']), `直接相减=${naive}；有理化=${stable}；参考=${round(exact)}。直接相减相对误差=${round(Math.abs(naive - exact) / exact)}；大x会让两个被减数更接近。`, { naive, stable, reference: exact, relativeError: Math.abs(naive - exact) / exact }); });
    add('math-optimization.c3.s2', '固定点迭代为什么会收敛或发散', '每一步误差乘上什么数？', [range('factor', '迭代系数 a', -1.2, 1.2, .5, .1), range('start', '初始值', -3, 5, 4, .5)], 'xₖ₊₁=a xₖ+1，|a|≤1.2，最多16步；a=1没有有限固定点。', '误差按a缩放：|a|<1收敛，a<0震荡；|a|>1通常发散，精确从固定点出发是例外。', p => { let x = p.start, points = []; return { frames: seq(17, i => { const current = x; points = [...points, [i, current]]; const fixed = Math.abs(1 - p.factor) < 1e-9 ? null : 1 / (1 - p.factor); x = p.factor * x + 1; return frame(plot([{ points, label: '迭代值' }], { xDomain: [0, 16], yDomain: [Math.min(-10, ...points.map(v => v[1])), Math.max(10, ...points.map(v => v[1]))] }), `x${i}=${round(current)}，固定点=${fixed === null ? '不存在' : round(fixed)}。下一步=${round(x)}。|a|=${round(Math.abs(p.factor))}决定误差是否被压缩。`, { step: i, x: current, fixed, error: fixed === null ? null : current - fixed }); }) }; });
    add('programming.c1.s1', '循环中的 continue 与 break', '遇到负数时，是跳过这一项还是结束整个循环？', [choice('rule', '负数处理', [['continue', 'continue：继续下一项'], ['break', 'break：结束循环']]), range('shift', '输入整体偏移', -2, 2, 0)], 'Python风格顺序循环，输入由[3,-1,4,2]加偏移得到；变量sum只累加非负项。', 'continue改变本轮控制流，break改变整个循环是否还有后续轮次。', p => { const data = [3, -1, 4, 2].map(x => x + p.shift), frames = []; let total = 0; for (let i = 0; i < data.length; i++) {
        const x = data[i];
        let action;
        if (x < 0)
            action = p.rule === 'break' ? 'break：后续元素不再访问' : 'continue：本项不累加';
        else {
            total += x;
            action = '累加到sum';
        }
        frames.push(frame(Viz.cells(data, { active: [i], labels: seq(data.length, j => 'i=' + j) }), `i=${i}，x=${x}，${action}，sum=${total}。`, { index: i, value: x, sum: total, action }));
        if (x < 0 && p.rule === 'break')
            break;
    } return { frames }; });
    add('programming.c2.s1', '引用关系决定对象能活多久', '删除一个变量名，会立刻删除它曾指向的对象吗？', [choice('relation', '第二个名字', [['alias', 'b=a：强引用同一对象'], ['copy', 'b=a.copy()：新对象'], ['weak', 'b为弱引用（抽象）']]), range('value', '追加元素', 2, 9, 3)], 'Python式列表与引用关系抽象；弱引用用于说明所有权，不声称内置list可直接weakref；不模拟循环GC时机。', '名字与对象不同；强引用保留对象，复制得到独立对象，弱引用不能延长生命。', p => { const frames = []; let original = [1], copy = [1]; const scene = (alive, aPresent) => { const labels = [aPresent ? 'a' : 'a已删除', 'b', alive ? '对象A [' + original + ']' : '对象A 不再可达']; if (p.relation === 'copy')
        labels.push('对象B [' + copy + ']'); const edges = []; if (aPresent)
        edges.push([0, 2, '强引用']); if (p.relation === 'copy')
        edges.push([1, 3, '强引用']);
    else if (alive)
        edges.push([1, 2, p.relation === 'weak' ? '弱引用' : '强引用']); return graph(labels, edges); }; frames.push(frame(scene(true, true), '两个名字绑定完成；比较它们是否指向同一对象。', { original: [...original], copy: [...copy], alive: true })); if (p.relation === 'copy')
        copy.push(p.value);
    else
        original.push(p.value); frames.push(frame(scene(true, true), '经b追加元素；别名修改原对象，浅复制的这个整数列表独立。', { original: [...original], copy: [...copy], alive: true })); const alive = p.relation === 'alias'; frames.push(frame(scene(alive, false), '删除a后，' + (alive ? 'b仍强引用对象A。' : p.relation === 'weak' ? '弱引用不延长生命，A不可达。' : 'A不可达，独立的对象B仍由b持有。'), { original: [...original], copy: [...copy], alive })); return { frames }; });
    add('programming.c2.s2', '同一个接口怎样调用不同实现', '调用 area() 时，调用者必须知道具体形状吗？', [choice('shape', '具体对象', [['rect', '长方形'], ['circle', '圆']]), range('scale', '形状缩放', 1, 4, 2, .5)], 'area/perimeter两个纯方法；长方形边长2s和s，圆半径s；不模拟具体语言虚表。', '相同接口允许替换对象，但结果仍遵守各类型几何规则；缩放s让面积按s²变化。', p => { const s = p.scale, area = p.shape === 'rect' ? 2 * s * s : Math.PI * s * s, perimeter = p.shape === 'rect' ? 6 * s : 2 * Math.PI * s; const body = p.shape === 'rect' ? Viz.rect(300 - 30 * s, 130 - 15 * s, 60 * s, 30 * s, '#bee0d2') : `<circle cx="300" cy="130" r="${30 * s}" fill="#bee0d2" stroke="#087f8c"/>`; return result(Viz.svg(body + Viz.text(300, 270, `area()=${round(area)}；perimeter()=${round(perimeter)}`, 16)), `接口分派到${p.shape === 'rect' ? 'Rectangle' : 'Circle'}实现。面积=${round(area)}平方单位，周长=${round(perimeter)}单位；两个单位不能混同。`, { type: p.shape, area, perimeter }); });
    add('programming.c3.s1', '异常路径也必须释放资源', '中途出错后，finally 是否仍会执行？', [choice('failure', '注入异常位置', [['none', '不出错'], ['write', '写入时出错'], ['commit', '提交时出错']]), choice('cleanup', '释放方式', [['finally', 'finally保证释放'], ['normal', '只在正常末尾释放（反例）']])], '内存中的文件句柄状态机，无真实文件写入；展示结构化资源清理。', '正常路径正确不能证明异常路径安全；资源释放应覆盖所有退出路径。', p => { let opened = false, written = false, committed = false, error = false; const frames = []; const push = note => frames.push(frame(Viz.cells([opened ? '句柄：开' : '句柄：关', written ? '缓冲：已写' : '缓冲：空', committed ? '提交：是' : '提交：否', error ? '异常' : '正常']), note, { opened, written, committed, error })); opened = true; push('acquire：打开句柄。'); if (p.failure === 'write') {
        error = true;
        push('写入抛错，直接退出正常路径。');
    }
    else {
        written = true;
        push('write：修改缓冲，尚未提交。');
        if (p.failure === 'commit') {
            error = true;
            push('commit抛错；已写缓冲不等于成功提交。');
        }
        else {
            committed = true;
            push('commit：提交成功。');
        }
    } if (!error || p.cleanup === 'finally') {
        opened = false;
        push('释放句柄：' + (error ? '异常仍执行finally。' : '正常结束。'));
    }
    else
        push('正常末尾close被跳过：句柄泄漏。'); return { frames }; });
    add('programming.c3.s2', '边界测试怎样抓住差一个等号的错误', '只测中间值，为什么测不出上界错误？', [range('cap', '允许上界', 2, 10, 5), choice('version', '实现版本', [['correct', '0≤x≤上界'], ['bug', '0≤x<上界（缺等号）']])], '纯整数区间校验器；独立规格为闭区间[0,cap]。', '典型值通过不能代替边界值；最小反例x=cap能准确指出缺失等号。', p => { const xs = [-1, 0, p.cap - 1, p.cap, p.cap + 1], rows = xs.map(x => { const expected = x >= 0 && x <= p.cap, actual = x >= 0 && (p.version === 'bug' ? x < p.cap : x <= p.cap); return [x, Number(expected), Number(actual), actual === expected ? '通过' : '失败']; }); return result(table(['输入', '规格', '实现', '结果'], rows), `共${rows.filter(row => row[3] === '失败').length}个失败。x=${p.cap}是闭区间上边界；错误实现会把合法输入拒绝。`, { rows, failures: rows.filter(row => row[3] === '失败').map(row => row[0]) }); });
    add('data-structures.c1.s2', '同一串操作进入栈、队列和环形缓冲', '取出顺序和满容量行为由什么决定？', [choice('kind', '容器', [['stack', '栈LIFO'], ['queue', '队列FIFO'], ['ring', '环形队列FIFO']]), range('capacity', '容量', 2, 5, 3)], '有限容量容器，满时拒绝写入而不覆盖；环形队列保留head与tail位置。', '栈按最后加入先取出；队列按最早加入先取出；环形只改变存储位置不改变FIFO。', p => { const ops = [['put', 1], ['put', 2], ['put', 3], ['take'], ['put', 4], ['take'], ['put', 5]], items = [], slots = seq(p.capacity, () => null), frames = []; let head = 0, tail = 0; for (const [op, value] of ops) {
        let note, removed = null;
        if (op === 'put') {
            if (items.length === p.capacity)
                note = '满：拒绝写入' + value;
            else {
                items.push(value);
                if (p.kind === 'ring') {
                    slots[tail] = value;
                    tail = (tail + 1) % p.capacity;
                }
                note = '写入 ' + value;
            }
        }
        else if (!items.length)
            note = '空：不能取出';
        else {
            removed = p.kind === 'stack' ? items.pop() : items.shift();
            if (p.kind === 'ring') {
                slots[head] = null;
                head = (head + 1) % p.capacity;
            }
            note = '取出 ' + removed;
        }
        frames.push(frame(Viz.cells(p.kind === 'ring' ? slots.map(v => v ?? '空') : seq(p.capacity, i => items[i] ?? '空'), { active: p.kind === 'ring' ? [head, tail] : [], labels: seq(p.capacity, i => p.kind === 'ring' ? (i === head ? 'H' : '') + (i === tail ? 'T' : '') + '槽' + i : '位置' + i) }), `${note}；逻辑内容[${items}]${p.kind === 'ring' ? `，head=${head},tail=${tail}，count=${items.length}` : ''}。`, { items: [...items], slots: [...slots], head, tail, count: items.length, removed }));
    } return { frames }; });
    add('data-structures.c2.s1', '旋转如何改变树形但保留中序顺序', '旋转之后，搜索树中的大小关系会被破坏吗？', [choice('shape', '失衡方向', [['left', '左左型'], ['right', '右右型']]), range('middle', '中间键', 3, 8, 5)], '三个不同键构成BST；只演示单次AVL LL/RR旋转，不覆盖双旋转。', '旋转重连父子边但保持中序序列，因此保持BST搜索语义。', p => { const keys = [p.middle - 2, p.middle, p.middle + 2], old = p.shape === 'left' ? [[2, 1], [1, 0]] : [[0, 1], [1, 2]], next = [[1, 0], [1, 2]]; return { frames: [frame(graph(keys, old, [], 'tree'), '旋转前高度为3；较重一侧需要提升中间键。', { root: p.shape === 'left' ? keys[2] : keys[0], inorder: [...keys], height: 3 }), frame(graph(keys, next, [1], 'tree'), '旋转后高度为2；中序仍为 ' + keys.join(' < ') + '。不是交换键值，而是重连边。', { root: keys[1], inorder: [...keys], height: 2 })] }; });
    add('data-structures.c2.s2', '哈希冲突不等于数据相同', '扩容以后为什么必须重新计算位置？', [range('capacity', '初始桶数', 3, 7, 4), choice('keys', '键集合', [['spread', '1,2,3,4,5'], ['collide', '0,4,8,12,16']])], '整数哈希h(k)=k mod m，链地址法；负载超过0.75时演示一次扩容到2m。', '不同键可能同桶；扩容改变取模的m，不能只把旧桶原样复制。', p => { const keys = p.keys === 'spread' ? [1, 2, 3, 4, 5] : [0, 4, 8, 12, 16], frames = []; let m = p.capacity, buckets = seq(m, () => []); keys.forEach(k => { buckets[k % m].push(k); frames.push(frame(Viz.cells(buckets.map(b => b.join('→') || '空'), { active: [k % m], labels: seq(m, i => '桶' + i) }), `插入${k}，${k} mod ${m}=${k % m}。冲突链保留完整键。`, { capacity: m, buckets: buckets.map(b => [...b]), load: sum(buckets.map(b => b.length)) / m })); }); if (keys.length / m > .75) {
        m *= 2;
        buckets = seq(m, () => []);
        keys.forEach(k => buckets[k % m].push(k));
        frames.push(frame(Viz.cells(buckets.map(b => b.join('→') || '空'), { labels: seq(m, i => '桶' + i) }), '负载过高，扩容并对每个键重新哈希。', { capacity: m, buckets: buckets.map(b => [...b]), load: keys.length / m }));
    } return { frames }; });
    add('data-structures.c3.s2', '哈夫曼编码为何优先合并最小频率', '提高某个符号频率，会让它的编码变长还是变短？', [range('freq', 'A的频率', 1, 20, 8), choice('other', '其他符号分布', [['balanced', 'B,C,D各4'], ['skew', 'B=9,C=2,D=1']])], '四符号精确哈夫曼构造；相同权重按符号ID稳定打破平局；不处理空字符集。', '频繁符号倾向较短编码，所有叶子编码无前缀冲突；最小加权路径长度不保证每个编码唯一。', p => { let nodes = [{ id: 'A', weight: p.freq }, { id: 'B', weight: p.other === 'balanced' ? 4 : 9 }, { id: 'C', weight: p.other === 'balanced' ? 4 : 2 }, { id: 'D', weight: p.other === 'balanced' ? 4 : 1 }], all = [...nodes], edges = [], frames = [], index = 0; while (nodes.length > 1) {
        nodes.sort((a, b) => a.weight - b.weight || a.id.localeCompare(b.id));
        const a = nodes.shift(), b = nodes.shift(), parent = { id: 'N' + index++, weight: a.weight + b.weight, left: a, right: b };
        nodes.push(parent);
        all.push(parent);
        edges.push({ from: parent.id, to: a.id, label: '0' }, { from: parent.id, to: b.id, label: '1' });
        frames.push(frame(Viz.graph({ nodes: all.map(n => ({ id: n.id, label: n.id + ':' + n.weight, active: n === parent })), edges: [...edges], directed: true, layout: 'tree' }), `合并最小权重 ${a.weight}+${b.weight}=${parent.weight}。`, { merged: [a.weight, b.weight], sum: parent.weight }));
    } const codes = {}; function walk(n, prefix) { if (!n.left) {
        codes[n.id] = prefix;
        return;
    } walk(n.left, prefix + '0'); walk(n.right, prefix + '1'); } walk(nodes[0], ''); const cost = sum(all.filter(n => !n.left).map(n => n.weight * codes[n.id].length)); frames.push(frame(table(['符号', '频率', '编码'], all.filter(n => !n.left).map(n => [n.id, n.weight, codes[n.id]])), `加权码长=${cost}；固定两位编码代价=${2 * nodes[0].weight}。相同频率可能出现同样优秀的不同树。`, { codes, cost, total: nodes[0].weight })); return { frames }; });
    add('algorithms.c1.s1', '递归树每一层的工作量怎样累积', '把叶子数误当总工作量，会漏掉什么？', [range('power', '规模 n=2^k 的k', 1, 7, 4), choice('recurrence', '递推式', [['merge', 'T(n)=2T(n/2)+n'], ['binary', 'T(n)=T(n/2)+1']])], 'n为2的幂，叶子工作量1；精确计数而非程序实测耗时。', '分治总成本要把每一层相加；归并式每层n，二分查找每层1。', p => { const n = 2 ** p.power, levels = seq(p.power + 1, l => p.recurrence === 'merge' ? n : 1), total = sum(levels); return result(Viz.bars(levels, levels.map((_, i) => '层' + i)), `n=${n}，${levels.length}层，总工作量=${total}。${p.recurrence === 'merge' ? '精确为n(log₂n+1)，不能只数n个叶子。' : '精确为log₂n+1，规模翻倍只新增一层。'}`, { n, levels, total }); });
    add('algorithms.c2.s2', '归并与堆：不同不变量导向相同有序结果', '每一步究竟保证哪一段已经有序？', [choice('algorithm', '算法', [['merge', '自底向上归并'], ['heap', '最大堆排序']]), choice('input', '输入', [['mixed', '4,1,5,2,3'], ['duplicates', '3,1,3,2,1'], ['reverse', '5,4,3,2,1']])], '最多5元素，归并稳定地先取左侧相等元素；堆排序不保证稳定性。', '归并维护有序子段，堆维护堆顶最大；不能把当前局部状态误认成整体有序。', p => { let a = p.input === 'duplicates' ? [3, 1, 3, 2, 1] : p.input === 'reverse' ? [5, 4, 3, 2, 1] : [4, 1, 5, 2, 3]; const frames = [frame(Viz.cells(a), '初始数组。', { array: [...a] })], push = (note, active) => frames.push(frame(Viz.cells(a, { active }), note, { array: [...a] })); if (p.algorithm === 'merge') {
        for (let width = 1; width < a.length; width *= 2)
            for (let left = 0; left < a.length; left += 2 * width) {
                const mid = Math.min(left + width, a.length), right = Math.min(left + 2 * width, a.length), out = [];
                let i = left, j = mid;
                while (i < mid || j < right) {
                    if (j === right || (i < mid && a[i] <= a[j]))
                        out.push(a[i++]);
                    else
                        out.push(a[j++]);
                }
                a.splice(left, right - left, ...out);
                push(`合并[${left},${mid})与[${mid},${right})；该区间现在有序。`, seq(right - left, k => left + k));
            }
    }
    else {
        function sift(root, size) { while (root * 2 + 1 < size) {
            let child = root * 2 + 1;
            if (child + 1 < size && a[child + 1] > a[child])
                child++;
            if (a[root] >= a[child])
                break;
            [a[root], a[child]] = [a[child], a[root]];
            push('向下调整：父节点不小于孩子。', [root, child]);
            root = child;
        } }
        for (let i = Math.floor(a.length / 2) - 1; i >= 0; i--)
            sift(i, a.length);
        for (let end = a.length - 1; end > 0; end--) {
            [a[0], a[end]] = [a[end], a[0]];
            push(`最大值移到${end}；右侧后缀已就位。`, [end]);
            sift(0, end);
        }
    } push('完整排序结束；比较两种算法的中间过程。', []); return { frames }; });
    add('algorithms.c3.s2', '最少硬币：为什么贪心会失效', '先选最大的硬币，总能得到最少枚数吗？', [range('target', '目标金额', 1, 15, 6), choice('coins', '面额', [['canonical', '1,5,10'], ['trap', '1,3,4']])], '无限枚正整数硬币；动态规划dp[s]=1+min dp[s−coin]，dp[0]=0。', '状态表示子问题的最优答案；面额1,3,4凑6时，3+3优于贪心4+1+1。', p => { const coins = p.coins === 'trap' ? [1, 3, 4] : [1, 5, 10], dp = [0], frames = []; for (let s = 1; s <= p.target; s++) {
        const candidates = coins.filter(c => c <= s).map(c => ({ coin: c, cost: dp[s - c] + 1 }));
        dp[s] = Math.min(...candidates.map(x => x.cost));
        frames.push(frame(Viz.cells(dp, { active: [s], labels: dp.map((_, i) => '金额' + i) }), `dp[${s}]=min(${candidates.map(x => `用${x.coin}→${x.cost}`).join('，')})=${dp[s]}。`, { amount: s, dp: [...dp], minimum: dp[s] }));
    } let rest = p.target, greedy = 0; for (const c of [...coins].reverse()) {
        greedy += Math.floor(rest / c);
        rest %= c;
    } frames.push(frame(Viz.bars([dp[p.target], greedy], ['动态规划', '最大优先贪心']), `目标${p.target}：最优${dp[p.target]}枚，贪心${greedy}枚。${greedy > dp[p.target] ? '这是贪心失败的具体反例。' : '本输入一致，不代表贪心对所有面额正确。'}`, { minimum: dp[p.target], greedy, dp: [...dp] })); return { frames }; });
    add('digital-logic.c1.s1', '逻辑门把输入电平变成什么输出', '异或与或，在哪组输入上出现区别？', [choice('gate', '逻辑门', [['and', 'AND'], ['or', 'OR'], ['xor', 'XOR']]), range('bits', '输入AB（二进制00到11）', 0, 3, 3)], '理想二值组合逻辑；不包含模拟电压和传播延迟。', 'XOR检测不同，OR检测至少一个1；A=B=1是两者的最小区别。', p => { const a = (p.bits >> 1) & 1, b = p.bits & 1, y = p.gate === 'and' ? a & b : p.gate === 'or' ? a | b : a ^ b; return result(graph(['A=' + a, 'B=' + b, p.gate.toUpperCase(), 'Y=' + y], [[0, 2], [1, 2], [2, 3]], y ? [3] : [0, 1]), `${p.gate.toUpperCase()}(${a},${b})=${y}。换到AB=11，再切换OR与XOR，结果分别1与0。`, { a, b, y, gate: p.gate }); });
    add('digital-logic.c1.s2', '逐位进位与多路选择', '相同两路输入，求和与选择一路有何本质区别？', [range('a', '三位输入A', 0, 7, 3), choice('mode', '电路', [['add', 'A+5：三位加法器'], ['a', '选择器输出A'], ['b', '选择器输出常数5']])], '三位无符号输入，另一路B=5；加法保留额外进位。', '选择器不会合并数值，加法器逐位传播进位；截掉最高位会发生模8回绕。', p => { if (p.mode !== 'add') {
        const out = p.mode === 'a' ? p.a : 5;
        return result(graph(['A=' + p.a, 'B=5', 'MUX选择' + p.mode.toUpperCase(), '输出=' + out], [[0, 2], [1, 2], [2, 3]], [3]), `选择${p.mode.toUpperCase()}，输出${out}；未选输入不会参与运算。`, { a: p.a, b: 5, output: out });
    } let carry = 0, total = 0; const frames = []; for (let bit = 0; bit < 3; bit++) {
        const a = (p.a >> bit) & 1, b = (5 >> bit) & 1, cin = carry, s = a ^ b ^ cin;
        carry = (a + b + cin) >= 2 ? 1 : 0;
        total |= s << bit;
        frames.push(frame(Viz.cells([`位${bit}`, `A=${a}`, `B=${b}`, `Cin=${cin}`, `S=${s}`, `Cout=${carry}`], { active: [4, 5] }), `位${bit}：${a}+${b}+${cin}=${s}+2×${carry}；进位传给下一位。`, { bit, a, b, carryIn: cin, sumBit: s, carry, partial: total }));
    } frames.push(frame(Viz.cells([total, carry, p.a + 5], { labels: ['三位结果', '额外进位', '完整和'] }), `完整和=${p.a + 5}，三位结果=${total}，进位=${carry}。`, { output: total, carry, full: p.a + 5 })); return { frames }; });
    add('digital-logic.c2.s1', '寄存器只在采样边沿改变', '输入变化后，寄存器为什么暂时保持旧值？', [range('pattern', '四拍输入（二进制）', 0, 15, 10), choice('enable', '写使能', [['on', '每次上升沿采样'], ['alternate', '只在偶数拍采样']])], '理想边沿触发D寄存器；四拍二值输入，初始Q=0；忽略建立保持时间。', 'D可以随时变化，Q只在被使能的时钟上升沿更新；这不是组合逻辑直通。', p => { let q = 0; const frames = []; for (let t = 0; t < 4; t++) {
        const d = (p.pattern >> t) & 1, en = p.enable === 'on' || t % 2 === 0;
        frames.push(frame(Viz.cells([d, 0, Number(en), q], { labels: ['D输入', '时钟低', '使能', 'Q保持'] }), `第${t}拍低电平：输入D=${d}，Q仍为${q}。`, { tick: t, clock: 0, d, q, enable: en }));
        if (en)
            q = d;
        frames.push(frame(Viz.cells([d, 1, Number(en), q], { active: [3], labels: ['D输入', '上升沿', '使能', 'Q'] }), `上升沿${en ? '采样D' : '禁止写入'}，Q=${q}。`, { tick: t, clock: 1, d, q, enable: en }));
    } return { frames }; });
    add('digital-logic.c2.s2', '计数器就是带条件的有限状态机', '复位与保持怎样改变下一状态？', [range('bits', '计数器位宽', 2, 4, 3), choice('control', '控制序列', [['count', '一直计数'], ['hold', '奇数拍保持'], ['reset', '第4拍复位']])], '无符号模2^bits同步计数器；复位优先于使能；12个时钟沿。', '溢出回零是状态转移规则，不是计算错误；优先级决定复位与计数同时发生时的结果。', p => { const mod = 2 ** p.bits; let q = 0; return { frames: seq(12, t => { const reset = p.control === 'reset' && t === 4, en = p.control !== 'hold' || t % 2 === 0, prev = q; q = reset ? 0 : en ? (q + 1) % mod : q; return frame(graph(seq(mod, i => String(i)), seq(mod, i => [i, (i + 1) % mod]), [q], 'circle'), `时钟${t}：${prev}→${q}，${reset ? '复位优先' : en ? '加1后对' + mod + '取模' : '保持'}。`, { tick: t, previous: prev, state: q, modulus: mod, reset, enable: en }); }) }; });
    add('digital-logic.c3.s1', '关键路径决定最早稳定时间', '缩短非关键支路，输出一定更快吗？', [range('b', '上支路B延迟', 1, 8, 5), range('c', '下支路C延迟', 1, 6, 2)], '无环组合电路：输入→A(1)后分支B和C→D(2)，最终汇合门延迟1；静态最大延迟模型。', '总延迟取最长依赖路径，非关键支路的改善可能没有收益。', p => { const arrival = [0, 1, 1 + p.b, 1 + p.c, 3 + p.c, Math.max(1 + p.b, 3 + p.c) + 1], critical = p.b >= p.c + 2 ? 'A→B→汇合' : 'A→C→D→汇合'; return result(graph(['输入', 'A:1', 'B:' + p.b, 'C:' + p.c, 'D:2', '输出@' + arrival[5]], [[0, 1], [1, 2], [1, 3], [3, 4], [2, 5], [4, 5]], p.b >= p.c + 2 ? [1, 2, 5] : [1, 3, 4, 5]), `上路到达=${arrival[2]}，下路=${arrival[4]}，输出最早稳定=${arrival[5]}。关键路径${critical}；相等时两路都关键。`, { arrival, critical, totalDelay: arrival[5] }); });
    add('digital-logic.c3.s2', '采样边沿附近为什么不可靠', '把数据变化推近时钟沿，会进入什么风险窗口？', [range('offset', '数据变化距时钟沿', -2, 2, .5, .1), range('aperture', '建立保持窗口半宽', .1, .8, .2, .1)], '抽象建立/保持窗口，不仿真模拟亚稳态波形或具体芯片概率；时钟沿t=0。', '窗口内变化无法按理想0/1立即保证；同步器降低风险但不提供绝对零概率保证。', p => { const risk = Math.abs(p.offset) <= p.aperture, body = Viz.rect(300 - p.aperture * 100, 55, p.aperture * 200, 150, '#ffeed7') + Viz.line(70, 190, 530, 190) + Viz.line(300, 40, 300, 220, '#087f8c') + Viz.line(300 + p.offset * 100, 70, 300 + p.offset * 100, 190, '#bf5364') + Viz.text(300, 245, '时钟采样沿 t=0', 14) + Viz.text(300 + p.offset * 100, 35, '数据变化', 13); return result(Viz.svg(body), `数据在t=${p.offset}变化，禁止窗口[${-p.aperture},${p.aperture}]。${risk ? '窗口内：输出可能进入亚稳态，不能显示唯一确定结果。' : '窗口外：在此理想时间模型中满足时序约束。'}`, { offset: p.offset, setup: p.aperture, hold: p.aperture, risk, output: risk ? '不确定' : '稳定采样' }); });
    add('architecture.c1.s1', '一条指令怎样选择数据通路', 'ADD与LOAD使用相同寄存器，但为何走不同路径？', [choice('instruction', '指令', [['add', 'ADD R0,R1,R2'], ['load', 'LOAD R0,[R1+2]']]), range('r1', '寄存器R1', 1, 6, 3)], '教学CPU，R2=4，内存M[a]=10a；不仿真某个真实ISA编码。', '译码产生控制选择：算术结果可直接写回，加载必须先把地址送到内存。', p => { const address = p.r1 + 2, out = p.instruction === 'add' ? p.r1 + 4 : 10 * address, labels = ['译码 ' + p.instruction, `读R1=${p.r1}`, p.instruction === 'add' ? '读R2=4' : '立即数2', p.instruction === 'add' ? 'ALU加法=' + out : '地址=' + address, p.instruction === 'add' ? '绕过内存' : '内存读取=' + out, '写R0=' + out], frames = []; for (const active of [0, 1, 3, 4, 5])
        frames.push(frame(graph(labels, [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 5]], [active]), `当前：${labels[active]}。${active === 4 && p.instruction === 'load' ? '地址和值不能混为一谈。' : ''}`, { stage: active, r1: p.r1, r2: 4, address: p.instruction === 'load' ? address : null, result: out })); return { frames }; });
    add('architecture.c1.s2', '数据冒险如何给流水线插入气泡', '后一个ADD何时能安全使用前一个LOAD的结果？', [choice('producer', '前条指令', [['alu', 'ALU结果'], ['load', 'LOAD结果']]), choice('forward', '旁路', [['yes', '启用转发'], ['no', '没有转发']])], '经典五级IF/ID/EX/MEM/WB教学模型；寄存器同周期先写后读；只演示一对RAW依赖。', '转发减少等待，但LOAD的结果较晚，仍可能需要一个气泡。', p => { const stalls = p.forward === 'no' ? 2 : p.producer === 'load' ? 1 : 0; const rows = [{ name: '生产者', slots: seq(5, i => [i, i + 1, ['IF', 'ID', 'EX', 'MEM', 'WB'][i]]) }, { name: '消费者', slots: [[1, 2, 'IF'], [2, 3 + stalls, stalls ? 'ID/等待' : 'ID'], [3 + stalls, 4 + stalls, 'EX'], [4 + stalls, 5 + stalls, 'MEM'], [5 + stalls, 6 + stalls, 'WB']] }]; return result(gantt(rows, 6 + stalls), `需要${stalls}个停顿周期，两条指令共${6 + stalls}周期。${p.producer === 'load' && p.forward === 'yes' ? 'LOAD-use即使有旁路也等1拍。' : '比较旁路前后EX能够获得结果的时刻。'}`, { stalls, cycles: 6 + stalls, rows }); });
    add('architecture.c2.s1', '缓存为何会反复冲突失效', '明明容量够，交替访问两个地址为什么还会miss？', [range('lines', '直接映射缓存行数', 2, 6, 4), choice('access', '访问序列', [['local', '0,1,0,1,0,1'], ['conflict', '0,4,0,4,0,4'], ['scan', '0,1,2,3,4,5']])], '每块1个元素，直接映射index=地址mod行数，冷缓存；没有预取。', '工作集小不保证命中，映射到同一行的块会互相驱逐。', p => { const addresses = p.access === 'local' ? [0, 1, 0, 1, 0, 1] : p.access === 'conflict' ? [0, 4, 0, 4, 0, 4] : [0, 1, 2, 3, 4, 5], cache = seq(p.lines, () => null), frames = []; let hits = 0; addresses.forEach((a, i) => { const index = a % p.lines, hit = cache[index] === a; if (hit)
        hits++; cache[index] = a; frames.push(frame(Viz.cells(cache.map(x => x === null ? '空' : '块' + x), { active: [index], labels: cache.map((_, j) => '行' + j) }), `访问${a}→行${index}：${hit ? '命中' : '未命中，装入并替换'}；累计命中${hits}/${i + 1}。`, { address: a, index, hit, hits, accesses: i + 1, cache: [...cache] })); }); return { frames }; });
    add('architecture.c2.s2', '写回、写穿与共享缓存失效', '另一个核什么时候能看到新值？', [choice('policy', '写策略', [['through', '写穿'], ['back', '写回']]), range('value', 'CPU0写入值', 1, 9, 7)], '双核单地址、单写者、失效式一致性教学状态机；写回缓存可转发脏数据，不等同完整MESI协议。', '内存尚旧不代表另一个核一定读旧；一致性协议可从脏缓存提供最新值。', p => { let memory = 0, c0 = 0, c1 = 0, dirty = false; const frames = [], push = note => frames.push(frame(Viz.cells([c0, c1 === null ? '无效' : c1, memory, dirty ? '脏' : '净'], { labels: ['CPU0缓存', 'CPU1缓存', '主存', 'CPU0状态'] }), note, { c0, c1, memory, dirty })); push('两核已缓存初始值0。'); c0 = p.value; c1 = null; dirty = p.policy === 'back'; if (p.policy === 'through')
        memory = p.value; push('CPU0写入并使CPU1副本无效；' + (dirty ? '主存暂不更新。' : '同步写主存。')); c1 = c0; push('CPU1重新读取：从一致性域获取最新值，不能沿用旧副本。'); if (dirty) {
        memory = c0;
        dirty = false;
        push('脏块被写回主存，数据值不变但落点变化。');
    } return { frames }; });
    add('architecture.c3.s1', '向量化的尾部元素怎样处理', '数据长度不是向量宽度整数倍时，会算错还是浪费槽位？', [range('length', '元素数量', 3, 16, 10), range('lanes', 'SIMD通道数', 2, 8, 4)], '向量加法C=A+B；A[i]=i，B[i]=1；掩码处理尾部；计数指令批次而非真实耗时。', '并行宽度减少批次数，但最后不足一批需要掩码；吞吐不等于任意代码加速比。', p => { const out = [], frames = []; for (let start = 0; start < p.length; start += p.lanes) {
        const active = seq(p.lanes, k => start + k).filter(i => i < p.length);
        active.forEach(i => out[i] = i + 1);
        frames.push(frame(Viz.cells(seq(p.length, i => out[i] ?? '待算'), { active, labels: seq(p.length, i => '元素' + i) }), `批次从${start}开始，${active.length}/${p.lanes}个通道有效，尾部无效通道被屏蔽。`, { start, active, result: [...out], batches: Math.floor(start / p.lanes) + 1, utilization: active.length / p.lanes }));
    } return { frames }; });
    add('architecture.c3.s2', 'GPU合并访存看的是地址，不是线程数量', '同样8个线程，访问跨度变大为何需要更多事务？', [range('stride', '相邻线程地址步幅（元素）', 1, 8, 1), range('offset', '起始地址偏移（元素）', 0, 7, 0)], '8线程，每元素4字节，32字节对齐事务段；简化合并访存模型，不代表所有GPU硬件。', '相邻地址常共享一个事务；跨段与跨度会降低每次事务的有效字节比例。', p => { const addresses = seq(8, i => (p.offset + i * p.stride) * 4), segments = addresses.map(a => Math.floor(a / 32)), unique = [...new Set(segments)]; return result(Viz.cells(addresses, { labels: segments.map((s, i) => `T${i}/段${s}`) }), `8线程请求32字节，涉及${unique.length}个32字节事务段；有效比例=${round(32 / (unique.length * 32))}。步幅1但起点未对齐也可能跨两个段。`, { addresses, segments, transactions: unique.length, efficiency: 1 / unique.length }); });
    add('operating-systems.c1.s1', '切换执行者时，哪些状态保存，哪些状态共享', '同一个变量名，在两个进程与两个线程中会共享吗？', [choice('kind', '运行关系', [['process', '两个独立进程'], ['thread', '同进程的两个线程']]), range('quantum', '时间片内加法次数', 1, 4, 2)], '两个执行者各做4次原子加1；每次切换开销1单位；不声称真实语言++是原子的。', '寄存器上下文属于执行者，地址空间是否共享取决于进程关系；时间片影响切换开销。', p => { const progress = [0, 0], memory = [0, 0], frames = []; let active = 0, switches = 0, clock = 0; while (progress.some(x => x < 4)) {
        if (progress[active] === 4) {
            active = 1 - active;
            continue;
        }
        const amount = Math.min(p.quantum, 4 - progress[active]);
        progress[active] += amount;
        if (p.kind === 'thread') {
            memory[0] += amount;
            memory[1] = memory[0];
        }
        else
            memory[active] += amount;
        clock += amount;
        frames.push(frame(table(['执行者', '程序计数', '可见变量'], [[0, progress[0], memory[0]], [1, progress[1], memory[1]]]), `执行者${active}运行${amount}次；${p.kind === 'thread' ? '两个线程看到同一地址空间。' : '相同名字位于独立地址空间。'}已发生${switches}次切换。`, { active, progress: [...progress], memory: [...memory], switches, clock }));
        if (progress[1 - active] < 4) {
            switches++;
            clock++;
            active = 1 - active;
        }
    } return { frames }; });
    add('operating-systems.c1.s2', '等待时间由调度次序决定', '短任务优先与轮转，各自让谁先得到响应？', [choice('policy', '策略', [['fcfs', '先来先服务'], ['sjf', '最短作业优先'], ['rr', '轮转，时间片2']]), range('b', '任务B运行时长', 1, 7, 3)], '三任务到达时刻均0，A=6、B可调、C=2；无切换开销；SJF已知真实长度。', '响应早不等于完成早；比较平均等待时间必须固定到达与工作量。', p => { const burst = [6, p.b, 2], remaining = [...burst], finish = [0, 0, 0], first = [null, null, null], rows = burst.map((_, i) => ({ name: ['A', 'B', 'C'][i], slots: [] })); let queue = [0, 1, 2], time = 0; const frames = []; if (p.policy === 'sjf')
        queue.sort((a, b) => burst[a] - burst[b]); while (queue.length) {
        const id = queue.shift(), amount = p.policy === 'rr' ? Math.min(2, remaining[id]) : remaining[id];
        if (first[id] === null)
            first[id] = time;
        rows[id].slots.push([time, time + amount, ['A', 'B', 'C'][id]]);
        time += amount;
        remaining[id] -= amount;
        if (remaining[id])
            queue.push(id);
        else
            finish[id] = time;
        const waiting = finish.map((f, i) => f ? f - burst[i] : null);
        frames.push(frame(gantt(rows, time), `运行${['A', 'B', 'C'][id]}到t=${time}，剩余${remaining[id]}。${queue.length ? '继续调度。' : '平均等待=' + round(sum(waiting) / 3) + '；平均首次响应=' + round(sum(first) / 3) + '。'}`, { time, remaining: [...remaining], finish: [...finish], waiting, response: [...first], averageWaiting: queue.length ? null : sum(waiting) / 3 }));
    } return { frames }; });
    add('operating-systems.c2.s2', '索引块定位与日志提交', '找到数据块，与保证元数据更新可恢复，是同一个步骤吗？', [range('logical', '文件逻辑块编号', 0, 5, 3), choice('crash', '中断位置', [['none', '更新完成'], ['before', '日志提交前崩溃'], ['after', '日志提交后、主页写回前崩溃']])], 'inode含2个直接指针与4项一级间接表；只模拟日志保护的块映射元数据，块99为预先分配。', '间接索引增加寻址层；日志提交决定恢复是否重放，不能把写日志与提交混同。', p => { const blocks = [10, 11, 20, 21, 22, 23], old = blocks[p.logical], via = p.logical >= 2; const labels = ['inode', '间接表', `逻辑${p.logical}→块${old}`], edges = via ? [[0, 1, '间接指针'], [1, 2, '索引' + (p.logical - 2)]] : [[0, 2, '直接指针' + p.logical]]; const frames = [frame(graph(labels, edges, [0]), `读取逻辑块${p.logical}：${via ? '先读间接表，再取表项。' : '直接读inode中的指针。'}`, { logical: p.logical, physical: old, indexReads: via ? 2 : 1 })]; const committed = p.crash !== 'before', recovered = committed ? 99 : old; frames.push(frame(table(['对象', '持久状态'], [['日志记录', `${old}→99`], ['提交标记', committed ? '存在' : '缺失'], ['恢复映射', '块' + recovered]]), p.crash === 'before' ? '日志没有提交标记，恢复忽略未提交更新，仍指向旧块。' : p.crash === 'after' ? '提交标记已经持久化，恢复重放映射到块99。' : '日志提交并完成主页更新，映射到块99。', { old, committed, recovered })); return { frames }; });
    add('operating-systems.c3.s2', '条件变量等待的是谓词，不是通知次数', '缓冲满或空时，谁应该等待，谁能继续？', [range('capacity', '缓冲容量', 1, 4, 2), choice('schedule', '调度顺序', [['producer', '生产者先连续尝试'], ['consumer', '消费者先连续尝试'], ['alternate', '交替运行']])], '单生产者、单消费者、持锁检查队列谓词；每个字母是一次调度尝试，阻塞后操作在下一次该线程调度时重试。', 'wait必须在while中重新检查空/满条件；signal只是唤醒提示，不直接提供一个元素。', p => { const order = p.schedule === 'producer' ? 'PPPCCPCC' : p.schedule === 'consumer' ? 'CCPPCCPP' : 'PCPCPCPC', queue = [], frames = []; let next = 1; for (const actor of order) {
        let action, delivered = null;
        if (actor === 'P') {
            if (queue.length === p.capacity)
                action = '满：生产者等待not_full';
            else {
                queue.push(next++);
                action = '生产成功；通知not_empty';
            }
        }
        else {
            if (!queue.length)
                action = '空：消费者等待not_empty';
            else {
                delivered = queue.shift();
                action = '消费' + delivered + '；通知not_full';
            }
        }
        frames.push(frame(Viz.cells(seq(p.capacity, i => queue[i] ?? '空'), { active: seq(queue.length, i => i) }), `${actor === 'P' ? '生产者' : '消费者'}获得锁后检查谓词：${action}。`, { actor, queue: [...queue], count: queue.length, blocked: action.includes('等待'), delivered }));
    } return { frames }; });
    add('networks.c1.s1', '一份数据沿路怎样重新封装', '经过路由器后，哪些地址改变，哪些通常保留？', [range('hops', '路由跳数', 1, 4, 2), range('payload', '应用数据字节数', 20, 200, 80, 20)], '固定IPv4/UDP抽象头：IP20字节、UDP8、以太网头14；忽略选项、FCS、MTU、NAT和隧道。', '链路层地址逐跳改变，端到端IP通常保留；每层头部都会增加线上长度。', p => { const size = p.payload + 42; return { frames: seq(p.hops + 1, i => frame(Viz.cells([`链路头14: M${i}→M${i + 1}`, 'IP头20: A→B', 'UDP头8', `数据${p.payload}`]), `链路${i + 1}：帧头使用本链路MAC，IP目的地仍是B；帧长（不含FCS）=${size}字节。${i ? '路由器解封装旧链路头再封装。' : '发送端从应用数据向外加头。'}`, { hop: i, sourceMac: 'M' + i, destinationMac: 'M' + (i + 1), sourceIp: 'A', destinationIp: 'B', frameBytes: size, overhead: 42, efficiency: p.payload / size })) }; });
    add('networks.c1.s2', '最长前缀匹配选择最具体路由', '匹配多条路由时，为什么不是选择第一条？', [range('host', '目的地址最后一段', 0, 255, 130), choice('specific', '更具体路由', [['on', '存在10.0.0.128/25'], ['off', '只到10.0.0.0/24']])], 'IPv4固定前缀10.0.0，路由表含0/0、10/8、10.0.0/24、可选/25；不模拟动态路由协议。', '多个前缀可以同时匹配；取最长前缀，而不是数值最小或列表第一条。', p => { const routes = [['0.0.0.0/0', 0, '默认'], ['10.0.0.0/8', 8, '区域'], ['10.0.0.0/24', 24, '本地']]; if (p.specific === 'on')
        routes.push(['10.0.0.128/25', 25, '上半子网']); const matches = routes.filter(r => r[1] !== 25 || p.host >= 128), winner = matches.reduce((a, b) => a[1] > b[1] ? a : b); return result(table(['路由前缀', '匹配', '出口'], routes.map(r => [r[0], matches.includes(r) ? '是' : '否', r === winner ? '选中 ' + r[2] : r[2]])), `10.0.0.${p.host}选择${winner[0]}。/25的边界在128；127与128只差1却可以走不同出口。`, { address: '10.0.0.' + p.host, prefix: winner[1], route: winner[0], network: winner[1] === 25 ? '10.0.0.128' : '10.0.0.0' }); });
    add('networks.c2.s2', '滑动窗口与丢包怎样限制在途数据', '增大窗口后，丢失的包会自动跳过吗？', [range('window', '窗口上限（包）', 1, 4, 3), range('lost', '首次丢失包号（0为不丢）', 0, 6, 2)], '6个顺序数据包；累计ACK与超时重传、接收端缓存乱序；简化拥塞窗口超时减半，不声称完整TCP Reno/CUBIC。', '窗口限制未确认数据，累计ACK不能跨越缺口；超时会重传并收缩拥塞窗口。', p => { let ack = 0, cwnd = p.window, time = 0; const received = new Set(), sent = new Set(), frames = []; let dropped = false; while (ack < 6 && time < 20) {
        const old = ack, batch = [];
        for (let id = ack + 1; id <= Math.min(6, ack + cwnd); id++) {
            batch.push(id);
            sent.add(id);
            if (id === p.lost && !dropped) {
                dropped = true;
            }
            else
                received.add(id);
        }
        while (received.has(ack + 1))
            ack++;
        const stalled = ack === old;
        if (stalled)
            cwnd = Math.max(1, Math.floor(cwnd / 2));
        frames.push(frame(Viz.cells(seq(6, i => received.has(i + 1) ? '包' + (i + 1) + '收到' : sent.has(i + 1) ? '包' + (i + 1) + '缺口' : '包' + (i + 1) + '待发'), { active: batch.map(x => x - 1) }), `轮${time}发送[${batch}]，累计确认到${ack}。${stalled ? '确认未前进，超时重传并减小窗口至' + cwnd : '窗口随ACK向前滑动。'}`, { round: time, batch, ack, cwnd, received: [...received].sort((a, b) => a - b), timeout: stalled }));
        time++;
    } return { frames }; });
    add('networks.c3.s2', '证书信任与密钥协商是不同检查', '握手消息都到了，证书不可信时还应该继续吗？', [choice('certificate', '证书情况', [['valid', '信任链与域名正确'], ['name', '域名不匹配'], ['untrusted', '未知根证书'], ['expired', '已过期']]), choice('tamper', 'Finished校验', [['no', '握手记录未被篡改'], ['yes', '握手记录被篡改']])], 'TLS1.3式教学阶段与布尔校验抽象；不执行真实密码学、不包含0-RTT、重协商或真实证书。', '证书验证身份，Finished确认握手完整性；加密连接不能绕过任一失败检查。', p => { const stages = ['ClientHello', 'ServerHello/共享秘密', '证书身份验证', 'Finished完整性', '应用数据'], frames = []; let accepted = false; for (let i = 0; i < stages.length; i++) {
        let note = stages[i];
        if (i === 2 && p.certificate !== 'valid') {
            note += '失败：' + ({ name: '域名不匹配', untrusted: '缺少可信根', expired: '超出有效期' }[p.certificate]);
            frames.push(frame(Viz.flow(stages, [i]), note + '；立即终止，不发送应用数据。', { stage: i, accepted: false, reason: p.certificate }));
            break;
        }
        if (i === 3 && p.tamper === 'yes') {
            frames.push(frame(Viz.flow(stages, [i]), 'Finished不匹配：中止握手。证书通过也不能忽略完整性失败。', { stage: i, accepted: false, reason: 'finished' }));
            break;
        }
        if (i === 4)
            accepted = true;
        frames.push(frame(Viz.flow(stages, [i]), note + '通过。', { stage: i, accepted, reason: null }));
    } return { frames }; });
    add('databases.c1.s1', '连接怎样把匹配行展开', '右表一键多行时，连接结果为什么比左表更大？', [choice('join', '连接类型', [['inner', 'INNER JOIN'], ['left', 'LEFT JOIN']]), range('orders', '用户1的订单数', 0, 3, 2)], '内存关系表：用户{1,2,3}，用户2固定1订单；SQL等值连接的NULL扩展抽象。', '连接按匹配对输出，不按左表行数输出；LEFT JOIN保留没有匹配的左行。', p => { const users = [1, 2, 3], orderRows = [...seq(p.orders, i => [1, 'A' + i]), [2, 'B0']], out = []; users.forEach(u => { const found = orderRows.filter(o => o[0] === u); if (found.length)
        found.forEach(o => out.push([u, o[1]]));
    else if (p.join === 'left')
        out.push([u, 'NULL']); }); return result(table(['用户ID', '匹配订单'], out), `左表3行，订单表${orderRows.length}行，连接结果${out.length}行。用户3${p.join === 'left' ? '保留为NULL扩展行' : '因无匹配而消失'}；用户1可展开多行。`, { users, orders: orderRows, result: out, count: out.length }); });
    add('databases.c1.s2', '索引是否总比全表扫描快', '匹配行太多时，随机回表会抵消索引优势吗？', [range('selectivity', '选择率百分比', 1, 100, 5), choice('cover', '索引是否覆盖', [['no', '需要随机回表'], ['yes', '覆盖所需字段']])], '教学成本：100页表、每页100行；索引寻路3页，叶页100键；非覆盖回表按每匹配行1页上界估计，非真实优化器。', '计划取决于选择率与访问模式；存在索引不意味着必然使用索引。', p => { const matches = 10000 * p.selectivity / 100, leaf = Math.ceil(matches / 100), index = 3 + leaf + (p.cover === 'no' ? matches : 0), scan = 100, best = index < scan ? '索引' : '全表扫描'; return result(Viz.bars([scan, index], ['顺序全扫页成本', '索引估计页成本']), `匹配${matches}行；全扫100，索引3+${leaf}${p.cover === 'no' ? '+' + matches : '（无需回表）'}=${index}，本模型选${best}。实际缓存与聚簇性会改变回表成本。`, { matches, indexCost: index, scanCost: scan, chosen: best }); });
    add('databases.c2.s2', '快照读与加锁读看见哪个版本', '另一事务提交以后，旧事务再次读取会改变吗？', [choice('isolation', '读取方式', [['snapshot', '事务级固定快照'], ['statement', '语句级快照'], ['lock', '持有共享读锁']]), range('newValue', '另一个事务更新值', 1, 9, 5)], '单记录MVCC版本链，T1在时间1开始，T2拟在时间2更新；锁模式持锁到T1结束；抽象隔离行为不绑定某数据库品牌。', '固定快照读取旧可见版本；锁也能阻止变化，但代价是写者等待。', p => { const blocked = p.isolation === 'lock', committed = !blocked, visible = p.isolation === 'statement' ? p.newValue : 0, frames = [frame(Viz.cells(['v0=0 @t0', 'T1开始@t1', 'T1读到0']), 'T1首次读取旧版本0。', { read: 0, versions: [0], blocked: false })]; frames.push(frame(Viz.cells(['v0=0', committed ? 'v1=' + p.newValue + ' @t2' : 'T2等待读锁']), committed ? 'T2提交新版本；旧版本为活跃快照保留。' : 'T1持有共享锁，T2写入被阻塞，尚未提交。', { versions: committed ? [0, p.newValue] : [0], blocked, committed })); frames.push(frame(Viz.cells([0, visible], { labels: ['T1第一次读', 'T1第二次读'] }), `T1再次读取${visible}：${p.isolation === 'snapshot' ? '复用事务开始时快照。' : p.isolation === 'statement' ? '本条语句的新快照看见已提交版本。' : '持锁期间写者不能提交。'}`, { firstRead: 0, secondRead: visible, blocked, committed })); return { frames }; });
    add('databases.c3.s1', 'WAL先写日志，崩溃后重放什么', '事务已经提交但数据页未落盘，会丢失更新吗？', [range('value', '事务新值', 1, 20, 9), choice('crash', '断电时刻', [['before', '提交日志落盘前'], ['after', '提交日志落盘后、页未写回'], ['flushed', '数据页也已写回']])], '单事务、单页、redo型已提交更新模型；未提交数据页不提前写回，不覆盖undo/steal细节。', '提交的持久性依靠先持久化日志，页可稍后写回；未提交日志不能作为已提交结果重放。', p => { const committed = p.crash !== 'before', page = p.crash === 'flushed' ? p.value : 0, recovered = committed ? p.value : 0; return { frames: [frame(Viz.cells([0, p.value, '未提交'], { labels: ['旧数据页', '更新日志', '事务状态'] }), '先追加更新日志，但还没有持久提交标记。', { page: 0, log: p.value, committed: false }), frame(Viz.cells([page, p.value, committed ? '已提交' : '未提交'], { labels: ['断电时页', '持久日志值', '提交记录'] }), '在选定位置断电，恢复只信任持久化的提交边界。', { page, log: p.value, committed }), frame(Viz.cells([recovered], { labels: ['恢复后的页'] }), committed ? (page === p.value ? '页已包含该更新；幂等重放不会重复加一次。' : '提交已持久化：redo把旧页更新为日志中的新值。') : '没有持久提交标记，恢复仍为0。', { recovered, committed, redone: committed && page !== p.value })] }; });
    add('databases.c3.s2', '分片与复制解决不同问题', '写到多数副本以后，任意一个副本都一定最新吗？', [range('key', '记录键', 0, 11, 5), choice('read', '读取集合', [['one', '读取一个落后副本'], ['quorum', '读取多数副本']])], '2分片key mod2；每分片3副本；写入版本1在前2副本完成，第3滞后；多数读选择最高版本，忽略并发冲突与故障重配置。', '分片决定数据放哪一组，复制决定同一数据有几份；多数集合相交不代表每个副本都已更新。', p => { const shard = p.key % 2, replicas = [1, 1, 0], readSet = p.read === 'one' ? [2] : [1, 2], observed = Math.max(...readSet.map(i => replicas[i])); return result(graph([`键${p.key}`, `分片${shard}`, `副本0 v1`, `副本1 v1`, `副本2 v0`], [[0, 1, 'mod2'], [1, 2], [1, 3], [1, 4]], readSet.map(i => i + 2)), `键进入分片${shard}。写多数W=2已成功；本次R=${readSet.length}读取版本${observed}。${p.read === 'one' ? '读落后副本得到旧值。' : 'R+W=4>3，读取集合与已写集合相交，按版本选到新值。'}`, { key: p.key, shard, replicas, readSet, observed, writeQuorum: 2 }); });
}
