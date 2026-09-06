import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateLearningVisual,
  readLearningVisualSpec,
  replayAnimation,
  visualSpecToArtifact,
} from '../learning-visual-spec.ts'
import { VISUAL_VERSION } from './types.ts'
import type {
  GeneratedLearningVisual,
  LearningVisualKind,
  VisualSceneManifest,
} from './types.ts'

type GoldCase = {
  id: string
  kind: LearningVisualKind
  request: string
  abstraction: string
  regionRoles: string[]
  objectRoles: string[]
  assertTruth: (generated: GeneratedLearningVisual) => void
}

const DIJKSTRA_REQUEST = '用 Dijkstra 解释有向图，起点 S，终点 T：S→A=4, S→B=1, B→A=2, A→C=1, B→C=5, C→T=3, A→T=7, B→T=10'
const EVENT_LOOP_REQUEST = `解释 JS event loop：
console.log('A');
setTimeout(() => console.log('B'), 0);
Promise.resolve().then(() => console.log('C'));
console.log('D');`

function finalManifest(generated: GeneratedLearningVisual) {
  const manifest = generated.artifact.steps.at(-1)?.manifest
  assert.ok(manifest, `${generated.spec.abstraction}: final manifest missing`)
  return manifest
}

function objectsWithRole(manifest: VisualSceneManifest, role: string) {
  return manifest.objects.filter(object => object.role === role)
}

function valuesWithRole(manifest: VisualSceneManifest, role: string) {
  return objectsWithRole(manifest, role).map(object => object.value)
}

function assertBoundsInsideViewport(manifest: VisualSceneManifest) {
  assert.deepEqual(manifest.viewport, [0, 0, 1000, 640])
  const [viewX, viewY, viewWidth, viewHeight] = manifest.viewport
  const allEntries = [...manifest.regions, ...manifest.objects]
  for (const entry of allEntries) {
    const [x, y, width, height] = entry.bounds
    assert.ok([x, y, width, height].every(Number.isFinite), `${entry.id}: non-finite bounds`)
    assert.ok(width >= 0 && height >= 0, `${entry.id}: negative extent`)
    assert.ok(x >= viewX && y >= viewY, `${entry.id}: starts outside viewport`)
    assert.ok(x + width <= viewX + viewWidth && y + height <= viewY + viewHeight, `${entry.id}: ends outside viewport`)
  }

  const regionIds = new Set(manifest.regions.map(region => region.id))
  const regions = new Map(manifest.regions.map(region => [region.id, region]))
  const allIds = [...manifest.regions.map(region => region.id), ...manifest.objects.map(object => object.id)]
  assert.equal(new Set(allIds).size, allIds.length, 'scene IDs must be unique')
  for (const object of manifest.objects) {
    assert.ok(regionIds.has(object.regionId), `${object.id}: unknown region`)
    const region = regions.get(object.regionId)!
    const [regionX, regionY, regionWidth, regionHeight] = region.bounds
    const [objectX, objectY, objectWidth, objectHeight] = object.bounds
    assert.ok(objectX >= regionX && objectY >= regionY, `${object.id}: starts outside assigned region`)
    assert.ok(
      objectX + objectWidth <= regionX + regionWidth && objectY + objectHeight <= regionY + regionHeight,
      `${object.id}: ends outside assigned region`,
    )
  }
}

function assertSafeSvg(svg: string) {
  assert.match(svg, /^<svg\b/)
  assert.match(svg, /<title>/)
  assert.match(svg, /<desc>/)
  assert.doesNotMatch(svg, /<(?:script|iframe|object|embed|foreignObject)\b|javascript:|data:text\/html|\son[a-z]+\s*=|\b(?:NaN|Infinity|undefined)\b/i)
}

function assertCommonGoldContract(generated: GeneratedLearningVisual, gold: GoldCase) {
  assert.equal(generated.spec.abstraction, gold.abstraction)
  assert.equal(generated.spec.kind, gold.kind)
  assert.equal(generated.spec.generation.source, 'deterministic_compiler')
  assert.ok(generated.spec.generation.compiler?.id)
  assert.ok(generated.spec.generation.compiler?.version)
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.degraded, false)
  assert.equal(generated.artifact.fallbackUsed, false)
  assert.equal(generated.artifact.status, 'usable')

  assert.equal(generated.quality.verification.level, 'derived_verified')
  assert.ok(generated.quality.verification.checked >= 1)
  assert.equal(generated.quality.verification.checked, generated.quality.verification.passed)
  assert.deepEqual(generated.quality.verification.failures, [])
  assert.ok(generated.quality.score >= 85, `quality score ${generated.quality.score}`)
  assert.deepEqual(generated.quality.layout, { collisions: 0, outOfBounds: 0 })
  assert.deepEqual(generated.quality.security, { executableContentRejected: true, finiteDataOnly: true })
  assert.equal(generated.quality.replayable, true)

  const regionRoles = new Set<string>()
  const objectRoles = new Set<string>()
  for (const step of generated.artifact.steps) {
    assertSafeSvg(step.svg)
    assert.ok(step.manifest, `${gold.id}: manifest missing on ${step.title}`)
    assertBoundsInsideViewport(step.manifest)
    step.manifest.regions.forEach(region => regionRoles.add(region.role))
    step.manifest.objects.forEach(object => objectRoles.add(object.role))
  }
  for (const role of gold.regionRoles) assert.ok(regionRoles.has(role), `${gold.id}: region role ${role} missing`)
  for (const role of gold.objectRoles) assert.ok(objectRoles.has(role), `${gold.id}: object role ${role} missing`)

  if (gold.kind === 'animation') {
    const predictionSteps = generated.artifact.steps.filter(step => step.prediction)
    assert.ok(predictionSteps.length >= 1, `${gold.id}: prediction gate missing`)
    for (const step of predictionSteps) {
      const prediction = step.prediction!
      assert.ok(prediction.prompt.length > 0)
      assert.ok(prediction.choices.length >= 2)
      assert.equal(new Set(prediction.choices.map(choice => choice.label)).size, prediction.choices.length, `${gold.id}: duplicate prediction labels`)
      assert.ok(prediction.choices.some(choice => choice.id === prediction.correctChoiceId))
      assert.ok(prediction.explanation.length > 0)
    }
  }
}

function assertDeterministicRoundTrip(generated: GeneratedLearningVisual, gold: GoldCase) {
  const persisted = JSON.parse(JSON.stringify(generated.artifact.replay.spec)) as unknown
  const readBack = readLearningVisualSpec(persisted, gold.kind, gold.request)
  assert.equal(readBack.version, VISUAL_VERSION)
  const rerendered = visualSpecToArtifact(readBack)

  assert.deepEqual(rerendered.artifact.steps, generated.artifact.steps)
  assert.deepEqual(rerendered.artifact.readable, generated.artifact.readable)
  assert.deepEqual(rerendered.quality, generated.quality)
  if (readBack.version === VISUAL_VERSION && readBack.kind === 'animation') {
    const replay = replayAnimation(readBack)
    assert.deepEqual(replay.finalState, readBack.finalState)
    assert.deepEqual(
      JSON.parse(JSON.stringify(replay.finalState)),
      JSON.parse(JSON.stringify(generated.spec.kind === 'animation' ? generated.spec.finalState : undefined)),
    )
  }
}

function assertDijkstraTruth(generated: GeneratedLearningVisual) {
  assert.equal(generated.spec.semantic.type, 'graph_algorithm')
  if (generated.spec.semantic.type !== 'graph_algorithm') return
  assert.deepEqual(generated.spec.semantic.edges.map(edge => edge.weight), [4, 1, 2, 1, 5, 3, 7, 10])

  const manifest = finalManifest(generated)
  const graphNodes = objectsWithRole(manifest, 'graph-node')
  assert.ok(new Set(graphNodes.map(node => node.bounds[0])).size >= 3, 'Dijkstra graph must expose multiple topology layers')
  assert.ok(new Set(graphNodes.map(node => node.bounds[1])).size >= 2, 'same-layer nodes must not collapse into one horizontal line')
  assert.deepEqual(valuesWithRole(manifest, 'edge-weight-label'), [4, 1, 2, 1, 5, 3, 7, 10])
  assert.deepEqual(valuesWithRole(manifest, 'distance-parent-row'), [0, 3, 1, 4, 7])
  const result = objectsWithRole(manifest, 'shortest-path-result')
  assert.equal(result.length, 1)
  assert.equal(result[0].value, 7)
  assert.equal(result[0].status, 'target-settled')
  assert.deepEqual(
    objectsWithRole(manifest, 'weighted-edge').filter(edge => edge.status === 'shortest-path').map(edge => edge.value),
    [1, 2, 1, 3],
  )
  assert.match(generated.artifact.readable.summary, /s→b→a→c→t/i)
  assert.match(generated.artifact.readable.summary, /总代价 7/)
}

const GOLD_CASES: GoldCase[] = [
  {
    id: 'matrix-diagram',
    kind: 'diagram',
    request: '矩阵乘法 A=[[1,2,0],[-1,3,2]]，B=[[2,1],[0,-1],[4,3]]，重点解释 C_21',
    abstraction: 'matrix_operation',
    regionRoles: ['matrix-operation', 'focus-cell-derivation'],
    objectRoles: ['matrix-cell', 'dimension-contract', 'dot-product-expansion', 'transfer-question'],
    assertTruth(generated) {
      assert.equal(generated.spec.semantic.type, 'matrix_operation')
      const manifest = finalManifest(generated)
      const resultCells = objectsWithRole(manifest, 'matrix-cell').filter(cell => /_matrix_c\.r\d+\.c\d+_/.test(cell.id))
      assert.deepEqual(resultCells.map(cell => cell.value), [2, -1, 6, 2])
      assert.equal(resultCells.find(cell => cell.status === 'focus-result')?.value, 6)
      const dotProduct = objectsWithRole(manifest, 'dot-product-expansion')
      assert.equal(dotProduct.length, 1)
      assert.equal(dotProduct[0].value, 6)
      assert.equal(dotProduct[0].status, 'verified-result')
      assert.equal(objectsWithRole(manifest, 'dimension-contract')[0]?.status, 'inner-dimensions-match')
    },
  },
  {
    id: 'dijkstra-diagram',
    kind: 'diagram',
    request: DIJKSTRA_REQUEST,
    abstraction: 'graph_algorithm',
    regionRoles: ['weighted-directed-graph', 'distance-and-parent-table', 'relaxation-and-shortest-path-summary'],
    objectRoles: ['weighted-edge', 'edge-weight-label', 'graph-node', 'distance-parent-row', 'relaxation-formula', 'shortest-path-result'],
    assertTruth: assertDijkstraTruth,
  },
  {
    id: 'bayes-natural-frequency-diagram',
    kind: 'diagram',
    request: '用自然频数解释贝叶斯：总人数 10000，患病率 1%，敏感度 90%，特异度 95%',
    abstraction: 'natural_frequency',
    regionRoles: ['three-level-natural-frequency-tree', 'posterior-ratio-and-formula'],
    objectRoles: ['frequency-count', 'true-positive-false-positive-ratio', 'posterior-formula', 'prediction-question'],
    assertTruth(generated) {
      assert.equal(generated.spec.semantic.type, 'natural_frequency')
      const manifest = finalManifest(generated)
      assert.deepEqual(valuesWithRole(manifest, 'frequency-count'), [10000, 100, 9900, 90, 10, 495, 9405, 585])
      const posterior = objectsWithRole(manifest, 'posterior-formula')[0]
      assert.ok(Math.abs(Number(posterior?.value) - 90 / 585) < 1e-12)
      assert.equal(posterior?.status, 'verified-posterior')
      assert.match(generated.artifact.steps[0].svg, /15\.4%/)
    },
  },
  {
    id: 'event-loop-animation',
    kind: 'animation',
    request: EVENT_LOOP_REQUEST,
    abstraction: 'event_loop',
    regionRoles: ['source-code', 'call-stack', 'web-api', 'microtask-queue', 'task-queue', 'output-sequence'],
    objectRoles: ['source-line', 'stable-callback-token', 'observable-output-order'],
    assertTruth(generated) {
      assert.equal(generated.spec.semantic.type, 'event_loop')
      const final = finalManifest(generated)
      assert.equal(objectsWithRole(final, 'observable-output-order')[0]?.value, 'A,D,C,B')
      assert.deepEqual(objectsWithRole(final, 'stable-callback-token').map(token => token.value), ['A', 'B', 'C', 'D'])
      const outputTokens = objectsWithRole(final, 'stable-callback-token')
        .filter(token => token.status === 'output')
        .sort((left, right) => left.bounds[1] - right.bounds[1] || left.bounds[0] - right.bounds[0])
      assert.deepEqual(outputTokens.map(token => token.value), ['A', 'D', 'C', 'B'])

      const stableTokenIds = new Map<string | number | boolean | null | undefined, string>()
      for (const step of generated.artifact.steps) {
        for (const token of objectsWithRole(step.manifest!, 'stable-callback-token')) {
          const previous = stableTokenIds.get(token.value)
          if (previous) assert.equal(token.id, previous, `callback ${String(token.value)} changed identity`)
          else stableTokenIds.set(token.value, token.id)
        }
      }
      const gate = generated.artifact.steps.find(step => step.prediction)?.prediction
      assert.equal(gate?.correctChoiceId, 'choice_microtask')
      assert.equal(gate?.choices.find(choice => choice.id === gate.correctChoiceId)?.label, 'C')
      assert.doesNotMatch(generated.spec.subtitle, /A\s*[→,，]\s*D\s*[→,，]\s*C\s*[→,，]\s*B/)
      assert.doesNotMatch(generated.artifact.steps[0].svg, /A\s*→\s*D\s*→\s*C\s*→\s*B/)

      const activeCallbackStep = generated.artifact.steps.find(step => (
        objectsWithRole(step.manifest!, 'stable-callback-token')
          .some(token => token.value === 'C' && token.status === 'stack:active')
      ))
      assert.ok(activeCallbackStep, 'active microtask callback must enter the call stack before output')
      const activeCallback = objectsWithRole(activeCallbackStep.manifest!, 'stable-callback-token')
        .find(token => token.value === 'C' && token.status === 'stack:active')!
      assert.equal(
        activeCallbackStep.manifest!.regions.find(region => region.id === activeCallback.regionId)?.role,
        'call-stack',
      )
    },
  },
  {
    id: 'dijkstra-animation',
    kind: 'animation',
    request: DIJKSTRA_REQUEST.replace('解释', '逐帧演示'),
    abstraction: 'graph_algorithm',
    regionRoles: ['weighted-directed-graph', 'distance-and-parent-table', 'relaxation-and-shortest-path-summary'],
    objectRoles: ['weighted-edge', 'edge-weight-label', 'graph-node', 'distance-parent-row', 'relaxation-formula', 'shortest-path-result'],
    assertTruth(generated) {
      assertDijkstraTruth(generated)
      const fixedGeometry = new Map<string, readonly [number, number, number, number]>()
      for (const step of generated.artifact.steps) {
        for (const object of step.manifest!.objects.filter(item => ['graph-node', 'weighted-edge', 'edge-weight-label'].includes(item.role))) {
          const previous = fixedGeometry.get(object.id)
          if (previous) assert.deepEqual(object.bounds, previous, `${object.id}: graph geometry moved between frames`)
          else fixedGeometry.set(object.id, object.bounds)
        }
      }
      const gate = generated.artifact.steps.find(step => step.prediction)?.prediction
      assert.ok(gate?.choices.some(choice => /^b（距离 1）/i.test(choice.label)))
      assert.doesNotMatch(generated.spec.subtitle, /总代价\s*7|S\s*→\s*B\s*→\s*A\s*→\s*C\s*→\s*T/i)
      assert.doesNotMatch(generated.artifact.steps[0].svg, /总代价\s*7|S\s*→\s*B\s*→\s*A\s*→\s*C\s*→\s*T/i)
    },
  },
  {
    id: 'gradient-descent-animation',
    kind: 'animation',
    request: '演示 f(x)=(x-2)^2 的梯度下降，x0=-2，学习率 α=.25，迭代 4 步',
    abstraction: 'optimization',
    regionRoles: ['fixed-camera-objective-plot', 'gradient-and-update-formulas'],
    objectRoles: ['fixed-coordinate-system', 'objective-curve', 'stable-current-point', 'gradient-tangent', 'gradient-descent-update', 'parameter-update-arrow', 'parameter-sequence'],
    assertTruth(generated) {
      assert.equal(generated.spec.semantic.type, 'optimization')
      if (generated.spec.semantic.type !== 'optimization') return
      const [xMinimum, xMaximum] = generated.spec.semantic.axes.xDomain
      assert.ok(generated.spec.semantic.axes.yDomain[1] > Math.max(
        (xMinimum - generated.spec.semantic.center) ** 2,
        (xMaximum - generated.spec.semantic.center) ** 2,
      ), 'plot domain must contain the full visible objective curve without a clipped plateau')
      const final = finalManifest(generated)
      assert.equal(objectsWithRole(final, 'stable-current-point')[0]?.value, 1.75)
      assert.equal(objectsWithRole(final, 'gradient-formula')[0]?.value, -0.5)
      assert.match(generated.artifact.steps.at(-1)?.svg || '', /-2 → 0 → 1 → 1\.5 → 1\.75/)

      const fixedAxes = generated.artifact.steps.map(step => objectsWithRole(step.manifest!, 'fixed-coordinate-system')[0])
      assert.ok(fixedAxes.every(Boolean))
      for (const axes of fixedAxes.slice(1)) {
        assert.equal(axes.id, fixedAxes[0].id)
        assert.deepEqual(axes.bounds, fixedAxes[0].bounds)
        assert.equal(axes.status, 'camera-fixed-across-frames')
      }
      const gateIndex = generated.artifact.steps.findIndex(step => step.prediction)
      assert.equal(gateIndex, 1, 'prediction must occur before the first derived update is revealed')
      const gate = generated.artifact.steps[gateIndex]?.prediction
      assert.equal(gate?.choices.find(choice => choice.id === gate.correctChoiceId)?.label, '0')
      const gateStep = generated.artifact.steps[gateIndex]
      const gateUpdate = objectsWithRole(gateStep!.manifest!, 'gradient-descent-update')[0]
      assert.equal(gateUpdate?.status, 'prediction-pending')
      assert.equal(gateUpdate?.value, null)
      assert.match(gateStep?.svg || '', /先预测/)
      assert.doesNotMatch(gateStep?.svg || '', /0\s*→\s*1|1\s*→\s*1\.5|1\.5\s*→\s*1\.75/)
      const revealedUpdate = objectsWithRole(generated.artifact.steps[gateIndex + 1].manifest!, 'gradient-descent-update')[0]
      assert.equal(revealedUpdate?.status, 'next-value')
      assert.equal(revealedUpdate?.value, 0)
      assert.equal(objectsWithRole(final, 'gradient-descent-update')[0]?.status, 'trace-summary')
    },
  },
]

test('six gold teaching requests compile end to end without a model and replay deterministically', async () => {
  let modelCalls = 0
  const forbiddenModel = async () => {
    modelCalls += 1
    throw new Error('gold teaching compiler must not call the model')
  }

  for (const gold of GOLD_CASES) {
    const generated = await generateLearningVisual(gold.kind, gold.request, forbiddenModel)
    assertCommonGoldContract(generated, gold)
    gold.assertTruth(generated)
    assertDeterministicRoundTrip(generated, gold)
  }
  assert.equal(modelCalls, 0)
})

test('deterministic compiler rejects incompatible matrix dimensions before model fallback', async () => {
  let modelCalls = 0
  await assert.rejects(
    generateLearningVisual('diagram', '矩阵相乘 A=[[1,2,3]] B=[[1,2],[3,4]]', async () => {
      modelCalls += 1
      return '{}'
    }),
    /visual_generation_unavailable:visual_deterministic_derivation_failed:matrix_dimension_mismatch/,
  )
  assert.equal(modelCalls, 0)
})

test('deterministic compiler rejects negative Dijkstra weights before model fallback', async () => {
  let modelCalls = 0
  await assert.rejects(
    generateLearningVisual('diagram', 'Dijkstra 有向图，起点 S，终点 T：S→A=-1, A→T=2', async () => {
      modelCalls += 1
      return '{}'
    }),
    /visual_generation_unavailable:visual_deterministic_derivation_failed:dijkstra_negative_weight/,
  )
  assert.equal(modelCalls, 0)
})

test('recognized computable requests never fall through to an unverified model answer', async () => {
  let modelCalls = 0
  const model = async () => {
    modelCalls += 1
    return JSON.stringify({ kind: 'diagram', title: '不相关模型答案' })
  }
  await assert.rejects(
    generateLearningVisual('diagram', '矩阵乘法 A=(1 2; 3 4)，B=(5 6; 7 8)', model),
    /visual_generation_needs_input:visual_deterministic_inputs_ambiguous:matrix_operation/,
  )
  await assert.rejects(
    generateLearningVisual('animation', '演示 f(x)=(x-2)^2 的梯度下降，x0=-2，学习率 α=.25，迭代 6 步', model),
    /visual_generation_unavailable:visual_deterministic_spec_unsupported/,
  )
  assert.equal(modelCalls, 0)
})

test('deterministic hardening rejects unsafe or ambiguous computable inputs without a model', async () => {
  let modelCalls = 0
  const forbiddenModel = async () => {
    modelCalls += 1
    return '{}'
  }
  await assert.rejects(
    generateLearningVisual('diagram', '矩阵乘法 A=[[10000000]]，B=[[1]]，重点解释 C_11', forbiddenModel),
    /visual_generation_unavailable:visual_deterministic_derivation_failed:matrix_value_out_of_range/,
  )
  await assert.rejects(
    generateLearningVisual('diagram', 'Dijkstra 有向图，起点 S，终点 T：S→A=4, S→A=1, A→T=2', forbiddenModel),
    /visual_generation_unavailable:visual_deterministic_derivation_failed:dijkstra_parallel_edge/,
  )
  await assert.rejects(
    generateLearningVisual('animation', "解释 JS event loop：setTimeout(() => console.log('late'), 100); console.log('now');", forbiddenModel),
    /visual_generation_needs_input:visual_deterministic_inputs_ambiguous:event_loop/,
  )
  assert.equal(modelCalls, 0)
})

test('large finite results, colliding normalized labels and stationary optima remain truthful', async () => {
  const forbiddenModel = async () => {
    throw new Error('deterministic cases must not call the model')
  }
  const large = await generateLearningVisual(
    'diagram',
    '矩阵乘法 A=[[1000000,1000000,1000000,1000000,1000000,1000000,1000000,1000000]]，B=[[1000000],[1000000],[1000000],[1000000],[1000000],[1000000],[1000000],[1000000]]，重点解释 C_11',
    forbiddenModel,
  )
  const largeResult = objectsWithRole(finalManifest(large), 'matrix-cell').find(cell => cell.status === 'focus-result')
  assert.equal(largeResult?.value, 8_000_000_000_000)
  assert.match(large.artifact.steps[0].svg, /8e\+12/)

  const collidingLabels = await generateLearningVisual(
    'diagram',
    'Dijkstra 有向图，起点 S，终点 T：S→A=1, S→a=2, A→T=3, a→T=1',
    forbiddenModel,
  )
  assert.equal(collidingLabels.spec.semantic.type, 'graph_algorithm')
  if (collidingLabels.spec.semantic.type === 'graph_algorithm') {
    assert.equal(new Set(collidingLabels.spec.semantic.nodes.map(node => node.id)).size, collidingLabels.spec.semantic.nodes.length)
    assert.deepEqual(collidingLabels.spec.semantic.nodes.map(node => node.label), ['S', 'A', 'a', 'T'])
  }

  const stationary = await generateLearningVisual(
    'animation',
    '演示 f(x)=(x-2)^2 的梯度下降，x0=2，学习率 α=.25，迭代 2 步',
    forbiddenModel,
  )
  assert.equal(stationary.spec.generation.source, 'deterministic_compiler')
  assert.equal(stationary.quality.verification.level, 'derived_verified')
  assert.ok(stationary.artifact.steps.every(step => !step.prediction), 'a zero-gradient start must not create duplicate prediction choices')
})

test('supported density boundaries preserve the scene and replay contracts', async () => {
  const forbiddenModel = async () => {
    throw new Error('supported boundary cases must not call the model')
  }
  const matrix = Array.from({ length: 8 }, () => Array(8).fill(1))
  const cases = [
    await generateLearningVisual(
      'diagram',
      `矩阵乘法 A=${JSON.stringify(matrix)}，B=${JSON.stringify(matrix)}，重点解释 C_88`,
      forbiddenModel,
    ),
    await generateLearningVisual(
      'diagram',
      'Dijkstra 有向图，起点 S，终点 T：S→A=1, S→B=3, A→C=1, B→D=1, C→E=1, D→F=1, E→T=1, F→T=1',
      forbiddenModel,
    ),
    await generateLearningVisual(
      'animation',
      "解释 JS event loop：console.log('A'); console.log('B'); Promise.resolve().then(() => console.log('M')); console.log('C'); setTimeout(() => console.log('T'), 0); console.log('D'); console.log('E');",
      forbiddenModel,
    ),
    await generateLearningVisual(
      'animation',
      '演示 f(x)=(x-2)^2 的梯度下降，x0=-2，学习率 α=.25，迭代 5 步',
      forbiddenModel,
    ),
  ]

  for (const generated of cases) {
    assert.equal(generated.spec.generation.source, 'deterministic_compiler')
    assert.equal(generated.quality.verification.level, 'derived_verified')
    assert.deepEqual(generated.quality.layout, { collisions: 0, outOfBounds: 0 })
    for (const step of generated.artifact.steps) assertBoundsInsideViewport(step.manifest!)
    if (generated.spec.kind === 'animation') assert.deepEqual(replayAnimation(generated.spec).finalState, generated.spec.finalState)
  }
})

test('an unroutable dense graph fails explicitly instead of reporting a false zero-collision layout', async () => {
  const edges = [
    'S→A=1', 'A→B=1', 'B→C=1', 'C→D=1', 'D→E=1', 'E→F=1', 'F→T=1',
    'B→S=1', 'C→S=1', 'C→A=1', 'D→S=1', 'D→A=1', 'D→B=1',
    'E→S=1', 'E→A=1', 'E→B=1', 'E→C=1', 'F→S=1', 'F→A=1', 'F→B=1',
    'F→C=1', 'F→D=1', 'T→S=1', 'T→A=1',
  ].join(', ')
  await assert.rejects(
    generateLearningVisual('diagram', `Dijkstra 有向图，起点 S，终点 T：${edges}`, async () => {
      throw new Error('a recognized computable graph must not call the model')
    }),
    /visual_generation_unavailable:visual_scene_graph_(?:edge_or_label_route_blocked|foreign_edge_crosses_label)/,
  )
})
