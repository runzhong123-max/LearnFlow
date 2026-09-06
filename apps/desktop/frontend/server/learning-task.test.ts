import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeLearningTaskProjection,
  advanceLearningSkillStep,
  activateFormalLearningTask,
  appendLearningEvents,
  canAdvanceLearningSkillStep,
  createLearningTask,
  currentLearningSkillStep,
  hasExplicitLearningIntent,
  isSupportRequest,
  LEARNING_SKILLS,
  learningTaskTutorContext,
  loopLearningSkillStep,
  projectLearningTask,
  switchLearningSkill,
  type LearningSkillId,
  type LearningTask,
} from '../src/learning.ts'
import { guidedLearningRecoveryReply, isDisplayableTutorReply, resolveTutorMode } from '../src/tutor.ts'

test('internal provider tool protocols are never treated as Tutor teaching text', () => {
  assert.equal(isDisplayableTutorReply('先建立直觉：朴素贝叶斯会比较各类别的后验概率。'), true)
  assert.equal(isDisplayableTutorReply('<tool_call><function=trigger_start_learning></function></tool_call>'), false)
})

test('guided learning transport recovery keeps the current skill action usable', () => {
  const created = createLearningTask('带我学习一下集成学习', 100)
  const context = learningTaskTutorContext(projectLearningTask(created.task, created.events))
  const reply = guidedLearningRecoveryReply(context, 'stream disconnected')
  assert.match(reply, /集成学习/)
  assert.match(reply, /建立核心模型/)
  assert.match(reply, /直接说明目标解决的问题/)
  assert.doesNotMatch(reply, /请求失败|预算内没有返回/)
})

test('only an explicit atomic learning request starts guided learning automatically', () => {
  assert.equal(resolveTutorMode('free', '什么是操作系统'), 'simple_explain')
  assert.equal(resolveTutorMode('free', '什么是学习任务'), 'simple_explain')
  assert.equal(resolveTutorMode('free', '带我弄懂操作系统的进程调度'), 'guided_learning')
  assert.equal(resolveTutorMode('free', '我想用半年系统学习操作系统并做一个内核项目'), 'learning_plan')
  assert.equal(resolveTutorMode('free', '我未来适合走智能体工程还是机器学习科研方向'), 'learning_plan')
  assert.equal(hasExplicitLearningIntent('我想了解一下操作系统'), false)
  assert.equal(hasExplicitLearningIntent('带我学习操作系统'), true)
})

test('a task starts at the recommended skill own first step', () => {
  assert.equal(createLearningTask('带我学习贝叶斯公式', 99).task.objective, '贝叶斯公式')
  assert.equal(createLearningTask('带我学习一下集成学习', 99).task.objective, '集成学习')
  const created = createLearningTask('带我写一个二分查找', 100)
  const projection = projectLearningTask(created.task, created.events)
  assert.equal(created.task.objective, '写一个二分查找')
  assert.equal(projection.status, 'active')
  assert.equal(projection.skillId, 'worked_example_fading')
  assert.equal(projection.stepId, 'studying_worked_example')
  assert.equal(projection.stepIndex, 0)
  assert.equal(projection.eventCount, 4)
})

test('a formal queue task is activated as one guided-learning binding', () => {
  const first = createLearningTask('旧的学习目标', 50)
  const activated = activateFormalLearningTask({
    id: 42,
    objective: '实现上下文与模型行为控制',
    version: 3,
    preferred_skills: ['guided_explanation'],
  }, [first.task], first.events, 100)

  assert.equal(activated.task.id, 'formal-learning-task-42')
  assert.equal(activated.task.formalTaskId, 42)
  assert.equal(activated.task.formalTaskVersion, 3)
  assert.equal(activeLearningTaskProjection(activated.tasks, activated.events)?.task.formalTaskId, 42)
  assert.equal(projectLearningTask(first.task, activated.events).status, 'paused')

  const repeated = activateFormalLearningTask({
    id: 42,
    objective: '实现上下文与模型行为控制',
    version: 4,
  }, activated.tasks, activated.events, 200)
  assert.equal(repeated.tasks.filter(task => task.formalTaskId === 42).length, 1)
  assert.equal(repeated.task.formalTaskVersion, 4)
})

test('each learning skill owns a distinct deterministic flow', () => {
  const skillIds = Object.keys(LEARNING_SKILLS) as LearningSkillId[]
  const paths = skillIds.map(skillId => LEARNING_SKILLS[skillId].steps.map(step => step.id).join('>'))
  assert.equal(new Set(paths).size, skillIds.length)
  assert.equal(skillIds.every(skillId => LEARNING_SKILLS[skillId].boundState === 'guided_learning'), true)
  assert.equal(skillIds.every(skillId => LEARNING_SKILLS[skillId].steps.every(
    step => Boolean(step.substateId && step.substateLabel.endsWith('态')),
  )), true)
  assert.deepEqual(LEARNING_SKILLS.guided_explanation.steps.map(step => step.id), [
    'presenting_core_model', 'checking_minimal_example', 'repairing_explanation', 'verification_ready',
  ])
  assert.deepEqual(LEARNING_SKILLS.socratic_dialogue.steps.map(step => step.id), [
    'eliciting_prior_model', 'testing_assumption', 'building_explanation', 'verification_ready',
  ])
  assert.deepEqual(LEARNING_SKILLS.feynman_dialogue.steps.map(step => step.id), [
    'awaiting_teach_back', 'locating_gap', 'revising_explanation', 'verification_ready',
  ])
  assert.deepEqual(LEARNING_SKILLS.worked_example_fading.steps.map(step => step.id), [
    'studying_worked_example', 'completing_last_step', 'solving_faded_example', 'verification_ready',
  ])
  assert.deepEqual(LEARNING_SKILLS.learning_file_study.steps.map(step => step.id), [
    'selecting_learning_artifact', 'reading_with_anchor', 'practicing_in_file', 'verification_ready',
  ])
})

test('an explicitly selected skill binds the next guided task and exposes its substate', () => {
  const created = createLearningTask('理解朴素贝叶斯', 100, [], 'feynman_dialogue')
  const projection = projectLearningTask(created.task, created.events)
  const context = learningTaskTutorContext(projection)

  assert.equal(projection.skillId, 'feynman_dialogue')
  assert.equal(context.substateId, 'teachback')
  assert.equal(context.substateLabel, '复述态')
  assert.match(created.events.at(-1)?.detail || '', /复述态/)
})

test('step movement is queue-driven and follows the current skill', () => {
  const created = createLearningTask('理解闭包', 100)
  const before = projectLearningTask(created.task, created.events)
  const withReply = appendLearningEvents(created.events, created.task.id, [{
    type: 'vnext_learning_task_learner_replied',
    detail: '学生回应',
    skillId: before.skillId,
    stepId: before.stepId,
  }], 200)
  assert.equal(projectLearningTask(created.task, withReply).stepId, 'presenting_core_model')

  const advanced = advanceLearningSkillStep(withReply, projectLearningTask(created.task, withReply), 300)
  assert.equal(projectLearningTask(created.task, advanced).stepId, 'checking_minimal_example')
  assert.equal(learningTaskTutorContext(projectLearningTask(created.task, advanced)).substateId, 'demonstration')
})

test('support and explicit repeats loop inside the current skill step', () => {
  assert.equal(isSupportRequest('我不知道，给个提示吧'), true)
  assert.equal(isSupportRequest('我觉得事件循环先执行同步代码'), false)

  const created = createLearningTask('理解事件循环', 100)
  const before = projectLearningTask(created.task, created.events)
  const withSupport = appendLearningEvents(created.events, created.task.id, [
    { type: 'vnext_learning_support_requested', detail: '补充支架', skillId: before.skillId, stepId: before.stepId },
    { type: 'vnext_learning_skill_looped', detail: '支架后重做', skillId: before.skillId, stepId: before.stepId },
  ], 200)
  const once = projectLearningTask(created.task, withSupport)
  assert.equal(once.stepId, 'presenting_core_model')
  assert.equal(once.supportCount, 1)
  assert.equal(once.loopCount, 1)

  const twice = projectLearningTask(created.task, loopLearningSkillStep(withSupport, once, '换例子', 300))
  assert.equal(twice.stepId, 'presenting_core_model')
  assert.equal(twice.loopCount, 2)
  assert.equal(twice.totalLoopCount, 2)
})

test('switching skill resets orchestration to that skill first step', () => {
  const created = createLearningTask('理解索引', 100)
  const initial = projectLearningTask(created.task, created.events)
  const withReply = appendLearningEvents(created.events, created.task.id, [{
    type: 'vnext_learning_task_learner_replied', detail: '学生回应', skillId: initial.skillId, stepId: initial.stepId,
  }], 150)
  const guided = projectLearningTask(created.task, advanceLearningSkillStep(
    withReply, projectLearningTask(created.task, withReply), 200,
  ))
  assert.equal(guided.stepId, 'checking_minimal_example')

  const switchedEvents = switchLearningSkill(withReply, guided, 'feynman_dialogue', 300)
  const switched = projectLearningTask(created.task, switchedEvents)
  assert.equal(switched.skillId, 'feynman_dialogue')
  assert.equal(switched.stepId, 'awaiting_teach_back')
  assert.equal(switched.stepIndex, 0)
})

test('skill steps that require learner work cannot advance before a reply', () => {
  const created = createLearningTask('理解索引', 100)
  const initial = projectLearningTask(created.task, created.events)
  const switched = projectLearningTask(
    created.task,
    switchLearningSkill(created.events, initial, 'feynman_dialogue', 200),
  )
  const teachbackEvents = switchLearningSkill(created.events, initial, 'feynman_dialogue', 200)
  const awaitingReply = projectLearningTask(created.task, teachbackEvents)
  assert.equal(awaitingReply.stepId, 'awaiting_teach_back')
  assert.equal(canAdvanceLearningSkillStep(awaitingReply), false)

  const withReply = appendLearningEvents(teachbackEvents, created.task.id, [{
    type: 'vnext_learning_task_learner_replied', detail: '学生完成复述', skillId: awaitingReply.skillId, stepId: awaitingReply.stepId,
  }], 400)
  assert.equal(canAdvanceLearningSkillStep(projectLearningTask(created.task, withReply)), true)

  const looped = loopLearningSkillStep(withReply, projectLearningTask(created.task, withReply), '缩小范围', 500)
  assert.equal(canAdvanceLearningSkillStep(projectLearningTask(created.task, looped)), false)
})

test('legacy four-phase browser events migrate into the selected skill path', () => {
  const task: LearningTask = { id: 'legacy-task', objective: '理解闭包', createdAt: 100 }
  const events = appendLearningEvents([], task.id, [
    { type: 'vnext_learning_task_started', detail: '开始' },
    { type: 'vnext_learning_task_phase_entered', detail: '旧版检查', phase: 'verify' },
    { type: 'vnext_learning_skill_selected', detail: '旧版技能', skillId: 'feynman_dialogue' },
  ], 100)
  const projection = projectLearningTask(task, events)
  assert.equal(projection.skillId, 'feynman_dialogue')
  assert.equal(projection.stepId, 'revising_explanation')
})

test('the model receives a bounded read-only skill-step projection', () => {
  const created = createLearningTask('理解数据库索引', 100)
  const projection = projectLearningTask(created.task, created.events)
  const context = learningTaskTutorContext(projection)
  assert.equal(context.skillName, '清晰讲解')
  assert.equal(context.substateLabel, '引导态')
  assert.equal(context.stepTitle, '建立核心模型')
  assert.equal(context.stepCount, LEARNING_SKILLS.guided_explanation.steps.length)
  assert.match(context.stepInstruction, /直接说明/)
  assert.match(currentLearningSkillStep(projection).loopInstruction || '', /只换表征/)
})
