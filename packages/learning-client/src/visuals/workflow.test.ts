import assert from 'node:assert/strict'
import test from 'node:test'
import {createVisualWork,resumeVisualWork,cancelVisualWork,parseVisualWorkflowCandidate,directVisualWorkflowCall,type VisualWorkflowContext} from './workflow.ts'
import {OFFLINE_VISUAL_CATALOG} from './authoring.ts'
import {createEducationalVisualsPlugin} from './plugin-package.ts'
import * as webAPI from '../../../../frontend/src/plugin-api.ts'

const story={story_version:'1',title:'自定义消息传递',goal:'观察消息先后',nodes:[{id:'sender',label:'发送端'},{id:'receiver',label:'接收端'}],edges:[{id:'message',from:'sender',to:'receiver',label:'消息'}],steps:[{title:'发送',note:'消息从发送端开始',active_nodes:['sender'],active_edges:[]},{title:'接收',note:'沿连接到达接收端',active_nodes:['receiver'],active_edges:['message']}]}
const fresh={source_mode:'fresh',builder:'svg_story',source:story}
const maintained={spec_version:'0.2.0',title:story.title,data:{stages:story.steps},model:{id:'structure.sequence',version:'1.0.0'}}
const template={id:'maintained.message',version:'1.0.0',title:story.title,description:'消息关系',tags:['消息'],kind:'animation'}
function harness(responses:unknown[],options:{templates?:boolean;publishErrors?:string[];resumeRaw?:boolean}={}){
  let job:any;let generation=0,publishCount=0
  const calls:Array<{operation:string,payload:any}>=[],prompts:string[]=[]
  const context:VisualWorkflowContext={signal:new AbortController().signal,scope:{mode:'free',learnerId:9,conversationId:'synthetic-test'},artifactHost:{context:'这是合成图解请求。',generate:async prompt=>{prompts.push(prompt);const next=responses[generation++];if(next instanceof Error)throw next;return typeof next==='string'?next:JSON.stringify(next)},request:async(operation,payload={})=>{
    calls.push({operation,payload:structuredClone(payload)})
    if(operation==='start_job')return job ||= {...payload,job_id:'job-golden',version:1,status:'running',stage:'start'}
    if(operation==='get_job')return structuredClone(job)
    if(operation==='cancel_job'){assert.deepEqual(Object.keys(payload),['job_id']);job={...job,status:'cancelled',stage:'cancelled',version:job.version+1};return structuredClone(job)}
    if(operation==='checkpoint'){
      assert.equal(payload.expected_version,job.version)
      assert.ok(JSON.stringify(payload.route||{}).length<32_000,'route remains thin metadata')
      assert.ok(JSON.stringify(payload.candidate||{}).length<150_000,'candidate bounded')
      job={...job,...structuredClone(payload),version:job.version+1};delete job.expected_version;return structuredClone(job)
    }
    if(operation==='catalog')return {...OFFLINE_VISUAL_CATALOG,templates:options.templates&&payload.templates!==false?[template]:[]}
    if(operation==='search')return {items:[]}
    if(operation==='template')return {...template,builder:'visual_spec',source:maintained}
    if(operation==='publish'){
      assert.equal(payload.expected_version,job.version)
      const error=options.publishErrors?.[publishCount++];if(error)throw new Error(error)
      const artifact={artifact_id:'artifact-golden',revision_id:'revision-golden',run_id:'run-golden',builder:payload.builder,title:(payload.source as any).title,kind:job.kind,verification:{status:'illustrative',scope:'structure'},source_mode:job.route.source_mode,...(payload.parent_revision_id?{parent_revision_id:payload.parent_revision_id}:{})}
      job={...job,artifact,status:'ready',version:job.version+1};return artifact
    }
    throw new Error('Unexpected operation '+operation)
  }}}
  return {context,calls,prompts,get generations(){return generation},get job(){return job},setRawCandidate(raw:string){job.candidate={raw,parsed:false};job.status='paused'}}
}

test('golden routing: maintained exact reuse and fresh request both reach persisted references',async()=>{
  const reused=harness([{source_mode:'reuse',source_ref:{kind:'template',id:template.id,version:template.version},builder:'visual_spec'}],{templates:true})
  const reuse=await createVisualWork({request:'演示消息传递',kind:'animation',request_id:'reuse-golden'},reused.context)
  assert.equal(reuse.status,'ready');assert.equal(reuse.artifact?.source_mode,'reuse');assert.equal(reused.generations,1)
  assert.deepEqual(reused.calls.find(c=>c.operation==='publish')?.payload.source,maintained)
  assert.equal(reused.job.route.source,undefined,'source is not stored in 32KB route')
  const generated=harness([fresh],{templates:true})
  const result=await createVisualWork({request:'从零制作我的发送端到接收端动画，不要模板',kind:'animation',request_id:'fresh-golden'},generated.context)
  assert.equal(result.status,'ready');assert.equal(result.artifact?.source_mode,'fresh')
  assert.equal(generated.calls.some(c=>c.operation==='search'||c.operation==='template'),false)
  assert.equal(generated.calls.find(c=>c.operation==='catalog')?.payload.templates,false)
  const miss=harness([fresh])
  assert.equal((await createVisualWork({request:'自定义消息结构',kind:'diagram',request_id:'miss-golden'},miss.context)).status,'ready')
})

test('golden resume: persisted valid source and unparsed response skip repeated retrieval or generation',async()=>{
  const fixture=harness([fresh],{publishErrors:['network timeout']})
  const paused=await createVisualWork({request:'从零演示消息',kind:'animation',request_id:'resume-golden'},fixture.context)
  assert.equal(paused.status,'paused');assert.ok(fixture.job.candidate.source)
  const before=fixture.calls.filter(c=>['catalog','search','template'].includes(c.operation)).length
  const resumed=await resumeVisualWork(paused.job_id!,fixture.context)
  assert.equal(resumed.status,'ready');assert.equal(fixture.generations,1)
  assert.equal(fixture.calls.filter(c=>['catalog','search','template'].includes(c.operation)).length,before)
  const pending=harness([fresh],{publishErrors:['network timeout']})
  const pendingJob=await createVisualWork({request:'从零演示消息',kind:'animation',request_id:'raw-golden'},pending.context)
  pending.setRawCandidate(JSON.stringify(fresh))
  assert.equal((await resumeVisualWork(pendingJob.job_id!,pending.context)).status,'ready')
  assert.equal(pending.generations,1)
})

test('golden repair: exact errors, explicit compatible SVG fallback, and numeric failures stay blocked',async()=>{
  const spec={spec_version:'0.2.0',title:'消息结构'}
  const initial={source_mode:'fresh',builder:'visual_spec',source:spec}
  const fallback={...fresh,fallback:{from:'visual_spec',to:'svg_story',kind:'animation',scope:'illustrative_structure',reason:'表达目标是消息关系，无需计算'}}
  const fixed=harness([initial,fallback],{publishErrors:['visual_spec_schema_invalid /views/0/primitives/0 [required]']})
  assert.equal((await createVisualWork({request:'从零描述消息过程',kind:'animation',request_id:'repair-golden'},fixed.context)).status,'ready')
  assert.ok(fixed.prompts[1].includes('/views/0/primitives/0'))
  assert.equal(fixed.generations,2)
  const blocked=harness([initial,fresh],{publishErrors:['numeric_oracle_failed /frames/2/result']})
  assert.equal((await createVisualWork({request:'从零计算自定义矩阵',kind:'animation',request_id:'numeric-golden'},blocked.context)).status,'paused')
  assert.equal(blocked.generations,2);assert.equal(blocked.job.diagnostics[0].code,'verification_blocked')
  assert.ok(blocked.prompts[1].includes('禁止换成SVGStory'))
  const implicit=harness([initial,fresh],{publishErrors:['schema_invalid /views']})
  assert.equal((await createVisualWork({request:'从零描述消息过程',kind:'animation',request_id:'implicit-golden'},implicit.context)).status,'paused')
  assert.ok(implicit.job.diagnostics[0].detail.includes('visual_builder_switch_requires_explicit_plan'))
})

test('plugin contract and local JSON repair keep data and explicit control routing intact',async()=>{
  const plugin=createEducationalVisualsPlugin(webAPI)
  assert.equal(plugin.manifest.defaultEnabled,false)
  assert.deepEqual(plugin.manifest.tools.map(t=>t.id),['create','search','open','iterate','resume','cancel'])
  assert.deepEqual(parseVisualWorkflowCandidate('{"label":"literal, }", "steps":[1,2,],}'),{label:'literal, }',steps:[1,2]})
  assert.equal(directVisualWorkflowCall({message:'继续图解任务 job_id=job-123',kind:'none',requestId:'test'})?.name,'educational_visuals__resume')
  assert.equal(directVisualWorkflowCall({message:'修改作品 revision_id=revision-123\n增加接收端',kind:'animation',requestId:'test'})?.name,'educational_visuals__iterate')
  assert.equal(directVisualWorkflowCall({message:'解释什么是动画',kind:'none',requestId:'test'}),undefined)
  assert.equal(directVisualWorkflowCall({message:'打开作品库',kind:'none',requestId:'test'})?.name,'educational_visuals__search')
  assert.equal(directVisualWorkflowCall({message:'复用维护图解 template_id=sample.case template_version=1.0.0 kind=animation',kind:'diagram',requestId:'test'})?.arguments.kind,'animation')
  const fixture=harness([new Error('provider timeout')])
  const paused=await createVisualWork({request:'从零演示消息',kind:'animation',request_id:'cancel-golden'},fixture.context)
  assert.equal((await cancelVisualWork(paused.job_id!,fixture.context)).status,'cancelled')
})

test('maintained interactive reference is reused without generating executable source',async()=>{
  const source={hub_version:'1.0.0',work_id:template.id,version:'1.0.0',title:'交互作品',sha256:'test-digest'}
  const setup=harness([{source_mode:'reuse',source_ref:{kind:'template',id:template.id,version:template.version},builder:'interactive_html'}],{templates:true})
  const base=setup.context.artifactHost!.request
  setup.context.artifactHost!.request=async(op,p)=>op==='template'?{...template,builder:'interactive_html',source}:base(op,p)
  const result=await createVisualWork({request:'复用交互作品',kind:'animation',request_id:'hub-reuse'},setup.context)
  assert.equal(result.status,'ready');assert.equal(result.artifact?.builder,'interactive_html')
  assert.deepEqual(setup.calls.find(c=>c.operation==='publish')?.payload.source,source)
  assert.equal(setup.generations,1)
})

test('exact retrieved template button does not call the model',async()=>{
  const setup=harness([],{templates:true})
  const result=await createVisualWork({request:`复用维护图解 template_id=${template.id} template_version=${template.version}`,source_mode:'reuse',kind:'animation',request_id:'exact-ui'},setup.context)
  assert.equal(result.status,'ready');assert.equal(setup.generations,0)
  assert.deepEqual(setup.calls.find(c=>c.operation==='publish')?.payload.source,maintained)
})

test('BYOK configuration errors keep actionable reasons instead of attempting visual repair', async () => {
  const setup=harness([new Error('visual_user_model:credential_rejected: 请检查 API Key。')])
  const result=await createVisualWork({request:'从零演示消息',kind:'animation',request_id:'byok-failure'},setup.context)
  assert.equal(result.status,'paused')
  assert.equal(result.message,'请检查 API Key。')
  assert.equal(setup.generations,1)
  assert.ok(!setup.calls.some(c=>c.operation==='publish'))
})

test('desktop planner credential errors are not presented as VisualSpec validation failures', async () => {
  const setup=harness([new Error('409: 桌面模型凭据尚未配置')])
  const result=await createVisualWork({request:'从零演示消息',kind:'animation',request_id:'desktop-model-unavailable'},setup.context)
  assert.equal(result.status,'paused')
  assert.equal(result.message,'模型连接尚未配置或当前不可用；请在账户设置中检查模型凭据后重试。')
  assert.equal(setup.job.diagnostics[0].code,'model_unavailable')
})

test('source selection is small and separate; custom inputs can route to fresh construction',async()=>{
  const setup=harness([{source_mode:'fresh',reason:'用户要求不同输入'},fresh],{templates:true})
  const result=await createVisualWork({request:'用动画演示前文的具体输入',kind:'animation',request_id:'route-then-build'},setup.context)
  assert.equal(result.status,'ready')
  assert.equal(setup.generations,2)
  assert.ok(setup.prompts[0].includes('本轮只决定来源'))
  assert.ok(!setup.prompts[0].includes('<visual_spec_source_contract>'))
  assert.ok(setup.prompts[1].includes('<visual_spec_source_contract>'))
  assert.equal(setup.job.route.routing_decided,true)
})

test('Huffman follow-up reuses retrieved interactive animation with one selection call',async()=>{
  const huffman={...template,id:'lab2-huffman',title:'哈夫曼树：合并最轻的两棵树',description:'每步合并最小权重，展示前缀编码与带权路径长度'}
  const source={hub_version:'1.0.0',work_id:huffman.id,version:huffman.version,title:huffman.title,sha256:'test'}
  const setup=harness([{source_mode:'reuse',source_ref:{kind:'template',id:huffman.id,version:huffman.version}}],{templates:true})
  const base=setup.context.artifactHost!.request
  setup.context.artifactHost!.request=async(op,p)=>op==='catalog'?{...OFFLINE_VISUAL_CATALOG,templates:[huffman]}:op==='template'?{...huffman,builder:'interactive_html',source}:base(op,p)
  const result=await createVisualWork({request:'用动画演示一下\n【前文主题参考】讲一下哈夫曼树',kind:'animation',request_id:'huffman-follow-up'},setup.context)
  assert.equal(result.status,'ready');assert.equal(result.artifact?.builder,'interactive_html')
  assert.equal(setup.generations,1)
  assert.ok(setup.prompts[0].includes('哈夫曼树'))
  assert.ok(!setup.prompts[0].includes('<visual_spec_source_contract>'))
  assert.deepEqual(setup.calls.find(c=>c.operation==='publish')?.payload.source,source)
})

test('repair persists the latest precise diagnostic for the next resume',async()=>{
  const setup=harness([fresh,fresh],{publishErrors:['svg_story:/steps/0: missing fields [note]','svg_story:/steps/1/active_nodes: references invalid']})
  const result=await createVisualWork({request:'从零演示消息',kind:'animation',request_id:'precise-diagnostic'},setup.context)
  assert.equal(result.status,'paused')
  assert.ok(result.message?.includes('/steps/1/active_nodes'))
  assert.equal(setup.job.route.diagnostic,setup.job.diagnostics[0].detail)
})
