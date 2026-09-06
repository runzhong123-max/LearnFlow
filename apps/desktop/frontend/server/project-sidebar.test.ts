import assert from 'node:assert/strict'
import test from 'node:test'

import { projectSidebarChats } from '../src/project-sidebar.ts'
import type { FormalProjectWorkspace } from '../src/project.ts'

function workspace(): FormalProjectWorkspace {
  return {
    schema_version: 'vnext.project.v1',
    project: {
      id: 7,
      name: '迷你 GPT',
      objective: '实现一个小模型',
      expected_outcome: '可运行仓库',
      user_level: 'intermediate',
    },
    project_tutor: { session_id: 70, title: '迷你 GPT · 项目 Tutor', mode: 'learning_plan' },
    roadmap: { id: null, revision: 0, checkpoints: [] },
    sources: [],
    files: { lectures: [], practices: [] },
    free_sessions: [{ session_id: 71, title: '迷你 GPT · 自由对话' }],
    boundaries: {
      planning_requires_confirmation: true,
      source_content_is_untrusted: true,
      file_generation_is_not_mastery: true,
      checkpoint_completion_is_not_mastery: true,
    },
  }
}

test('formal project sessions remain visible without browser-local conversations', () => {
  const entries = projectSidebarChats(workspace(), [])
  assert.deepEqual(entries.map(item => [item.role, item.title]), [
    ['tutor', '迷你 GPT · 项目 Tutor'],
    ['free', '迷你 GPT · 自由对话'],
  ])
})

test('a local conversation is attached to its formal session without duplication', () => {
  const local = { id: 'chat-local', title: '迷你 GPT · 自由对话', formalSessionId: 71, projectRole: 'free' as const }
  const entries = projectSidebarChats(workspace(), [local])
  assert.equal(entries.length, 2)
  assert.equal(entries[1].conversation, local)
})
