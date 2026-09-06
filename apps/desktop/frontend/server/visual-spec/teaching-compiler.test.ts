import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveDijkstra, verifyDerivedSemantic } from './derived.ts'
import { deriveTeachingRequest } from './teaching-compiler.ts'
import { teachingDerivationToSpec } from './teaching-spec.ts'
import type { GraphAlgorithmSemantic } from './types.ts'

test('derives arbitrary compatible matrix products and a requested focus cell', () => {
  const result = deriveTeachingRequest('diagram', '矩阵乘法 A=[[1,2,0],[-1,3,2]]，B=[[2,1],[0,-1],[4,3]]，重点解释 C_21')
  assert.equal(result?.type, 'matrix_multiplication')
  if (result?.type !== 'matrix_multiplication') return
  assert.deepEqual(result.derived.result, [[2, -1], [6, 2]])
  assert.deepEqual(result.derived.focus?.terms.map((term) => term.product), [-2, 0, 8])
  assert.equal(result.derived.focus?.value, 6)
  assert.equal(result.verification, 'derived_verified')
})

test('matrix multiplication generalizes and reports exact dimension failure', () => {
  const varied = deriveTeachingRequest('diagram', 'multiply matrices A=[[2,-1],[0,3]] and B=[[4],[5]]; show C[1,1]')
  assert.equal(varied?.type, 'matrix_multiplication')
  if (varied?.type === 'matrix_multiplication') assert.deepEqual(varied.derived.result, [[3], [15]])

  const rejected = deriveTeachingRequest('diagram', '矩阵相乘 A=[[1,2,3]] B=[[1,2],[3,4]]')
  assert.equal(rejected?.type, 'derivation_failure')
  if (rejected?.type === 'derivation_failure') {
    assert.equal(rejected.derived.code, 'matrix_dimension_mismatch')
    assert.deepEqual(rejected.derived.details, { leftShape: [1, 3], rightShape: [2, 2] })
  }
})

test('matrix compiler shares the canonical magnitude bound and keeps every derived value finite', () => {
  const bounded = deriveTeachingRequest('diagram', '矩阵乘法 A=[[1000000,-1000000]] B=[[1000000],[-1000000]]，解释 C11')
  assert.equal(bounded?.type, 'matrix_multiplication')
  if (bounded?.type === 'matrix_multiplication') {
    assert.deepEqual(bounded.derived.result, [[2000000000000]])
    assert.ok(bounded.derived.result.flat().every(Number.isFinite))
    assert.ok(bounded.derived.focus?.terms.every((term) => Number.isFinite(term.product)))
  }

  const rejected = deriveTeachingRequest('diagram', '矩阵乘法 A=[[1000001]] B=[[1]]')
  assert.equal(rejected?.type, 'derivation_failure')
  if (rejected?.type === 'derivation_failure') assert.equal(rejected.derived.code, 'matrix_value_out_of_range')
})

test('deterministic arithmetic preserves the original finite number precision', () => {
  const precise = 0.123456789012345
  const result = deriveTeachingRequest('diagram', `矩阵乘法 A=[[${precise}]] B=[[1]]，解释 C11`)
  assert.equal(result?.type, 'matrix_multiplication')
  if (result?.type !== 'matrix_multiplication') return
  assert.equal(result.input.matrices.A[0][0], precise)
  assert.equal(result.derived.focus?.terms[0].product, precise)
  assert.equal(result.derived.result[0][0], precise)
})

test('derives directed Dijkstra state, parents, path and relaxations', () => {
  const result = deriveTeachingRequest(
    'animation',
    '用 Dijkstra 演示有向图，起点 S，终点 T：S→A=4, S→B=1, B→A=2, A→C=1, B→C=5, C→T=3, A→T=7, B→T=10',
  )
  assert.equal(result?.type, 'dijkstra')
  if (result?.type !== 'dijkstra') return
  assert.equal(result.input.directed, true)
  assert.deepEqual(result.derived.distances, { S: 0, A: 3, B: 1, C: 4, T: 7 })
  assert.deepEqual(result.derived.settledOrder, ['S', 'B', 'A', 'C', 'T'])
  assert.deepEqual(result.derived.path, ['S', 'B', 'A', 'C', 'T'])
  assert.equal(result.derived.pathCost, 7)
  assert.ok(result.derived.relaxations.some((item) => item.from === 'B' && item.to === 'A' && item.updated))
})

test('Dijkstra handles an undirected parameter variation and rejects negative weights', () => {
  const varied = deriveTeachingRequest('diagram', 'Dijkstra 无向图，从 A 到 D：A-B:2, B-C:1, A-C:7, C-D:3, B-D:9')
  assert.equal(varied?.type, 'dijkstra')
  if (varied?.type === 'dijkstra') {
    assert.equal(varied.input.directed, false)
    assert.deepEqual(varied.derived.path, ['A', 'B', 'C', 'D'])
    assert.equal(varied.derived.pathCost, 6)
  }
  const rejected = deriveTeachingRequest('diagram', 'Dijkstra 有向图，起点 S：S→A=-1, A→T=2')
  assert.equal(rejected?.type, 'derivation_failure')
  if (rejected?.type === 'derivation_failure') assert.equal(rejected.derived.code, 'dijkstra_negative_weight')
})

test('Dijkstra rejects directed and undirected parallel edges with a precise failure', () => {
  const directed = deriveTeachingRequest('diagram', 'Dijkstra 有向图，从 S 到 T：S→T=10, S→T=1')
  assert.equal(directed?.type, 'derivation_failure')
  if (directed?.type === 'derivation_failure') {
    assert.equal(directed.derived.code, 'dijkstra_parallel_edge')
    assert.deepEqual(directed.derived.details, { from: 'S', to: 'T', directed: true })
  }

  const undirected = deriveTeachingRequest('diagram', 'Dijkstra 无向图，从 S 到 T：S-T:10, T-S:1')
  assert.equal(undirected?.type, 'derivation_failure')
  if (undirected?.type === 'derivation_failure') assert.equal(undirected.derived.code, 'dijkstra_parallel_edge')
})

test('Dijkstra uses strict relaxation for sub-nanosecond improvements', () => {
  const result = deriveTeachingRequest('diagram', 'Dijkstra 有向图，从 S 到 T：S→T=1, S→A=.5, A→T=.4999999995')
  assert.equal(result?.type, 'dijkstra')
  if (result?.type !== 'dijkstra') return
  assert.equal(result.derived.pathCost, 0.9999999995)
  assert.deepEqual(result.derived.path, ['S', 'A', 'T'])
  assert.ok(result.derived.relaxations.some(relaxation => relaxation.from === 'A' && relaxation.to === 'T' && relaxation.updated))

  const tie = deriveTeachingRequest('diagram', 'Dijkstra 有向图，从 S 到 T：S→A=1, S→B=1, A→T=1, B→T=1')
  assert.equal(tie?.type, 'dijkstra')
  if (tie?.type === 'dijkstra') {
    assert.deepEqual(tie.derived.settledOrder, ['S', 'A', 'B', 'T'])
    assert.equal(tie.derived.parents.T, 'A')
  }
})

test('derived graph verification compares Dijkstra with an independent undirected shortest-path oracle', () => {
  const semantic: GraphAlgorithmSemantic = {
    type: 'graph_algorithm',
    id: 'strict_graph',
    algorithm: 'dijkstra',
    directed: false,
    nodes: ['S', 'A', 'T'].map(id => ({ id, label: id })),
    edges: [
      { id: 'direct', from: 'T', to: 'S', weight: 1 },
      { id: 'first', from: 'A', to: 'S', weight: 0.5 },
      { id: 'second', from: 'T', to: 'A', weight: 0.4999999995 },
    ],
    sourceId: 'S',
    targetId: 'T',
  }
  const derived = deriveDijkstra(semantic)
  assert.equal(derived.cost, 0.9999999995)
  assert.deepEqual(derived.pathNodeIds, ['S', 'A', 'T'])
  assert.deepEqual(verifyDerivedSemantic(semantic), { checked: 1, passed: 1, failures: [] })
})

test('derives exact natural-frequency Bayes counts in Chinese and English', () => {
  const result = deriveTeachingRequest('diagram', '用自然频数解释贝叶斯：总人数 10000，患病率 1%，敏感度 90%，特异度 95%')
  assert.equal(result?.type, 'natural_frequency_bayes')
  if (result?.type !== 'natural_frequency_bayes') return
  assert.deepEqual(result.derived, {
    diseased: 100,
    healthy: 9900,
    truePositive: 90,
    falseNegative: 10,
    falsePositive: 495,
    trueNegative: 9405,
    positive: 585,
    posterior: 90 / 585,
  })

  const varied = deriveTeachingRequest('diagram', 'Bayes natural frequency population=2000 prevalence=5% sensitivity=80% specificity=90%')
  assert.equal(varied?.type, 'natural_frequency_bayes')
  if (varied?.type === 'natural_frequency_bayes') assert.deepEqual(
    [varied.derived.truePositive, varied.derived.falsePositive, varied.derived.positive],
    [80, 190, 270],
  )
  assert.equal(deriveTeachingRequest('diagram', 'Bayes population=101 prevalence=10% sensitivity=80% specificity=90%'), undefined)
})

test('recognized natural-frequency requests fail closed when specificity is missing', () => {
  const result = deriveTeachingRequest('diagram', 'Bayes natural frequency population=1000 prevalence=1% sensitivity=90%')
  assert.equal(result?.type, 'derivation_failure')
  if (result?.type !== 'derivation_failure') return
  assert.equal(result.input.category, 'natural_frequency')
  assert.equal(result.derived.code, 'natural_frequency_specificity_missing')
})

test('derives the simple JS event-loop queue order without executing code', () => {
  const result = deriveTeachingRequest('animation', `解释 JS event loop：
console.log('A');
setTimeout(() => console.log('B'), 0);
Promise.resolve().then(() => console.log('C'));
console.log('D');`)
  assert.equal(result?.type, 'js_event_loop')
  if (result?.type !== 'js_event_loop') return
  assert.deepEqual(result.derived, {
    sync: ['A', 'D'],
    microtasks: ['C'],
    tasks: ['B'],
    outputOrder: ['A', 'D', 'C', 'B'],
  })
  assert.deepEqual(result.input.events.map((event) => event.sourceLineNumber), [2, 3, 4, 5])
})

test('event-loop compiler keeps real source lines for multiple logs and multiline Promise code', () => {
  const result = deriveTeachingRequest('animation', `JS event loop:
console.log('A'); console.log('D');
setTimeout(() => console.log('B'), 0);
Promise.resolve()
  .then(() => console.log('C'));`)
  assert.equal(result?.type, 'js_event_loop')
  if (result?.type !== 'js_event_loop') return
  assert.deepEqual(result.input.codeLines, [
    { number: 2, text: "console.log('A'); console.log('D');" },
    { number: 3, text: "setTimeout(() => console.log('B'), 0);" },
    { number: 4, text: 'Promise.resolve()' },
    { number: 5, text: ".then(() => console.log('C'));" },
  ])
  assert.deepEqual(result.input.events.map((event) => [event.output, event.sourceLineNumber]), [
    ['A', 2],
    ['D', 2],
    ['B', 3],
    ['C', 5],
  ])
  assert.deepEqual(result.derived.outputOrder, ['A', 'D', 'C', 'B'])
})

test('event-loop compiler refuses non-zero timer delays instead of asserting source order', () => {
  assert.equal(deriveTeachingRequest('animation', `JS event loop:
console.log('A');
setTimeout(() => console.log('B'), 100);
setTimeout(() => console.log('C'), 0);`), undefined)
})

test('event-loop compiler rejects unknown async structures', () => {
  assert.equal(deriveTeachingRequest('animation', `JS event loop:
console.log('A');
queueMicrotask(() => console.log('B'));
console.log('C');`), undefined)
  assert.equal(deriveTeachingRequest('animation', `JS event loop:
console.log('A');
fetch('/x').then(() => console.log('B'));`), undefined)
})

test('event-loop compiler consumes only the three supported top-level statement forms', () => {
  const unsupported = [
    `JS event loop:\nfunction run() { console.log('A'); setTimeout(() => console.log('B'), 0); }`,
    `JS event loop:\nclass Runner { run() { console.log('A'); } }\nsetTimeout(() => console.log('B'), 0);`,
    `JS event loop:\nconst value = 1;\nconsole.log('A');\nsetTimeout(() => console.log('B'), 0);`,
    `JS event loop:\nconsole.log('A');\nsetTimeout(() => { console.log('B'); console.log('C'); }, 0);`,
    `JS event loop:\nconsole.log('A');\nsetTimeout(() => console.log('B'), 0);\nconsume();`,
  ]
  unsupported.forEach(source => assert.equal(deriveTeachingRequest('animation', source), undefined))
})

test('event-loop tokenizer ignores fake calls in comments and rejects string bait', () => {
  const comments = deriveTeachingRequest('animation', `JS event loop:
// console.log('fake'); Promise.resolve().then(() => console.log('also fake'));
/* setTimeout(() => console.log('still fake'), 0); */
console.log('A');
setTimeout(() => console.log('B'), 0);`)
  assert.equal(comments?.type, 'js_event_loop')
  if (comments?.type === 'js_event_loop') {
    assert.deepEqual(comments.derived.outputOrder, ['A', 'B'])
    assert.deepEqual(comments.input.events.map(event => event.sourceLineNumber), [4, 5])
  }
  assert.equal(deriveTeachingRequest('animation', `JS event loop:
"console.log('fake')";
console.log('A');
setTimeout(() => console.log('B'), 0);`), undefined)
})

test('derives quadratic gradient descent and a shifted parameter variation', () => {
  const result = deriveTeachingRequest('animation', '演示 f(x)=(x-2)^2 的梯度下降，x0=-2，学习率 α=.25，迭代 4 步')
  assert.equal(result?.type, 'quadratic_gradient_descent')
  if (result?.type !== 'quadratic_gradient_descent') return
  assert.deepEqual(result.derived.points.map((point) => point.x), [-2, 0, 1, 1.5, 1.75])
  assert.deepEqual(result.derived.iterations[0], { step: 1, x: -2, y: 16, gradient: -8, delta: 2, nextX: 0, nextY: 4 })

  const varied = deriveTeachingRequest('animation', 'gradient descent for f=(x+1)^2, initial x=3, alpha=0.5, 2 steps')
  assert.equal(varied?.type, 'quadratic_gradient_descent')
  if (varied?.type === 'quadratic_gradient_descent') assert.deepEqual(varied.derived.points.map((point) => point.x), [3, -1, -1])
})

test('optimization camera is constructed from the complete oscillating trace', () => {
  const derivation = deriveTeachingRequest('animation', 'gradient descent for f=(x-0)^2, initial x=10, alpha=.75, 3 steps')
  assert.equal(derivation?.type, 'quadratic_gradient_descent')
  if (derivation?.type !== 'quadratic_gradient_descent') return
  assert.deepEqual(derivation.derived.points.map(point => point.x), [10, -5, 2.5, -1.25])
  const spec = teachingDerivationToSpec(derivation)
  assert.equal(spec?.semantic.type, 'optimization')
  if (!spec || spec.semantic.type !== 'optimization') return
  const semantic = spec.semantic
  derivation.derived.points.forEach(point => {
    assert.ok(point.x >= semantic.axes.xDomain[0] && point.x <= semantic.axes.xDomain[1])
    assert.ok(point.y >= semantic.axes.yDomain[0] && point.y <= semantic.axes.yDomain[1])
  })
  assert.deepEqual(verifyDerivedSemantic(semantic), { checked: 1, passed: 1, failures: [] })
})
