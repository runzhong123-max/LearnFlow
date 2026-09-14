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

test('resource inquiry preserves selected links without committing a selection', async () => {
  const { resourceInquiryPrompt } = await import('../src/planning-resources.ts')
  const source = {title:'系统课程',url:'https://example.com/course#week1',snippet:'内存和缓存',reason:'适合系统学习'} as SearchSource
  const prompt = resourceInquiryPrompt('计算机系统',[source,{...source,url:'javascript:alert(1)'}],'需要 C 语言基础吗？')
  assert.match(prompt,/https:\/\/example.com\/course/)
  assert.match(prompt,/需要 C 语言基础吗/)
  assert.match(prompt,/尚未确认选用/)
  assert.match(prompt,/不自动入库/)
  assert.doesNotMatch(prompt,/javascript:|#week1/)
})

test('resource introductions distinguish excerpts from recommendation reasons and unknowns', async () => {
  const { resourceIntroduction } = await import('../src/planning-resources.ts')
  const intro = resourceIntroduction({snippet:'介绍缓存与虚拟内存',reason:'对应学习目标',readState:'page_excerpt'} as SearchSource)
  assert.equal(intro.summary,'介绍缓存与虚拟内存')
  assert.equal(intro.retrievalNote,'对应学习目标')
  assert.equal('reason' in intro, false, 'retrieval metadata is separate from recommendation copy')
  assert.match(intro.basis,/不代表已读全文/)
  assert.match(resourceIntroduction({} as SearchSource).summary,/尚无内容简介/)
})

test('saved source titles restore from exact persisted recommendations, with file names preserved', async () => {
  const { savedResourceTitle, resourceUrlKey } = await import('../src/planning-resources.ts')
  const known = [{title:'计算机系统课程',url:'https://example.com/course'}] as SearchSource[]
  assert.equal(savedResourceTitle({name:'https://example.com/course',url:'https://example.com/course#intro'},known),'计算机系统课程')
  assert.equal(savedResourceTitle({name:'个人笔记.pdf',url:''},known),'个人笔记.pdf')
  assert.equal(savedResourceTitle({name:'另一门课',url:'https://other.example/course'},known),'另一门课')
  assert.equal(resourceUrlKey('https://user:secret@example.com'), '')
})


test('provider boilerplate and empty reasons never become recommendation copy', async () => {
  const { resourceIntroduction } = await import('../src/planning-resources.ts')
  for (const reason of ['Tavily 返回的与查询最相关的网页证据片段', '命中 LearnFlow 计算机知识可信来源目录', '']) {
    const intro = resourceIntroduction({snippet:'课程覆盖虚拟内存与缓存',reason} as SearchSource)
    assert.equal(intro.summary,'课程覆盖虚拟内存与缓存')
    assert.equal('reason' in intro,false)
    assert.equal(intro.retrievalNote,reason)
    assert.doesNotMatch(JSON.stringify(intro),/适配情况待核验/)
  }
})
