import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCheckpointPreset } from './checkpoint-presets.ts'
import { compactProjectWorkflow } from './workflow-context.ts'
import { prepareProjectGuidance } from './runtime.ts'
const implementation = { kind: 'implementation', lecture_focus: '从输入到解析树', practice_focus: '', workflow_step: '', required_files: [{ path: 'src/parser.c', purpose: '解析输入并暴露明确接口' }] }
test('file design preserves exact paths and refuses unsafe, duplicate and empty implementation plans', () => {
  assert.deepEqual(parseCheckpointPreset(implementation), implementation)
  for (const path of ['../parser.c', 'a//b.c', 'a\\b.c', '.env', '.git/config', '/tmp/a.c']) {
    assert.throws(() => parseCheckpointPreset({ ...implementation, required_files: [{ path, purpose: '完成文件' }] }))
  }
  assert.throws(() => parseCheckpointPreset({ ...implementation, required_files: [] }))
  assert.throws(() => parseCheckpointPreset({ ...implementation, required_files: [...implementation.required_files, ...implementation.required_files] }))
  assert.throws(() => parseCheckpointPreset({ ...implementation, kind: 'overview' }))
})
test('checkpoint Tutor receives only its own released preset and no future file assignments', () => {
  const view = compactProjectWorkflow({ checkpoint_id: 10, project_workflow: { project_mode: 'experiment', milestones: [
    { checkpoint_id: 10, status: 'available', entry_preset: implementation },
    { checkpoint_id: 11, status: 'locked', entry_preset: { ...implementation, required_files: [{ path: 'secret-stage.c', purpose: '未来关卡' }] } },
  ] } })!
  assert.equal(view.milestones[0].entry_preset?.required_files[0].path, 'src/parser.c')
  assert.equal(view.milestones[1].entry_preset, null)
  assert.equal(JSON.stringify(view).includes('secret-stage.c'), false)
})
test('new experiment preparation requests a concrete implementation route before creating a candidate', async () => {
  const result = await prepareProjectGuidance({ rawInput: '实现解析器', projectMode: 'experiment', name: '实现解析器', objective: '交付解析器', deliverables: ['解析器'], successCriteria: ['正确处理输入'] }, { scope: {} })
  assert.equal((result.payload as any).status, 'needs_input')
  assert.match((result.payload as any).missing_fields.join(''), /实现路线/)
})
