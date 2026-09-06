import assert from 'node:assert/strict'
import test from 'node:test'

import { FIXED_VIDEO_EVAL_CATALOG, inspectLearningVideo, searchLearningVideos } from './learning-video-harness.ts'

const offline = { offlineCatalog: FIXED_VIDEO_EVAL_CATALOG }

test('offline video search returns discovered candidates and inspection requires current-turn id', async () => {
  const search = await searchLearningVideos({ target: 'Python generators', platforms: ['youtube'], maxResults: 3 }, offline)
  assert.equal(search.status, 'ok')
  assert.equal(search.candidates[0].verificationState, 'discovered')
  await assert.rejects(() => inspectLearningVideo('youtube:not-returned', search.candidates), /candidate_not_from_current_search/)
})

test('inspection returns timestamped evidence without mastery inference', async () => {
  const search = await searchLearningVideos({ target: 'Python generators', platforms: ['youtube'] }, offline)
  const inspected = await inspectLearningVideo(search.candidates[0].candidateId, search.candidates, {
    query: 'yield lazy values', outcomes: ['解释 yield 的暂停和恢复'],
  })
  assert.equal(inspected.verificationState, 'content_inspected')
  assert.ok(inspected.segments.length > 0)
  assert.match(inspected.boundary, /不形成/)
})

test('bilibili adapter preserves metadata-only state when subtitles are unavailable', async () => {
  const fakeFetch: typeof fetch = async (input: URL | RequestInfo) => {
    const url = String(input)
    if (url.includes('/search/type')) return new Response(JSON.stringify({ code: 0, data: { result: [{ bvid: 'BV123', title: '<em>Python</em> 生成器', author: 'Teacher', duration: '3:01', play: 100 }] } }), { status: 200 })
    if (url.includes('/view?')) return new Response(JSON.stringify({ code: 0, data: { cid: 9 } }), { status: 200 })
    return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), { status: 200 })
  }
  const search = await searchLearningVideos({ target: 'Python 生成器', platforms: ['bilibili'] }, { fetchImpl: fakeFetch })
  assert.equal(search.candidates[0].candidateId, 'bilibili:BV123')
  const inspected = await inspectLearningVideo(search.candidates[0].candidateId, search.candidates, {}, { fetchImpl: fakeFetch })
  assert.equal(inspected.verificationState, 'metadata_only')
  assert.equal(inspected.transcriptState, 'asr_required')
})
