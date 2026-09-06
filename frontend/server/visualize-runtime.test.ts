import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync,existsSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {generateVisualize} from './visualize-artifact.ts'
import {parseVisualTeachingBrief,visualTeachingBriefPrompt} from './visual-teaching-skill.ts'
import {executeLearningVisual} from './visual-tool-execution.ts'
import {renderView,describeFrame} from '../src/visualize-presentation.ts'
let root=dirname(fileURLToPath(import.meta.url));while(!existsSync(join(root,'packages/learning-core')))root=dirname(root)
const example=(name:string)=>JSON.parse(readFileSync(join(root,`docs/design/visualize/source/examples/${name}.visualspec.json`),'utf8'))
function compile(spec:any,params={}) {
 const result=spawnSync(join(root,'backend/venv/bin/python'),['-c',`import sys,json;sys.path.insert(0,sys.argv[1]);from learnflow_core.visuals.engine import compile_visual;s=json.load(sys.stdin);print(json.dumps(compile_visual(s['spec'],s['params'])))`,join(root,'packages/learning-core/src')],{input:JSON.stringify({spec,params}),encoding:'utf8'})
 assert.equal(result.status,0,result.stderr);return {...JSON.parse(result.stdout),owner_scope:'test'}
}
test('three real host traces render through shared primitives without geometry diagnostics',async()=>{
 for(const [name,kind] of [['bfs','animation'],['gradient-descent','animation'],['density-area','diagram']] as const) {
  const s=example(name);const bundle=compile(s)
  for(const f of bundle.frames)for(const v of f.views)for(const width of [720,300]){const r=renderView(v,width);assert.deepEqual(r.diagnostics,[],name);assert.match(r.svg,/<svg/);assert.ok(!r.svg.includes('NaN'));assert.equal(r.plan.transition,'cut')}
  const artifact=await generateVisualize(s,kind,'解释',async()=>bundle)
  assert.equal(artifact.artifact.canvasFormat,'svg');assert.equal(artifact.artifact.visualize.spec_revision,bundle.spec_revision)
  const changed=name==='gradient-descent'?compile(s,{alpha:.5}):name==='density-area'?compile(s,{width:2}):bundle
  if(name==='density-area')assert.match(describeFrame(changed,0),/0.05/)
 }
})
test('new authoring routes to host compiler without ASCII designer or further model calls',async()=>{
 const s=example('gradient-descent');const explanation='初始对象是二次函数上的参数点。更新过程由导数和学习率共同决定，状态依次改变。结果可能在最优点两侧交替，但距离缩小；这一条件仅适用于这个二次函数，不能推广到任意损失函数。这里给出明确的初始条件，所有数值由确定性程序计算，并在状态发生变化后检查。'
 const brief=parseVisualTeachingBrief(JSON.stringify({topic:'梯度下降',learning_goal:s.teaching.goal,modality_rationale:'状态更新',claim_boundary:'仅二次型',visual_spec:s}),'animation','梯度下降动画',explanation)
 assert.ok(brief.visualSpec)
 const output=await executeLearningVisual('animation','梯度下降动画',[],async()=>{throw new Error('unexpected model call')},undefined,brief,async(action,payload)=>{assert.equal(action,'compile');return compile(payload.spec)})
 assert.ok(output.generated.artifact.visualize)
 assert.match(visualTeachingBriefPrompt('animation','梯度下降动画',explanation),/optimization.quadratic_gd/)
})
test('structural diagrams accept one state and escape markup; crowded text becomes explicit diagnostics',()=>{
 const s=example('bfs');s.model={id:'structure.snapshot',version:'1.0.0',inputs:{content:{source:'/data/content'}},seed:0,max_steps:1};s.data={content:{label:'<script>alert(1)</script>'}};s.parameters=[];s.interactions=[];s.teaching.checkpoints=[];s.layout.view_order=['v'];s.views=[{id:'v',title:'文字',renderer:'svg',elements:[{id:'label',kind:'text',label:'说明',inputs:{value:{source:'/state/label'}}}]}];s.validation.requested_checks=[]
 const b=compile(s);assert.equal(b.frames.length,1);assert.equal(b.verification.scope,'structure_only')
 const r=renderView(b.frames[0].views[0]);assert.match(r.svg,/&lt;script&gt;/);assert.doesNotMatch(r.svg,/<script>/)
 b.frames[0].views[0].elements[0].values.value='长'.repeat(100)
 assert.equal(renderView(b.frames[0].views[0]).diagnostics[0].code,'TEXT_TOO_DENSE')
})
