import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeVisualTeachingBundle,
  explanationOnlyVisualTeachingBundle,
  parseVisualTeachingBrief,
  validateVisualTeachingExplanation,
  visualTeachingReply,
} from './visual-teaching-skill.ts'
import { executeTutorAgentTool } from './tool-runtime.ts'

const validAnimation = JSON.stringify({
  topic: '快速排序分区',
  learning_goal: '理解 pivot 如何把一个区间分成左右两部分',
  modality_rationale: '指针扫描、交换和 pivot 归位构成有顺序的状态变化',
  explanation: '快速排序的一趟分区包含数组、基准值 pivot 和扫描边界。初始时 pivot 被选定，扫描过程把较小元素移到左侧、较大元素留在右侧，随后 pivot 进入最终位置。这里只演示一趟分区，不把它误说成整个数组已经排序完成。',
  objects: [
    { id: 'array', label: '数组区间', role: '当前待分区的数据' },
    { id: 'pivot', label: '基准值', role: '划分左右区域的参照' },
    { id: 'scan', label: '扫描指针', role: '逐项检查元素' },
  ],
  relations: [
    { from: 'scan', to: 'array', label: '逐项检查' },
    { from: 'pivot', to: 'array', label: '划分区间' },
  ],
  initial_state: 'pivot 已选定，扫描尚未开始',
  steps: [
    { id: 'scan_items', title: '扫描元素', before: '左右区域尚未确定', change: '逐项与 pivot 比较并交换', after: '较小元素集中到左侧', why: '建立分区不变量' },
    { id: 'place_pivot', title: '基准归位', before: 'pivot 仍在临时位置', change: '把 pivot 与边界元素交换', after: 'pivot 位于最终排序位置', why: '左侧不大于 pivot，右侧不小于 pivot' },
  ],
  final_state: 'pivot 归位，左右子区间仍需递归排序',
  invariants: ['已扫描区域始终满足分区条件'],
  misconceptions: ['一次分区不等于完成全部排序'],
  claim_boundary: '只表达一趟分区，不声称具体实现一定使用双指针',
})

test('visual teaching brief requires real objects and two animation changes', () => {
  const brief = parseVisualTeachingBrief(validAnimation, 'animation', '用动画演示快速排序分区')
  assert.equal(brief.objects.length, 3)
  assert.equal(brief.steps.length, 2)
  assert.equal(brief.modality, 'animation')

  const invalid = JSON.parse(validAnimation)
  invalid.steps = invalid.steps.slice(0, 1)
  assert.throws(
    () => parseVisualTeachingBrief(JSON.stringify(invalid), 'animation', '用动画演示快速排序'),
    /animation_changes_insufficient/,
  )
})

test('independent explanation is valid before any brief exists', () => {
  const explanation = validateVisualTeachingExplanation(JSON.parse(validAnimation).explanation)
  const bundle = explanationOnlyVisualTeachingBundle(explanation, 'animation', new Error('brief invalid'))
  assert.equal(bundle.visualBrief, undefined)
  assert.equal(bundle.explanation, explanation)
  assert.equal(bundle.terminalState, 'explanation_only')
})

test('visual failure has a legal explanation-only terminal with unchanged prose', () => {
  const brief = parseVisualTeachingBrief(validAnimation, 'animation', '用动画演示快速排序分区')
  const bundle = completeVisualTeachingBundle(brief, {
    id: 'failed', kind: 'animation', status: 'failed', title: '生成过程动画',
    detail: 'visual timeout', durationMs: 10, toolName: 'generate_learning_animation',
  })
  assert.equal(bundle.terminalState, 'explanation_only')
  assert.equal(bundle.explanation, brief.explanation)
  assert.equal(bundle.explanationPreserved, true)
  assert.match(visualTeachingReply(bundle), new RegExp(`^${brief.explanation}`))
})

test('raw visual tools reject calls that bypass the visual teaching skill', async () => {
  const result = await executeTutorAgentTool('generate_learning_animation', {
    query: '用动画演示快速排序分区',
  }, {
    message: '用动画演示快速排序分区',
    recentMessages: [{ role: 'user', content: '用动画演示快速排序分区' }],
    generate: async () => { throw new Error('renderer must not run without a brief') },
  })
  assert.equal(result.run.status, 'failed')
  assert.match(result.run.detail, /visual_teaching_composition.*VisualBrief/)
  assert.equal(result.run.artifact, undefined)
})
