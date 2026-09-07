import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeVisualTeachingBundle,
  explanationOnlyVisualTeachingBundle,
  parseVisualTeachingBrief,
  validateVisualTeachingExplanation,
  visualTeachingReply,
  visualTeachingBriefPrompt,
} from './visual-teaching-skill.ts'
import { executeTutorAgentTool } from './tool-runtime.ts'

const validAnimation = JSON.stringify({
  topic: '快速排序分区',
  learning_goal: '理解 pivot 如何把一个区间分成左右两部分',
  modality_rationale: '指针扫描、交换和 pivot 归位构成有顺序的状态变化',
  explanation: '快速排序的一趟分区包含数组、基准值 pivot 和扫描边界。初始时 pivot 被选定，扫描过程把较小元素移到左侧、较大元素留在右侧，随后 pivot 进入最终位置。这里只演示一趟分区，不把它误说成整个数组已经排序完成。',
  objects: [
    { id: 'array', label: '数组区间', role: '当前待分区的数据' },
    { id: 'pivot', label: '基准值', role: '划分左右区域的参照' },
    { id: 'scan', label: '扫描指针', role: '逐项检查元素' },
  ],
  relations: [
    { from: 'scan', to: 'array', label: '逐项检查' },
    { from: 'pivot', to: 'array', label: '划分区间' },
  ],
  initial_state: 'pivot 已选定，扫描尚未开始',
  steps: [
    { id: 'scan_items', title: '扫描元素', before: '左右区域尚未确定', change: '逐项与 pivot 比较并交换', after: '较小元素集中到左侧', why: '建立分区不变量' },
    { id: 'place_pivot', title: '基准归位', before: 'pivot 仍在临时位置', change: '把 pivot 与边界元素交换', after: 'pivot 位于最终排序位置', why: '左侧不大于 pivot，右侧不小于 pivot' },
  ],
  final_state: 'pivot 归位，左右子区间仍需递归排序',
  invariants: ['已扫描区域始终满足分区条件'],
  misconceptions: ['一次分区不等于完成全部排序'],
  claim_boundary: '只表达一趟分区，不声称具体实现一定使用双指针',
})

test('visual teaching brief requires real objects and two animation changes', () => {
  const brief = parseVisualTeachingBrief(validAnimation, 'animation', '用动画演示快速排序分区')
  assert.equal(brief.objects.length, 3)
  assert.equal(brief.steps.length, 2)
  assert.equal(brief.modality, 'animation')

  const invalid = JSON.parse(validAnimation)
  invalid.steps = invalid.steps.slice(0, 1)
  assert.throws(
    () => parseVisualTeachingBrief(JSON.stringify(invalid), 'animation', '用动画演示快速排序'),
    /animation_changes_insufficient/,
  )
})

test('independent explanation is valid before any brief exists', () => {
  const explanation = validateVisualTeachingExplanation(JSON.parse(validAnimation).explanation)
  const bundle = explanationOnlyVisualTeachingBundle(explanation, 'animation', new Error('brief invalid'))
  assert.equal(bundle.visualBrief, undefined)
  assert.equal(bundle.explanation, explanation)
  assert.equal(bundle.terminalState, 'explanation_only')
})

test('committed teaching code and math keep their newlines through planning and visual failure', () => {
  const explanation = `${JSON.parse(validAnimation).explanation}\n\n观察初始状态到结果的变化：\n\n$$\nx_{t+1}=x_t+1\n$$\n\n\`\`\`python\nfor x in range(3):\n    print(x + 1)\n\`\`\`\n\n代码中的缩进表示循环体，公式表示同一个更新关系。`
  assert.equal(validateVisualTeachingExplanation(explanation), explanation)
  assert.ok(visualTeachingBriefPrompt('animation', '演示变化', explanation).includes(explanation))
  const brief = parseVisualTeachingBrief(validAnimation, 'animation', '演示分区', explanation)
  const bundle = completeVisualTeachingBundle(brief, undefined, new Error('timeout'))
  assert.equal(bundle.explanation, explanation)
  assert.ok(visualTeachingReply(bundle).startsWith(explanation))
  assert.throws(() => validateVisualTeachingExplanation(explanation + '长'.repeat(5000)), /explanation_too_long/)
  assert.throws(() => visualTeachingBriefPrompt('animation', '演示变化', explanation + '长'.repeat(5000)), /explanation_too_long/)
})

test('visual failure has a legal explanation-only terminal with unchanged prose', () => {
  const brief = parseVisualTeachingBrief(validAnimation, 'animation', '用动画演示快速排序分区')
  const bundle = completeVisualTeachingBundle(brief, {
    id: 'failed', kind: 'animation', status: 'failed', title: '生成过程动画',
    detail: 'visual timeout', durationMs: 10, toolName: 'generate_learning_animation',
  })
  assert.equal(bundle.terminalState, 'explanation_only')
  assert.equal(bundle.explanation, brief.explanation)
  assert.equal(bundle.explanationPreserved, true)
  assert.match(visualTeachingReply(bundle), new RegExp(`^${brief.explanation}`))
})

test('raw visual tools reject calls that bypass the visual teaching skill', async () => {
  const result = await executeTutorAgentTool('generate_learning_animation', {
    query: '用动画演示快速排序分区',
  }, {
    message: '用动画演示快速排序分区',
    recentMessages: [{ role: 'user', content: '用动画演示快速排序分区' }],
    generate: async () => { throw new Error('renderer must not run without a brief') },
  })
  assert.equal(result.run.status, 'failed')
  assert.match(result.run.detail, /visual_teaching_composition.*VisualBrief/)
  assert.equal(result.run.artifact, undefined)
})

import { prepareVisualTeachingBrief } from './visual-teaching-skill.ts'
import { resolveVisualRequest } from './visual-tool-execution.ts'

const conciseBrief = {
  topic:'卷积的局部窗口', learning_goal:'观察共享卷积核的乘加', modality_rationale:'单步观察窗口和输出',
  claim_boundary:'小矩阵教学例，不代表训练后的MNIST模型', misconceptions:[],
  explanation:'共享卷积核在输入矩阵的不同区域重复使用同一组参数。每一步的点乘求和形成一个输出格，这个小例用于解释机制，不代表真实训练结果。',
}
const freshSpec = {
  spec_version:'0.2.0', id:'novel_matrix_composition',title:'局部区域与结果',
  teaching:{goal:'观察局部运算',assumptions:['教学小矩阵']},
  model:{id:'computation.pipeline'},data:{program:{steps:[{id:'transpose',op:'transpose',args:{input:[[1,2],[3,4]]}},{id:'sum',op:'reduce_sum',args:{input:{source:'/state/results/transpose'}}}]}},
}
const verified = {verification:{status:'pass'},frames:[{step:0},{step:1},{step:2}]}

test('CNN follow-up retrieves metadata, model selects an exact maintained version, host validates it', async () => {
  const request = resolveVisualRequest('给我一个动画演示一下', [{role:'user',content:'跟我讲一下CNN手写数字识别'},{role:'assistant',content:'卷积核使用共享权重在图像上移动。'}])
  const actions:string[] = []
  const ref = {id:'deep_learning.cnn.mechanism',version:'1.0.0'}
  const result = await prepareVisualTeachingBrief({modality:'animation',request:request.effectiveRequest,
    transport:async (action,payload) => {
      actions.push(action)
      if(action==='catalog') {assert.match(String(payload.query),/CNN手写数字识别/);return {catalog_version:'golden',capabilities:{},patterns:[],templates:[{...ref,title:'CNN机制',description:'共享权重',tags:['cnn'],kind:'animation'}]}}
      if(action==='template') {assert.deepEqual(payload,ref);return {...ref,spec:freshSpec}}
      assert.equal((payload.spec as any).id,'novel_matrix_composition'); assert.deepEqual(payload.template_ref,ref);return verified
    },generate:async prompt => {assert.match(prompt,/deep_learning.cnn.mechanism/);return JSON.stringify({...conciseBrief,template_ref:ref})},
  })
  assert.deepEqual(actions,['catalog','template','compile']);assert.deepEqual(result.templateRef,ref)
  // A requested adaptation must never silently return the unmodified recipe.
  let adaptations=0;let adaptedCompiles=0
  await assert.rejects(prepareVisualTeachingBrief({modality:'animation',request:'把CNN案例改成步长2',
    transport:async(action)=>action==='catalog' ? {catalog_version:'golden',capabilities:{},patterns:[],templates:[{...ref,title:'CNN机制',description:'共享权重',tags:['cnn'],kind:'animation'}]}
      : action==='template' ? {...ref,spec:freshSpec} : (++adaptedCompiles,verified),
    generate:async()=>JSON.stringify({...conciseBrief,template_ref:ref,...(++adaptations===1 ? {adapt:true,adaptation_goal:'stride=2'} : {})}),
  }),/visual_template_adaptation_requires_spec/)
  assert.equal(adaptedCompiles,0);assert.equal(adaptations,3)
})

test('fresh novel compositions remain available on catalog failure and do not read a template', async () => {
  let calls=0
  const result=await prepareVisualTeachingBrief({modality:'animation',request:'从零组合一个先转置再求和的矩阵动画，不要模板',
    transport:async (action,payload) => {if(action==='catalog')throw new Error('catalog network unavailable');assert.equal(action,'compile');assert.equal(payload.template_ref,undefined);return verified},
    generate:async prompt => {calls++;assert.match(prompt,/用户明确要求从零构建/);assert.match(prompt,/computation.pipeline/);return JSON.stringify({...conciseBrief,visual_spec:freshSpec})},
  })
  assert.equal(calls,1);assert.equal(result.visualSpec?.id,'novel_matrix_composition');assert.equal(result.templateRef,undefined)
})

test('unsupported capabilities stop once while actual compile errors get one exact repair', async () => {
  let calls=0
  const transport=async (action:string) => action==='catalog' ? {catalog_version:'golden',capabilities:{},patterns:[],templates:[]} : verified
  await assert.rejects(prepareVisualTeachingBrief({modality:'animation',request:'演示未接入的实时医学影像',transport,
    generate:async()=>{calls++;return JSON.stringify({unsupported:{reason:'缺少实时输入与对应计算能力'}})}}),/visual_unsupported:缺少实时输入/)
  assert.equal(calls,1)
  const prompts:string[]=[];let compiles=0
  const result=await prepareVisualTeachingBrief({modality:'animation',request:'转置后求和',
    transport:async(action)=>{if(action==='catalog')return transport(action);if(++compiles===1)throw new Error('/data/program/steps/1/args/input: future result binding');return verified},
    generate:async prompt=>{prompts.push(prompt);return JSON.stringify({...conciseBrief,visual_spec:freshSpec})},
  })
  assert.equal(prompts.length,2);assert.match(prompts[1],/\/data\/program\/steps\/1\/args\/input: future result binding/);assert.equal(result.repairAttempted,true)
})


import { visualPlanningRequest, assertVisualProviderComplete } from './visualize-authoring.ts'

test('visual JSON requests disable supported provider thinking and incomplete responses bypass schema repair', async () => {
  const ordinary = {endpoint:'https://api.deepseek.com/chat/completions',body:{model:'deepseek-v4-flash',messages:[]}}
  const visual = visualPlanningRequest(ordinary, 'deepseek-v4-flash')
  assert.deepEqual((visual.body as any).thinking,{type:'disabled'})
  assert.equal((ordinary.body as any).thinking,undefined)
  assert.deepEqual((visualPlanningRequest({...ordinary,endpoint:'https://api.deepseek.com/responses'},'deepseek-v4-flash').body as any).reasoning,{effort:'none'})
  assert.equal(visualPlanningRequest({...ordinary,endpoint:'https://example.com/chat/completions'},'deepseek-v4-flash').body,ordinary.body)
  let calls=0
  await assert.rejects(prepareVisualTeachingBrief({modality:'diagram',request:'从零转置矩阵',
    transport:async()=>({catalog_version:'golden',capabilities:{},patterns:[],templates:[]}),
    generate:async()=>{calls++;assertVisualProviderComplete({choices:[{finish_reason:'length'}]},'');return ''},
  }),/visual_provider_incomplete:finish_reason=length/)
  assert.equal(calls,1)
  assert.throws(()=>assertVisualProviderComplete({choices:[{finish_reason:'stop'}]},''),/visual_provider_empty/)
  assertVisualProviderComplete({choices:[{finish_reason:'stop'}]},'{"topic":"complete"}')
})
