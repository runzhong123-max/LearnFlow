import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWorkspaceRefresh } from '../src/workspace-refresh.ts'

test('applying agent changes preserves edits entered while disk refresh was pending', () => {
  const file = { path: 'a.ts', content: 'before', sha256: 'old', draft: 'new user edit' }
  const [merged] = mergeWorkspaceRefresh([file], [{ path: 'a.ts', content: 'agent change', sha256: 'new' }])
  assert.equal(merged.draft, 'new user edit')
  assert.equal(merged.sha256, 'old')
  assert.equal(merged.conflict, true)
})

test('clean buffers refresh, deleted files and new buffers remain recoverable', () => {
  const make = (path: string) => ({ path, content: 'before', sha256: 'old', draft: 'before' })
  const merged = mergeWorkspaceRefresh([make('a'), { ...make('deleted'), draft: 'save me' }, make('opened-during-refresh')], [{ path: 'a', content: 'after', sha256: 'new' }])
  assert.equal(merged[0].draft, 'after')
  assert.equal(merged[1].draft, 'save me')
  assert.equal(merged[1].conflict, true)
  assert.equal(merged[2].path, 'opened-during-refresh')
})
