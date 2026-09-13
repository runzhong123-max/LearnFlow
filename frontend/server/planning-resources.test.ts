import test from 'node:test'
import assert from 'node:assert/strict'
import { resourceCandidates, planningResourcePrompt, planningSourceType, planningResourceRuns } from '../src/planning-resources.ts'
import { systemPrompt } from '../src/tutor.ts'
import type { TutorToolRun, SearchSource } from '../src/tooling.ts'

test('only completed search results become selectable safe deduplicated candidates', () => {
  const source = (url: string): SearchSource => ({url, title:'Book', snippet:'Chapter', source:'Search', quality:'academic', role:'textbook', reason:'Intro'})
  const run = (status: 'completed' | 'failed', urls: string[]) => ({id:status, kind:'search', title:'search', detail:'', durationMs:1, status, sources:urls.map(source)}) as TutorToolRun
  const candidates = resourceCandidates([run('failed',['https://bad.example']),run('completed',['javascript:alert(1)','https://name:password@example.com','https://example.com/book#chapter','https://example.com/book'])])
  assert.deepEqual(candidates.map(c=>c.url),['https://example.com/book'])
})
test('project and ordinary planning have distinct responsibilities and retain confirmation', () => {
  assert.match(planningResourcePrompt('云存储',true,'sources'),/先推荐.*开放教材/)
  assert.match(planningResourcePrompt('云存储',true,'roadmap'),/不创建重复项目/)
  assert.match(planningResourcePrompt('云存储',false,'roadmap'),/不自动创建项目或关卡/)
  assert.match(planningResourcePrompt('云存储',false,'schedule'),/每周可用时间/)
  assert.match(planningResourcePrompt('云存储',true,'schedule'),/正式保存.*确认/)
  assert.doesNotMatch(systemPrompt('learning_plan'),/当前项目功能尚未接入/)
  assert.match(systemPrompt('learning_plan'),/学习型项目先推荐与选择资料/)
})

test('repository roots use repository ingestion while chapters remain web sources', () => {
  assert.equal(planningSourceType('https://github.com/org/book'), 'github')
  assert.equal(planningSourceType('https://github.com/org/book/blob/main/chapter.md'), 'url')
  assert.equal(planningSourceType('https://github.com.evil.example/org/book'), 'url')
})

test('inline resource tools belong to one planning response and retain failed searches for retry', () => {
  const search = { id: 'search-one', kind: 'search', toolName: 'search_computer_knowledge', status: 'completed', sources: [
    { url: 'https://example.com/book-one', title: 'Book one' },
  ] } as TutorToolRun
  const failed = { ...search, id: 'search-two', status: 'failed', sources: [] } as TutorToolRun
  const memory = { ...search, id: 'memory', kind: 'memory' } as TutorToolRun
  const video = { ...failed, id: 'video', toolName: 'search_learning_videos' } as TutorToolRun
  assert.deepEqual(planningResourceRuns([search, memory, video], 'learning_plan'), [search])
  assert.deepEqual(planningResourceRuns([failed], 'learning_plan'), [failed])
  assert.deepEqual(resourceCandidates(planningResourceRuns([failed], 'learning_plan')), [])
  assert.deepEqual(planningResourceRuns([search], 'simple_explanation'), [])
  assert.match(planningResourcePrompt('C++', false, 'sources'), /对话内的推荐工具结果/)
})
