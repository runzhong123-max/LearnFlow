import assert from 'node:assert/strict'
import test from 'node:test'
import { compactProjectWorkflow } from './workflow-context.ts'

test('one current stage retains responsibility and live help metadata without leaking future content', () => {
  const active = { checkpoint_id: 10, title: '当前', status: 'available', student_tasks: ['STUDENT_TASK'], mentor_support: ['MENTOR_SUPPORT'], shared_tasks: ['SHARED_TASK'],
    assistance: { mode: 'pseudocode', revision: 7, execution_mode: 'read_only' }, related_files: [{ path: 'importer.c', role: 'implementation', reason: '当前实现', content: 'PRIVATE_CODE' }],
    materials: [{ title: '输入', body: 'VISIBLE_INPUT' }] }
  const context = { checkpoint_id: 10, project_workflow: { project_mode: 'practice', workbench: { body: 'PRIVATE_PAPER' }, evaluator: 'PRIVATE_EVALUATOR', milestones: [
    active, { ...active, checkpoint_id: 11, status: 'locked', student_tasks: ['FUTURE_TASK'], mentor_support: ['FUTURE_MENTOR'],
      related_files: [{ path: 'future.csv', reason: 'FUTURE_REASON' }], materials: [{ title: '后续', body: 'FUTURE_INPUT' }] },
  ] } }
  const result = compactProjectWorkflow(context)!
  assert.deepEqual(result.milestones[0].assistance, active.assistance)
  assert.deepEqual(result.milestones[1].student_tasks, [])
  assert.equal(result.milestones[1].assistance, null)
  assert.match(JSON.stringify(result), /STUDENT_TASK.*MENTOR_SUPPORT.*SHARED_TASK/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|FUTURE_|future\.csv/)
  assert.match(result.milestones[0].help_boundary, /只读分析/)
})

test('global project selects one available stage and omits previous stage support', () => {
  const result = compactProjectWorkflow({ project_workflow: { milestones: [
    { checkpoint_id: 1, status: 'accepted', student_tasks: ['OLD_TASK'] },
    { checkpoint_id: 2, status: 'available', student_tasks: ['CURRENT_TASK'], assistance: { mode: 'implementation', revision: 11, execution_mode: 'workspace_write' } },
  ] } })!
  assert.doesNotMatch(JSON.stringify(result), /OLD_TASK/)
  assert.match(JSON.stringify(result), /CURRENT_TASK/)
  assert.match(result.milestones[1].help_boundary, /确认运行和确认写回/)
})

test('projection bounds paths and text and does not trust inconsistent write mode', () => {
  const result = compactProjectWorkflow({ checkpoint_id: 1, project_workflow: { milestones: [{
    checkpoint_id: 1, status: 'available', student_tasks: Array(20).fill('字'.repeat(1000)),
    assistance: { mode: 'steps', revision: 1, execution_mode: 'workspace_write' },
    related_files: [{ path: '../private' }, { path: '/absolute' }, { path: 'src/main.c', role: 'implementation', reason: 'ok' }],
  }] } })!
  assert.equal(result.milestones[0].student_tasks.length, 6)
  assert.equal(result.milestones[0].student_tasks[0].length, 280)
  assert.equal(result.milestones[0].assistance?.execution_mode, 'read_only')
  assert.deepEqual(result.milestones[0].related_files.map(file => file.path), ['src/main.c'])
})
