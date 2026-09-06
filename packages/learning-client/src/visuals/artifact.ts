import type {VisualSpec, VisualBundle, VisualTransport} from './types.ts'
import {describeFrame, renderView} from './presentation.ts'
export async function generateVisualize(spec: VisualSpec, kind:'diagram'|'animation', explanation:string, transport: VisualTransport) {
  const bundle:VisualBundle=await transport('compile',{spec,params:{}})
  if(bundle.verification.status!=='pass'||!bundle.frames.length)throw new Error('visual_verification_required')
  if(kind==='animation'&&bundle.frames.length<3)throw new Error('visual_animation_requires_semantic_transitions')
  const selected=kind==='diagram'?[bundle.frames[bundle.frames.length-1]]:bundle.frames
  const degraded=bundle.frames.some(f=>f.views.some(v=>renderView(v).diagnostics.length>0))
  const quality={semanticChanges:bundle.frames.length-1,verification:bundle.verification,rendering:{status:degraded?'text_fallback':'geometry_checked',transition:'cut',continuous_collision_check:'not_applicable'}}
  return {
    spec,explanation,quality,plannerSucceeded:true,degraded,
    artifact:{kind:kind==='animation'?'animation' as const:'image' as const,title:spec.title,subtitle:spec.teaching.goal,
      steps:selected.map(f=>({title:`第 ${f.step} 步`,text:describeFrame(bundle,f.step),svg:'',stateDescription:describeFrame(bundle,f.step)})),
      specVersion:'visualize.0.1.0',renderer:'learnflow.visualize.svg.v1',canvasFormat:'svg' as const,
      status:degraded?'degraded' as const:'usable' as const,degraded,fallbackUsed:degraded,plannerSucceeded:true,
      readable:{summary:spec.teaching.goal,readingOrder:spec.views.flatMap(v=>v.elements.map(e=>e.id)),frameDescriptions:selected.map(f=>describeFrame(bundle,f.step)),nonColorStateCue:'逐步文字状态与完整数据可读。'},
      visualize:bundle,
    },
    generation:{source:'deterministic_compiler' as const,compileStatus:'exact' as const,plannerAttempts:0,repairAttempted:false,syntaxRepairApplied:false,attempts:[]},
  }
}
