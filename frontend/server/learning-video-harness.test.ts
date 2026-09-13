import assert from 'node:assert/strict'
import test from 'node:test'
import { FIXED_VIDEO_EVAL_CATALOG, inspectLearningVideo, searchLearningVideos, videoTitleQuery } from './learning-video-harness.ts'
import { executeTutorAgentTool } from './tool-runtime.ts'
const offline = {offlineCatalog: FIXED_VIDEO_EVAL_CATALOG, fetchImpl: (async()=>{throw new Error('offline must not fetch')}) as typeof fetch}

test('offline catalog returns only title matches without network or transcript',async()=>{
  const result=await searchLearningVideos({target:'Python generators'},offline)
  assert.equal(result.status,'ok')
  assert.equal(result.candidates[0].platform,'bilibili')
  assert.equal(result.candidates[0].transcriptSegments,undefined)
  const transcriptOnly={...FIXED_VIDEO_EVAL_CATALOG[0],title:'无关主题',transcriptSegments:[{startSeconds:0,endSeconds:1,text:'Python generators'}]}
  const empty=await searchLearningVideos({target:'Python generators'},{offlineCatalog:[transcriptOnly]})
  assert.equal(empty.status,'empty')
})
test('Bilibili search calls only search endpoint and ranks titles without popularity',async()=>{
  const urls:string[]=[]
  const fetchImpl=(async(input:RequestInfo|URL)=>{
    urls.push(String(input))
    return new Response(JSON.stringify({code:0,data:{result:[
      {bvid:'BV123',title:'<em>Python</em> generators',play:1,duration:'3:01'},
      {bvid:'BV456',title:'Python 入门',play:999999999,duration:'2:00'},
      {bvid:'BV789',title:'无关主题',description:'Python generators',play:999999999},
    ]}}))
  }) as typeof fetch
  const result=await searchLearningVideos({target:'Python generators',goal:'yield',language:'en',level:'beginner'},{fetchImpl})
  assert.equal(urls.length,1)
  assert.equal(new URL(urls[0]).hostname,'api.bilibili.com')
  assert.equal(new URL(urls[0]).pathname,'/x/web-interface/search/type')
  assert.equal(new URL(urls[0]).searchParams.get('keyword'),'Python generators')
  assert.deepEqual(result.candidates.map(c=>c.platformVideoId),['BV123','BV456'])
  const inspected=await inspectLearningVideo(result.candidates[0].candidateId,result.candidates,{}, {fetchImpl})
  assert.equal(inspected.verificationState,'metadata_only')
  assert.deepEqual(inspected.segments,[])
  assert.equal(urls.length,1)
  await assert.rejects(()=>inspectLearningVideo('bilibili:missing',result.candidates),/candidate_not_from_current_search/)
})
test('empty search and provider failure stay distinct',async()=>{
  const empty=await searchLearningVideos({target:'二分查找'},{fetchImpl:(async()=>new Response(JSON.stringify({code:0,data:{result:[]}}))) as typeof fetch})
  assert.equal(empty.status,'empty')
  const failure=await searchLearningVideos({target:'二分查找'},{fetchImpl:(async()=>new Response('',{status:412})) as typeof fetch})
  assert.equal(failure.status,'failed')
  assert.deepEqual(failure.candidates,[])
})
test('video follow-up carries prior subject into title search',()=>{
  assert.equal(videoTitleQuery('给我一个视频',[{role:'user',content:'什么是二叉搜索'},{role:'assistant',content:'这是二分查找。'},{role:'user',content:'给我一个视频'}]),'二叉搜索')
  assert.equal(videoTitleQuery('Python generators'),'Python generators')
})
test('tool treats successful zero matches as completed, not a hidden failure',async()=>{
  const result=await executeTutorAgentTool('search_learning_videos',{target:'二分查找'},{searchConfiguration:{offlineCatalog:[]}} as any,{callId:'empty',sequence:1})
  assert.equal(result.run.status,'completed')
  assert.deepEqual(result.videoCandidates,[])
})

test('video provider failure still returns a transparent final reply without hidden_tool_failure',async()=>{
  const {runTutorAgentTurn}=await import('./agent-runtime.ts')
  const offeredTools:string[]=[]
  const result=await runTutorAgentTurn({
    baseUrl:'http://127.0.0.1:11434/v1',model:'offline-test',mode:'free',generate:async()=>{throw new Error('unexpected generation')},
    toolChoice:'search',messages:[{role:'user',content:'什么是二分查找'},{role:'assistant',content:'有序数组上逐步减半查找。'},{role:'user',content:'给我一个视频'}],
    searchConfiguration:{fetchImpl:(async()=>new Response('',{status:412})) as typeof fetch},
    invokeProvider:async request=>{offeredTools.push(JSON.stringify(request.body.tools || []));throw new Error('temporary provider unavailable')},
  })
  assert.ok(offeredTools.length>0)
  assert.doesNotMatch(offeredTools.join(' '),/inspect_learning_video/)
  assert.ok(result.toolRuns.some(run=>run.toolName==='search_learning_videos'&&run.status==='failed'))
  assert.match(result.reply,/失败|暂时|无法|未能/)
  assert.doesNotMatch(result.reply,/hidden_tool_failure/)
})
