import {
  VISUAL_WORKFLOW_VERSION, createVisualWork, searchVisualWorks, openVisualWork,
  iterateVisualWork, resumeVisualWork, cancelVisualWork,
  type VisualWorkEnvelope, type VisualWorkflowContext, type VisualWorkKind, type VisualSourceMode,
} from './workflow.ts'

/** Both hosts inject their validated Plugin API. Shared code never imports a host or owns credentials. */
type PluginAPI<Package> = {
  LEARNFLOW_PLUGIN_API_VERSION: string
  LEARNFLOW_PLUGIN_OBJECT_VERSION: string
  defineLearnFlowPlugin(plugin: any): Package
}
const schema = (properties:Record<string,Record<string,unknown>>,required:string[]) => ({type:'object',properties,required,additionalProperties:false})
const string = (maxLength:number) => ({type:'string',minLength:1,maxLength})
const kind = {type:'string',enum:['diagram','animation']}
const revision = string(160), request = string(6000), requestId = string(160)
const modes = ['free','simple_explain','guided_learning','learning_plan']

export function createEducationalVisualsPlugin<Package>(api:PluginAPI<Package>):Package {
  const result = (value:VisualWorkEnvelope) => {
    // The host carries the envelope in object, payload and renderer state; bound their total.
    while(new TextEncoder().encode(JSON.stringify(value)).length>36*1024){
      if(value.results?.length)value={...value,results:value.results.slice(0,-1)}
      else if(value.catalog?.length)value={...value,catalog:value.catalog.slice(0,-1)}
      else if(value.jobs?.length)value={...value,jobs:value.jobs.slice(0,-1)}
      else throw new Error('visual_work_reference_too_large')
    }
    const summary=value.status==='ready'?`已保存${value.artifact?.kind==='animation'?'动画':'图解'}：${value.title}`:value.message||value.title
    const objectId=value.artifact?.revision_id||value.job_id||`visual-search-${Date.now()}`
    return {summary,objects:[{protocol:api.LEARNFLOW_PLUGIN_OBJECT_VERSION,pluginId:'educational_visuals',objectType:'visual_work',objectId,schemaVersion:VISUAL_WORKFLOW_VERSION,label:value.title,value}],payload:value,presentation:{renderer:'visual_work',state:value}}
  }
  const tool=(id:string,title:string,description:string,properties:Record<string,Record<string,unknown>>,required:string[],readOnly=false)=>({
    id,title,description,whenToUse:description,
    whenNotToUse:id==='create'?'已有工作job时用resume；已有作品需要修改时用iterate；仅文字讲解无需本工具。':id==='resume'?'没有job_id时不可猜测；新主题应创建新作品。':'仅在相应的真实作品或工作ID存在时使用；不得猜测来源或声称掌握。',
    toolClass:readOnly?'perception':'execution',risk:readOnly?'read_only':'artifact',
    inputSchema:schema(properties,required),outputObjectTypes:['visual_work'],renderer:'visual_work',
    availableInModes:modes,timeoutMs:readOnly?20_000:120_000,
  })
  return api.defineLearnFlowPlugin({
    manifest:{
      apiVersion:api.LEARNFLOW_PLUGIN_API_VERSION,id:'educational_visuals',name:'图解与动画',version:VISUAL_WORKFLOW_VERSION,
      description:'检索、从零构建、改编和恢复可回放教学图解与动画；保存独立作品版本。',defaultEnabled:false,
      objects:[{
        type:'visual_work',title:'图解与动画作品',description:'持久化作品引用或可恢复工作进度；源规格与场景按需读取。',schemaVersion:VISUAL_WORKFLOW_VERSION,
        schema:schema({schema_version:{type:'string',enum:[VISUAL_WORKFLOW_VERSION]},status:{type:'string',enum:['ready','paused','cancelled','search_results']},title:string(300),job_id:revision,stage:string(80),artifact:{type:'object'},results:{type:'array',maxItems:20,items:{type:'object'}},catalog:{type:'array',maxItems:8,items:{type:'object'}},jobs:{type:'array',maxItems:10,items:{type:'object'}},message:string(600),parent_revision_id:revision},['schema_version','status','title']),
        validate:(value:unknown)=>{
          const envelope=value as VisualWorkEnvelope
          if(envelope.status==='ready'&&!envelope.artifact?.revision_id)return ['ready visual_work requires a persisted revision']
          if(['paused','cancelled'].includes(envelope.status)&&!envelope.job_id)return ['interrupted visual_work requires a resumable job reference']
          return []
        },
      }],
      tools:[
        tool('create','创建图解与动画','用户明确要求图解或动画时调用。保留完整主题与输入；auto检索后明确选择复用、改编或从零，fresh跳过案例检索。',{request,kind,source_mode:{type:'string',enum:['auto','reuse','adapt','fresh']},base_revision_id:revision,request_id:requestId},['request','kind']),
        tool('search','检索图解与动画','用户寻找现有作品时检索自己的已保存版本与重点维护案例；返回小型引用和候选元数据。',{query:{type:'string',maxLength:6000},kind},['query'],true),
        tool('open','打开图解与动画','按已知revision_id读取并展示既有作品；不重新生成。',{revision_id:revision},['revision_id'],true),
        tool('iterate','修改图解与动画','用户要求修改已有作品时按revision_id创建子版本；原作品保持可用，修改说明必须保留用户具体输入。',{revision_id:revision,request,kind,request_id:requestId},['revision_id','request']),
        tool('resume','继续图解工作','用户选择继续中断的job_id时恢复已保存检索、候选与诊断，每次仅一次规格修复。',{job_id:revision},['job_id']),
        tool('cancel','停止图解工作','用户明确停止指定job_id时取消该工作，保留已有作品。',{job_id:revision},['job_id']),
      ],
      skills:[{
        id:'visual_workflow',title:'图解与动画工作流',description:'Tutor协调下的learning_design视觉产物工作流。',
        whenToUse:'用户明确要求可视化、查找图解、修改或恢复图解作品。',whenNotToUse:'普通讲解不强制激活；不负责评分、学习者画像或掌握判定。',
        instructions:'保留用户输入与来源模式。已有revision修改用iterate，已有job继续用resume，不能新建替代。新作品由create完成检索、精确选源、VisualSpec或SVGStory构建、有限修复和后端发布；不要求先完成长篇文字讲解。维护库没命中仍保留从零生成。ready仅表示服务端已保存作品，检查范围读取verification；paused说明进度已存储，提示继续或修改，不能声称生成成功。插件没有独立主Agent控制权，不写五核，不把生成、观看或交互当成掌握证据。',
        tools:['create','search','open','iterate','resume','cancel'],objectTypes:['visual_work'],
      }],
      renderers:[{id:'visual_work',title:'图解与动画工作区',description:'按版本引用读取并呈现图解、动画和可恢复工作状态。'}],
    },
    handlers:{
      create:async(input:Record<string,unknown>,context:VisualWorkflowContext)=>result(await createVisualWork({request:input.request as string,kind:input.kind as VisualWorkKind,source_mode:input.source_mode as VisualSourceMode|undefined,base_revision_id:input.base_revision_id as string|undefined,request_id:input.request_id as string|undefined},context)),
      search:async(input:Record<string,unknown>,context:VisualWorkflowContext)=>result(await searchVisualWorks(input.query as string,input.kind as VisualWorkKind|undefined,context)),
      open:async(input:Record<string,unknown>,context:VisualWorkflowContext)=>result(await openVisualWork(input.revision_id as string,context)),
      iterate:async(input:Record<string,unknown>,context:VisualWorkflowContext)=>result(await iterateVisualWork({revision_id:input.revision_id as string,request:input.request as string,kind:input.kind as VisualWorkKind|undefined,request_id:input.request_id as string|undefined},context)),
      resume:async(input:Record<string,unknown>,context:VisualWorkflowContext)=>result(await resumeVisualWork(input.job_id as string,context)),
      cancel:async(input:Record<string,unknown>,context:VisualWorkflowContext)=>result(await cancelVisualWork(input.job_id as string,context)),
    },
  })
}
