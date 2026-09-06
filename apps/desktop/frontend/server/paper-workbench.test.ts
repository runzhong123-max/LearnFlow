import test from 'node:test'
import assert from 'node:assert/strict'
import { deletePaperSheet, findPaperSheetByArtifact, paperAncestorChain, paperSelectionContext, sanitizePaperSheets } from '../src/paper-workbench.ts'

test('local file Tutor context identifies saved and unsaved selections without losing indentation', () => {
  const sheet = { quote: '  return value;\n', artifact: { kind: 'workspace_file' as const, path: 'src/main.c', ref: 'src/main.c', title: '选区', startLine: 4, endLine: 4 } }
  assert.match(paperSelectionContext(sheet)!, /src\/main\.c\n版本：未保存草稿\n行：4-4\n\n  return value;\n$/)
  assert.match(paperSelectionContext({ ...sheet, artifact: { ...sheet.artifact, revision: 'a'.repeat(64) } })!, /版本：a{64}/)
})

test('paper sanitizer preserves nested learning files and source papers', () => {
  const sheets = sanitizePaperSheets([
    { id: 'quote', title: '追问', quote: 'Q', sourceMessageId: 'm1', parentSheetId: 'main', messages: [], createdAt: 1 },
    { id: 'lecture', title: '讲义', quote: '', sourceMessageId: '', parentSheetId: 'quote', messages: [], createdAt: 2, artifact: { kind: 'lecture', ref: '8', title: 'L' } },
    { id: 'source', title: '资料', quote: '', sourceMessageId: '', parentSheetId: 'lecture', messages: [], createdAt: 3, artifact: { kind: 'source', ref: '13', title: 'S', projectId: 2 } },
  ])
  assert.deepEqual(paperAncestorChain(sheets, 'source').map(sheet => sheet.id), ['quote', 'lecture', 'source'])
  assert.equal(sheets[2].artifact?.kind, 'source')
})

test('paper sanitizer repairs missing parents, duplicates and cycles', () => {
  const sheets = sanitizePaperSheets([
    { id: 'a', title: 'A', parentSheetId: 'b', messages: [] },
    { id: 'b', title: 'B', parentSheetId: 'a', messages: [] },
    { id: 'orphan', title: 'O', parentSheetId: 'missing', messages: [] },
    { id: 'a', title: 'duplicate', parentSheetId: 'main', messages: [] },
  ])
  assert.equal(sheets.length, 3)
  assert.equal(sheets.find(sheet => sheet.id === 'a')?.parentSheetId, 'main')
  assert.equal(sheets.find(sheet => sheet.id === 'orphan')?.parentSheetId, 'main')
})

test('deleting a paper keeps its descendants reachable', () => {
  const sheets = sanitizePaperSheets([
    { id: 'a', title: 'A', parentSheetId: 'main', messages: [] },
    { id: 'b', title: 'B', parentSheetId: 'a', messages: [] },
    { id: 'c', title: 'C', parentSheetId: 'b', messages: [] },
  ])
  const result = deletePaperSheet(sheets, 'b')
  assert.equal(result.parentSheetId, 'a')
  assert.equal(result.sheets.find(sheet => sheet.id === 'c')?.parentSheetId, 'a')
})

test('the same learning file has one canonical paper and keeps descendants reachable', () => {
  const sheets = sanitizePaperSheets([
    { id: 'practice-old', title: '练习', parentSheetId: 'main', messages: [{ id: 'm-old' }], artifact: { kind: 'practice', ref: 'ps-1', title: 'QKV' } },
    { id: 'follow-up', title: '追问', parentSheetId: 'practice-old', messages: [] },
    { id: 'practice-current', title: '练习', parentSheetId: 'main', messages: [{ id: 'm-current' }], artifact: { kind: 'practice', ref: 'ps-1', title: 'QKV' } },
  ])
  assert.equal(sheets.length, 2)
  assert.equal(findPaperSheetByArtifact(sheets, { kind: 'practice', ref: 'ps-1', title: 'QKV' })?.id, 'practice-current')
  assert.deepEqual(findPaperSheetByArtifact(sheets, { kind: 'practice', ref: 'ps-1', title: 'QKV' })?.messages, [{ id: 'm-old' }, { id: 'm-current' }])
  assert.equal(sheets.find(sheet => sheet.id === 'follow-up')?.parentSheetId, 'practice-current')
})

test('file question papers retain exact code and distinct revisions after restore', () => {
  const quote = 'if (count == 0) {\n  return -1;\n}'
  const artifact = { kind: 'workspace_file', ref: 'src/main.c@abc:10-12', title: '边界条件', projectId: 7, path: 'src/main.c', revision: 'abc', startLine: 10, endLine: 12 }
  const sheets = sanitizePaperSheets(JSON.parse(JSON.stringify([
    { id: 'old', quote, parentSheetId: 'main', artifact, messages: [{ id: 'm1' }] },
    { id: 'new', quote: 'return count;', parentSheetId: 'main', artifact: { ...artifact, ref: 'src/main.c@def:10-12', revision: 'def' }, messages: [] },
  ])))
  assert.equal(sheets.length, 2)
  assert.equal(sheets[0].quote, quote)
  assert.deepEqual(sheets[0].artifact, artifact)
  assert.deepEqual(paperAncestorChain(sheets, 'new').map(sheet => sheet.id), ['new'])
  assert.equal(deletePaperSheet(sheets, 'old').sheets[0].artifact?.revision, 'def')
})
