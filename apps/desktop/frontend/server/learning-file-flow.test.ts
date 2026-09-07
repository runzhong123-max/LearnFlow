import assert from 'node:assert/strict'
import test from 'node:test'
import { taskLearningFiles, fileKindForStage } from '../src/learning-file-flow.ts'
import { PRIMARY_LEARNING_SKILL_IDS, LEARNING_SKILLS, createLearningTask, projectLearningTask, bindFormalSkillRun, restoreFormalSkillRunBinding } from '../src/learning.ts'

test('three maintained entries preserve resumable legacy methods', () => {
  assert.deepEqual(PRIMARY_LEARNING_SKILL_IDS, ['guided_explanation', 'feynman_dialogue', 'learning_file_study'])
  for (const id of ['socratic_dialogue', 'worked_example_fading'] as const) {
    assert.equal(LEARNING_SKILLS[id].entryPolicy, 'legacy')
    const created = createLearningTask('旧任务', 1, [], id)
    assert.equal(projectLearningTask(created.task, created.events).skillId, id)
  }
})

test('global task files use exact persisted refs without requiring a project binding', () => {
  const task = { artifact_refs: [{ type: 'managed_lecture', id: 3, logical_filename: '链接.lflecture' }, { type: 'concept_question_set', kind: 'practice', ref: 'practice-set-8', checkpoint_id: 9 }, { kind: 'source', ref: 9 }] }
  assert.deepEqual(taskLearningFiles(task).map(file => [file.kind, file.ref]), [['lecture', '3'], ['practice', 'practice-set-8']])
  assert.equal(fileKindForStage('reading_with_anchor'), 'lecture')
  assert.equal(fileKindForStage('practicing_in_file'), 'practice')
  assert.deepEqual(taskLearningFiles(), [])
})

test('support exit is projected from the formal run, without completing the task', () => {
  const { task } = createLearningTask('链接', 1)
  const binding = bindFormalSkillRun(task, { id: 1, version: 4, status: 'active', state: 'presenting_core_model', support_exit: { status: 'required' } })
  assert.equal(binding.formalSkillSupportExit, true)
  assert.equal(binding.formalSkillStatus, 'active')
})


test('verification handoff remains resumable and formal completion wins over stale local events', () => {
  const created = createLearningTask('程序链接', 1, [], 'learning_file_study')
  const run = { id: 7, version: 2, status: 'verification', state: 'verification_in_progress', micro_learning_run: { id: 12 } }
  const binding = bindFormalSkillRun(created.task, run)
  assert.equal(binding.formalVerificationRunId, 12)
  const paused = [...created.events, { id: 'stale-pause', taskId: binding.id, sequence: 999, type: 'vnext_learning_task_paused' as const, detail: '旧页面暂停', at: 1 }]
  assert.equal(projectLearningTask(binding, paused).status, 'active')
  const completed = bindFormalSkillRun(binding, { ...run, status: 'completed', state: 'completed', version: 3 })
  assert.equal(projectLearningTask(completed, paused).status, 'completed')
})


test('a conversation restored without browser cache recovers its formal verification and method', () => {
  const restored = restoreFormalSkillRunBinding([], [], {
    id: 3, version: 8, status: 'verification', state: 'verification_in_progress',
    goal: '程序链接', skill: { id: 'learning_file_study' },
    learning_task: { id: 7, version: 2 }, micro_learning_run: { id: 11 }, step_index: 4,
  }, 100)
  assert.ok(restored)
  assert.equal(restored.tasks.length, 1)
  assert.equal(restored.projection.skillId, 'learning_file_study')
  assert.equal(restored.projection.task.formalVerificationRunId, 11)
  assert.equal(restored.projection.status, 'active')
  assert.equal(restored.projection.task.formalTaskId, 7)
  const again = restoreFormalSkillRunBinding(restored.tasks, restored.events, {
    id: 3, version: 8, status: 'verification', state: 'verification_in_progress',
    goal: '程序链接', skill: { id: 'learning_file_study' },
    learning_task: { id: 7, version: 2 }, micro_learning_run: { id: 11 }, step_index: 4,
  }, 200)
  assert.equal(again?.tasks.length, 1)
  assert.equal(again?.events.length, restored.events.length)
})
