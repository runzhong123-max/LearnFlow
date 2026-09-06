import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeLearningPlanProjection,
  closeLearningPlan,
  createLearningPlan,
  decideValueClaimProposal,
  extractPlanningProfileSelfReport,
  hasPlanningIntent,
  learningPlanTutorContext,
  projectLearningPlan,
  sanitizeLearningPlanTutorContext,
  updateLearningPlan,
} from '../src/planning.ts'

test('large learning and future direction goals enter planning while atomic goals do not', () => {
  assert.equal(hasPlanningIntent('我想用三个月系统学习智能体，并做一个能用的项目'), true)
  assert.equal(hasPlanningIntent('我未来应该走智能体工程还是机器学习科研方向'), true)
  assert.equal(hasPlanningIntent('我想成为大模型应用工程师'), true)
  assert.equal(hasPlanningIntent('带我弄懂 Python 闭包'), false)
  assert.equal(hasPlanningIntent('什么是决策树'), false)
})

test('project planning builds an inspectable seed without pretending to create a project', () => {
  const created = createLearningPlan('我想用三个月系统学习智能体，最后做一个可以演示的 Agent 项目', 100)
  const projection = projectLearningPlan(created.plan, created.events)
  const context = learningPlanTutorContext(projection)

  assert.equal(created.plan.kind, 'project_seed')
  assert.equal(projection.status, 'active')
  assert.equal(Boolean(projection.signals.target_artifact), true)
  assert.equal(Boolean(projection.signals.time_commitment), true)
  assert.equal(context.projectCreationAvailable, false)
  assert.equal(context.valueProposal, undefined)
})

test('direction planning proposes a value claim and requires an explicit learner decision', () => {
  const created = createLearningPlan('我未来想从事智能体工程，也保留机器学习科研方向，你建议我怎么规划', 100)
  const before = projectLearningPlan(created.plan, created.events)
  assert.equal(created.plan.kind, 'direction')
  assert.equal(before.valueProposal?.decision, 'proposed')
  assert.equal(before.valueProposal?.proposedClaim, '当前方向候选：智能体工程。')

  const acceptedEvents = decideValueClaimProposal(created.events, before, 'accepted', 200)
  const accepted = projectLearningPlan(created.plan, acceptedEvents)
  const context = learningPlanTutorContext(accepted)
  assert.equal(accepted.valueProposal?.decision, 'accepted')
  assert.equal(context.valueProposal?.formalWriteCompleted, false)
  assert.match(acceptedEvents.at(-1)?.detail || '', /正式后端不可用/)
})

test('planning self report is split into typed evidence instead of one raw task string', () => {
  const report = extractPlanningProfileSelfReport(
    '我是大二在校生，每周能投入15-20小时。学过机器学习和深度学习，用过PyTorch写简单训练脚本；没写过生产级代码，只写过简单Flask接口，RAG和Agent没实际动手。',
    '成为大模型应用工程师',
  )
  assert.equal(report?.educationStage, '大二')
  assert.deepEqual(report?.weeklyHours, { min: 15, max: 20 })
  assert.equal(report?.goalCandidate, '成为大模型应用工程师')
  assert.ok(report?.knowledgeExposures.some(item => item.subject === '机器学习与深度学习'))
  assert.ok(report?.knowledgeGaps.some(item => item.subject === '生产级软件工程'))
  assert.ok(report?.practiceExposures.some(item => item.subject === 'Flask 接口'))
})

test('a continuation-only planning reply does not create a fake self report', () => {
  assert.equal(extractPlanningProfileSelfReport('然后呢', '成为大模型应用工程师'), undefined)
})

test('negation, attributed and hypothetical backgrounds cannot become positive self reports', () => {
  for (const input of [
    '我没用过 PyTorch，也没有写过 Flask 接口',
    '我朋友大三，写过 Flask 接口',
    '假设我大三，学过 Python，每周能学10小时',
    '这是产品测试，我大三，用过PyTorch',
    '老师说“我是研究生，用过PyTorch”',
    '我不是研究生，每周不能投入10小时',
    '我想学PyTorch训练脚本',
    '我熟悉Java吗？', '我用过PyTorch？', '我不是没写过生产级代码',
  ]) assert.equal(extractPlanningProfileSelfReport(input, '成为工程师'), undefined, input)
  const report = extractPlanningProfileSelfReport('我没用过PyTorch，但写过Flask接口')
  assert.equal(report?.knowledgeExposures.some(item => item.subject === 'PyTorch'), false)
  assert.ok(report?.practiceExposures.some(item => item.subject === 'Flask 接口'))
})

test('self reports never emit facts beyond the retained evidence quote', () => {
  const report = extractPlanningProfileSelfReport(`${'背景。'.repeat(800)}我熟悉Java。`)
  assert.equal(report, undefined)
})

test('generic learning and practice backgrounds retain exact supporting clauses', () => {
  const report = extractPlanningProfileSelfReport('我熟悉 Java、Spring 和 SQL，做过三年后端开发，学过线性代数。')
  assert.ok(report?.knowledgeExposures.some(item => item.statement === '我熟悉 Java、Spring 和 SQL'))
  assert.ok(report?.knowledgeExposures.some(item => item.statement === '学过线性代数'))
  assert.ok(report?.practiceExposures.some(item => item.statement === '做过三年后端开发'))
  for (const item of [...report!.knowledgeExposures, ...report!.practiceExposures]) {
    assert.ok(report!.evidenceQuote.includes(item.statement))
  }
})

test('negated and third-party directions cannot create value proposals', () => {
  for (const input of ['我不想成为大模型工程师', '我朋友想成为工程师', '假设我想成为工程师']) {
    const created = createLearningPlan(input)
    assert.equal(projectLearningPlan(created.plan, created.events).valueProposal, undefined, input)
  }
})

test('planning updates and closes only through its local event queue', () => {
  const created = createLearningPlan('我想系统学习强化学习并做项目', 100)
  const first = projectLearningPlan(created.plan, created.events)
  const updatedEvents = updateLearningPlan(created.events, first, '我学过概率论和机器学习，每周可以投入 8 小时，用教材和论文学习，最后用实验指标验收。', 200)
  const updated = projectLearningPlan(created.plan, updatedEvents)
  assert.equal(Boolean(updated.signals.baseline), true)
  assert.equal(Boolean(updated.signals.resources), true)
  assert.equal(Boolean(updated.signals.time_commitment), true)
  assert.equal(Boolean(updated.signals.practice_validation), true)

  const closedEvents = closeLearningPlan(updatedEvents, updated, 300)
  assert.equal(projectLearningPlan(created.plan, closedEvents).status, 'closed')
  assert.equal(activeLearningPlanProjection([created.plan], closedEvents), undefined)
})

test('direction readiness uses its own milestone instead of a project event', () => {
  const created = createLearningPlan('我未来想从事智能体工程，也保留机器学习科研方向', 100)
  const first = projectLearningPlan(created.plan, created.events)
  const events = updateLearningPlan(
    created.events,
    first,
    '我现在是计算机专业大二，计划明年根据项目和科研体验决定，最看重兴趣与成长。',
    200,
  )
  assert.equal(events.some(event => event.type === 'vnext_direction_plan_ready'), true)
  assert.equal(events.some(event => event.type === 'vnext_project_seed_ready'), false)
})

test('planning context sanitizer keeps bounded proposals and preserves explicit formal-write state', () => {
  const created = createLearningPlan('我以后希望从事智能体工程', 100)
  const context = learningPlanTutorContext(projectLearningPlan(created.plan, created.events))
  const sanitized = sanitizeLearningPlanTutorContext({
    ...context,
    valueProposal: { ...context.valueProposal, formalWriteCompleted: true },
  })
  assert.equal(sanitized?.valueProposal?.formalWriteCompleted, true)
})
