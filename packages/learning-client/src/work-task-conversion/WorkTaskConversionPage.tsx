import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { conversionClient, conversionIdFromSearch, conversionModes, generationRetryIdentity, learningDestination, lineItems, safeResourceUrl, type ConversionBrief, type ConversionMode, type ConversionView } from './client.ts'
import './work-task-conversion.css'

const emptyBrief: ConversionBrief = {task_title:'',task_description:'',work_context:'',deliverable:'',acceptance_criteria:[],constraints:[],learner_level:''}
const fieldLabels: Record<string,string> = {task_title:'典型工作任务',task_description:'具体工作',work_context:'工作情境',deliverable:'交付物',acceptance_criteria:'验收标准',constraints:'条件与限制',learner_level:'已有基础'}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const array = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(item=>item && typeof item === 'object') : []
const strings = (value: unknown) => Array.isArray(value) ? value.filter(item=>typeof item === 'string').join('；') : text(value)
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

export default function WorkTaskConversionPage({fetcher,accountName,onSignOut}: {fetcher: typeof fetch;accountName?: string;onSignOut?:()=>void}) {
  const request = useMemo(()=>conversionClient(fetcher),[fetcher])
  const [view,setView] = useState<ConversionView>()
  const [drafts,setDrafts] = useState<ConversionView[]>([])
  const [brief,setBrief] = useState<ConversionBrief>(emptyBrief)
  const [input,setInput] = useState('')
  const [message,setMessage] = useState('')
  const [mode,setMode] = useState<ConversionMode>('learning')
  const [recipe,setRecipe] = useState('')
  const [selected,setSelected] = useState<string[]>([])
  const [projects,setProjects] = useState<{id:number;name:string}[]>([])
  const [projectId,setProjectId] = useState('')
  const [busy,setBusy] = useState('loading')
  const [error,setError] = useState('')
  const [desktopLink,setDesktopLink] = useState('')
  const [desktopExpiry,setDesktopExpiry] = useState('')
  const mounted = useRef(true)
  const viewRef = useRef<ConversionView>()
  const operation = useRef(0)
  const keys = useRef(new Map<string,string>())
  const createIntent = useRef(crypto.randomUUID())
  const launchToken = useRef(new URLSearchParams(window.location.hash.slice(1)).get('role_token') || '')
  viewRef.current = view
  const actionId = (name:string,payload:unknown) => {
    const key = `${name}:${JSON.stringify(payload)}`
    if (!keys.current.has(key)) keys.current.set(key,crypto.randomUUID())
    return keys.current.get(key)!
  }
  const accept = (next:ConversionView, resetForm=true) => {
    setView(next)
    if (resetForm) setBrief({...emptyBrief,...next.brief})
    setDrafts(previous=>[next,...previous.filter(item=>item.id!==next.id)].slice(0,50))
    const url=new URL(window.location.href);url.searchParams.set('conversion',next.id);url.hash=''
    window.history.replaceState({},'',url)
  }
  const run = async (name:string,task:()=>Promise<void>) => {
    const current=++operation.current;setBusy(name);setError('')
    try { await task() } catch(error) {if(mounted.current && current===operation.current)setError(errorText(error))}
    finally {if(mounted.current && current===operation.current)setBusy('')}
  }
  useEffect(()=>{
    mounted.current=true
    document.title='工作任务转换 · LearnFlow'
    void run('loading',async()=>{
      const result=await request<{items:ConversionView[]}>();if(!mounted.current)return;setDrafts(result.items||[])
      if(launchToken.current) {
        const body={original_input:'从岗位包选择的典型工作任务',role_launch_token:launchToken.current}
        const next=await request('',{...body,client_action_id:actionId('role',body)})
        if(mounted.current){launchToken.current='';accept(next)}
      } else {
        const id=conversionIdFromSearch(window.location.search)
        if(id){const next=await request(`/${id}`);if(mounted.current)accept(next)}
      }
    })
    void fetcher('/api/vnext-projects').then(response=>response.ok?response.json():{}).then((data:Record<string,any>)=>{if(mounted.current)setProjects(array(data.projects||data.items).map(item=>({id:Number(item.id),name:text(item.name)}))) }).catch(()=>{})
    return()=>{mounted.current=false;operation.current++}
  },[request,fetcher])
  const generating=view?.state==='generating' || view?.generation?.status==='running'
  useEffect(()=>{
    if(!view?.id || !generating)return
    const id=view.id;let stopped=false;let timer:ReturnType<typeof setTimeout>
    const controller=new AbortController()
    const poll=async()=>{
      try{const next=await request(`/${id}`,undefined,controller.signal);if(!stopped && viewRef.current?.id===id)accept(next,false)}
      catch(error){if(!stopped)setError(errorText(error))}
      if(!stopped)timer=setTimeout(poll,2500)
    }
    timer=setTimeout(poll,1800)
    return()=>{stopped=true;controller.abort();clearTimeout(timer)}
  },[view?.id,generating,request])
  useEffect(()=>{
    setDesktopLink('');setDesktopExpiry('')
    const candidate=view?.candidate
    setRecipe(candidate?.design?.recipe_id || (candidate?.design?.readiness==='needs_domain_authoring'?'domain-draft':''))
    if(candidate?.project_mode)setMode(candidate.project_mode)
    setProjectId(view?.selection?.project_id ? String(view.selection.project_id) : '')
    setSelected(view?.selection?.selected_step_ids || array(candidate?.learning_candidate?.task?.steps).map(step=>String(step.id)))
  },[view?.candidate?.candidate_id,view?.id])
  const changed=Boolean(view && JSON.stringify(brief)!==JSON.stringify({...emptyBrief,...view.brief}))
  const locked=Boolean(busy)||Boolean(generating)
  const candidate=view?.candidate
  const learning=candidate?.learning_candidate
  const steps=array(learning?.task?.steps)
  const design=candidate?.design
  const reviewOnly=Boolean(design && design.readiness!=='ready')
  const selectedSteps=steps.filter(step=>selected.includes(String(step.id)))
  const dependencyMissing=selectedSteps.some(step=>Array.isArray(step.prerequisiteStepIds)&&step.prerequisiteStepIds.some((id:string)=>!selected.includes(id)))
  const invalidSelection=Boolean(learning)&&(selected.length<3||dependencyMissing)
  const readyRecipes=array(view?.design_recipes).filter(item=>item.readiness==='ready')

  const canLeaveDraft=()=>!(changed||message.trim()||(!view&&input.trim()))||window.confirm('这份任务还有未保存的修改或未发送的补充。确定放弃后切换吗？')
  const newDraft=()=>{if(!canLeaveDraft())return;createIntent.current=crypto.randomUUID();setInput('');setView(undefined);setBrief(emptyBrief);setMessage('');setError('');setDesktopLink('');setProjectId('');window.history.replaceState({},'','/convert')}
  const openDraft=(id:string)=>{if(id===view?.id)return;if(!canLeaveDraft())return;void run('load',async()=>{const next=await request(`/${id}`);setMessage('');accept(next)})}
  const create=(event:FormEvent)=>{event.preventDefault();if(!input.trim())return;void run('create',async()=>{
    const body={original_input:input.trim()};accept(await request('',{...body,client_action_id:actionId(`create:${createIntent.current}`,body)}));setInput('')
  })}
  const send=(event:FormEvent)=>{event.preventDefault();if(!view||!message.trim())return;void run('message',async()=>{
    const body={expected_revision:view.revision,message:message.trim()};accept(await request(`/${view.id}/messages`,{...body,client_action_id:actionId(`message:${view.id}`,body)}));setMessage('')
  })}
  const saveBrief=(event:FormEvent)=>{event.preventDefault();if(!view)return;void run('save',async()=>{
    const body={expected_revision:view.revision,brief:{...brief,acceptance_criteria:lineItems(brief.acceptance_criteria.join('\n')),constraints:lineItems(brief.constraints.join('\n'))}};accept(await request(`/${view.id}/brief`,{...body,client_action_id:actionId(`brief:${view.id}`,body)}))
  })}
  const generate=()=>{if(!view)return;void run('generate',async()=>{
    const body={expected_root_hash:view.root_hash,confirmed:true,project_mode:mode,...(mode!=='learning'?{design_recipe_id:recipe}:{})}
    // A completed failure needs a new action; transport retries retain the same one.
    const retry=generationRetryIdentity(view)
    accept(await request(`/${view.id}/generate`,{...body,client_action_id:actionId(`generate:${view.id}:${retry}`,body)}))
  })}
  const handoff=(action:'discuss'|'create_project'|'desktop')=>{if(!view)return;void run(action,async()=>{
    const body={expected_root_hash:view.root_hash,confirmed:true,action,...(action==='discuss'&&projectId?{project_id:Number(projectId)}:{}),...(learning?{selected_step_ids:selected}:{})}
    const result=await request<Record<string,any>>(`/${view.id}/handoff`,{...body,client_action_id:actionId(`handoff:${view.id}`,body)})
    if(action==='desktop'){
      const url=text(result.desktop_url)
      if(!/^learnflow:\/\/conversion\?ticket=[A-Za-z0-9_-]{20,512}$/.test(url))throw new Error('桌面接续链接无效，请重试。')
      setDesktopLink(url);setDesktopExpiry(text(result.expires_at));window.location.assign(url)
    }else{
      const path=text(result.navigation?.path)||(result.project_id?`/projects/${result.project_id}`:'')
      window.location.assign(learningDestination(path,window.location.origin))
    }
  })}

  return <div className="wtc-app">
    <header className="wtc-top"><a className="wtc-brand" href="/convert"><b>↗</b><span>LearnFlow <small>工作任务转换</small></span></a><nav><a href="https://roles.learnflow.club">岗位包</a><a href="https://learn.learnflow.club">学习空间 ↗</a>{onSignOut&&<button onClick={onSignOut}>{accountName||'账户'} · 退出</button>}</nav></header>
    <main className="wtc-shell">
      <aside className="wtc-sidebar"><span className="wtc-eyebrow">WORK → LEARNING</span><h1>把真实工作，<br/>变成下一次成长。</h1><p>明确要完成的工作，再选择理解知识、验证问题，或完整交付。</p><button className="wtc-new" disabled={locked} onClick={newDraft}>＋ 新的工作任务</button><h2>最近的转换</h2><div className="wtc-drafts">{drafts.map(item=><button key={item.id} disabled={locked} className={item.id===view?.id?'active':''} onClick={()=>openDraft(item.id)}><strong>{item.brief?.task_title||item.original_input||'岗位任务'}</strong><small>{item.state==='generated'?'方案已生成':item.state==='generating'?'正在生成':'任务草稿'}</small></button>)}{!drafts.length&&<p>草稿会保存在你的账户中，可以随时回来继续。</p>}</div></aside>
      <div className="wtc-content">
        {error&&<div className="wtc-error" role="alert">{error}<button disabled={locked} onClick={()=>void run('refresh',async()=>{if(view)accept(await request(`/${view.id}`));else window.location.reload()})}>刷新并恢复</button></div>}
        {busy==='loading'&&!view&&<p role="status">正在恢复你的转换草稿…</p>}
        {!view?<section className="wtc-panel wtc-intake"><span className="wtc-eyebrow">01 / 明确一件典型工作</span><h2>你想把什么工作转成学习任务？</h2><p>可以从岗位包选取，也可以从一段真实经历开始。我们会一起补齐情境、交付物和验收标准。</p><form onSubmit={create}><label htmlFor="wtc-intake">描述工作任务</label><textarea id="wtc-intake" value={input} onChange={event=>setInput(event.target.value)} maxLength={12000} placeholder="例如：接手客户的库存数据导入，处理重复与异常记录，最后交付能重复执行的导入程序和验收报告。" rows={7}/><div className="wtc-row"><small>先明确工作，再生成方案。</small><button className="wtc-primary" disabled={locked||!input.trim()}>开始梳理 →</button></div></form></section>:<>
          <section className="wtc-panel"><div className="wtc-section-title"><div><span className="wtc-eyebrow">01 / 工作任务</span><h2>{view.brief.task_title||'一起明确这件工作'}</h2></div><span className="wtc-badge">已保存 · 版本 {view.revision}</span></div>
            <div className="wtc-messages" aria-live="polite">{view.messages.map((item,index)=><article key={index} className={item.role==='user'?'user':'assistant'}><small>{item.role==='user'?'你':'任务梳理'}</small><p>{item.content}</p></article>)}</div>
            {view.question&&<p className="wtc-question">{view.question}</p>}
            <form onSubmit={send} className="wtc-compose"><label className="wtc-sr" htmlFor="wtc-message">补充任务信息</label><textarea id="wtc-message" value={message} onChange={event=>setMessage(event.target.value)} maxLength={5000} rows={2} placeholder="补充情境、限制，或说明哪里理解得不对…" disabled={locked}/><button disabled={locked||!message.trim()||changed}>补充</button></form>
            <details className="wtc-brief" open={!candidate}><summary>检查并完善任务说明 {view.missing_fields.length?`· 还需 ${view.missing_fields.length} 项`:'· 信息已齐备'}</summary><p>下方内容会作为生成依据。可以直接修订，保存后旧方案会失效。</p><form onSubmit={saveBrief}><div className="wtc-fields">{Object.keys(fieldLabels).map(key=><label key={key}>{fieldLabels[key]}<textarea rows={key==='task_description'?3:2} value={Array.isArray(brief[key as keyof ConversionBrief])?(brief[key as keyof ConversionBrief] as string[]).join('\n'):text(brief[key as keyof ConversionBrief])} onChange={event=>setBrief(previous=>({...previous,[key]:['acceptance_criteria','constraints'].includes(key)?event.target.value.split('\n'):event.target.value}))} disabled={locked} maxLength={4000} placeholder={key==='acceptance_criteria'||key==='constraints'?'每行一条':''}/></label>)}</div><div className="wtc-row"><small>{view.missing_fields.map(key=>fieldLabels[key]||key).join('、')}{changed?' · 有未保存的修改':''}</small><button disabled={locked||!changed}>保存任务说明</button></div></form></details>
            {!!view.source_refs.length&&<details className="wtc-sources"><summary>任务来源 · {view.source_refs.length} 条</summary>{view.source_refs.map((ref,index)=><article key={index}><strong>{text(ref.label)||text(ref.title)||text((ref.task_ref as Record<string,unknown>)?.label)||text(ref.task_label)||'来源记录'}</strong><p>{text(ref.summary)||text((ref.task_ref as Record<string,unknown>)?.summary)||text(ref.description)}</p>{(ref.task_ref as Record<string,unknown>)?.summaryTruncated===true&&<small>此处展示摘要前 400 字；来源仍绑定完整发布版本。</small>}<dl>{Object.entries({...ref,...((ref.package_ref||{}) as Record<string,unknown>),...((ref.task_ref||{}) as Record<string,unknown>)}).filter(([key])=>['packageId','packageVersion','snapshotId','rootHash','nodeId','package_id','package_version','snapshot_id','root_hash','node_id','source_kind','kind','role_title'].includes(key)).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></article>)}</details>}
          </section>
          <section className="wtc-panel"><span className="wtc-eyebrow">02 / 选择转化方式</span><h2>这一次，你想怎样学习？</h2><div className="wtc-modes">{conversionModes.map(item=><button key={item.id} className={mode===item.id?'active':''} disabled={locked} aria-pressed={mode===item.id} onClick={()=>{setMode(item.id);setRecipe('')}}><b>{item.name}</b><span>{item.description}</span><small>{item.destination} ↗</small></button>)}</div>
            {mode!=='learning'&&<div className="wtc-recipes"><label htmlFor="wtc-recipe">选择专业设计</label><select id="wtc-recipe" value={recipe} disabled={locked} onChange={event=>setRecipe(event.target.value)}><option value="">选择与工作相关的方案</option>{readyRecipes.map(item=><option key={item.recipe_id} value={item.recipe_id}>{item.title}</option>)}<option value="domain-draft">其他领域 · 起草待审核方案</option></select>{recipe==='domain-draft'?<p>整理专业设计草案与待补材料，交给 Tutor 继续讨论。补齐领域素材与验收器后才能导入执行。</p>:readyRecipes.filter(item=>item.recipe_id===recipe).map(item=><div key={item.recipe_id}><p>{text(item.description)}</p><p><strong>适用边界：</strong>{text(item.applicability?.boundary)}</p><small>这是相近工作活动的教学演练。你的真实业务验收仍需单独审核。</small>{array(item.constraint_review).length>0&&<ul>{array(item.constraint_review).map((entry,index)=><li key={index}>{text(entry.requirement)} · {entry.status==='applied'?'已转入演练条件':'待专业核对'}</li>)}</ul>}</div>)}</div>}
            <div className="wtc-row wtc-generate"><small>{generating?'正在生成，离开页面后可回来查看。':changed?'先保存修改后的任务说明。':view.missing_fields.length?'先补齐任务信息。':mode==='learning'?'由讯飞工作流生成，完成后可选择学习步骤。':'按选定的设计和任务条件编译方案。'}</small><button className="wtc-primary" disabled={locked||changed||Boolean(view.missing_fields.length)||(mode!=='learning'&&!recipe)} onClick={generate}>{generating?'正在生成…':candidate?'按当前选择重新生成':'确认任务并生成 →'}</button></div>
            {view.generation?.status==='failed'&&<p className="wtc-error" role="alert">{view.generation.error_message||'上次生成未完成，可以重试。'}</p>}
          </section>
          {candidate&&<section className="wtc-panel wtc-result"><div className="wtc-section-title"><div><span className="wtc-eyebrow">03 / 预览与接续</span><h2>{text(candidate.title)}</h2></div><span className="wtc-badge">{conversionModes.find(item=>item.id===candidate.project_mode)?.name} · {reviewOnly?'待专业审核':'方案候选'}</span></div><p>{text(candidate.summary)}</p>
            {learning&&<><p>默认选择全部步骤。至少保留 3 步，并保留所选步骤的前置依赖。</p><div className="wtc-steps">{steps.map((step,index)=><article key={step.id}><label><input type="checkbox" checked={selected.includes(String(step.id))} disabled={locked} onChange={event=>setSelected(previous=>event.target.checked?[...previous,String(step.id)]:previous.filter(id=>id!==String(step.id)))}/><b>{index+1}. {text(step.title)}</b></label><p>{text(step.action)}</p><p><strong>交付：</strong>{strings(step.deliverables)}</p><p><strong>验收：</strong>{strings(step.successCriteria)}</p><div className="wtc-tags">{[...array(learning.mappings?.knowledgeTargets).filter(item=>step.knowledgeTargetIds?.includes(item.id)),...array(learning.mappings?.skillTargets).filter(item=>step.skillTargetIds?.includes(item.id))].map(item=><span key={item.id}>{text(item.title)}</span>)}</div>{array(step.resources).map((resource,index)=>safeResourceUrl(resource.url)?<a key={index} href={safeResourceUrl(resource.url)} target="_blank" rel="noreferrer">{(text(resource.title)||'学习资料')+(text(resource.type).includes('搜索')?'（搜索入口）':'')} ↗ </a>:null)}{!!step.prerequisiteStepIds?.length&&<small>前置：{step.prerequisiteStepIds.map((id:string)=>steps.find(item=>item.id===id)?.title||id).join('、')}</small>}</article>)}</div>{invalidSelection&&<p role="alert" className="wtc-error">{dependencyMissing?'请同时选择必要的前置步骤。':'请至少选择 3 个步骤。'}</p>}{array(learning.warnings).map((warning,index)=><p key={index} className="wtc-note">{({task_definition_only:'方案基于你的工作描述生成，尚未核验外部事实资料。',provider_context_truncated:'任务说明已精简后送入工作流，请核对关键条件是否保留。',sources_supplied_without_citation_binding:'来源已带入生成，但尚未逐条关联到知识技能点；可以和 Tutor 继续核对。',provider_step_count_mismatch:'工作流返回的步骤数量有所调整，请按实际步骤检查方案是否完整。'} as Record<string,string>)[text(warning.code)]||text(warning.message)}</p>)}</>}
            {design&&<><p>{text(design.question)||text(design.objective)}</p>{design.applicability?.boundary&&<p className="wtc-note">演练边界：{text(design.applicability.boundary)}</p>}{[...array(design.acceptance_review),...array(design.constraint_review)].some(item=>item.status==='requires_domain_review')&&<details><summary>需要专业核对的工作要求</summary><ul>{[...array(design.acceptance_review),...array(design.constraint_review)].filter(item=>item.status==='requires_domain_review').map((item,index)=><li key={index}>{text(item.requirement)}</li>)}</ul><p>这些要求尚未由当前演练的自动验收覆盖。</p></details>}<ol className="wtc-stages">{array(design.stages||design.proposed_phases).map((stage,index)=><li key={index}><strong>{text(stage.title)}</strong><p>{text(stage.objective)||text(stage.target_deliverable)}</p>{stage.independent_validation&&<small>使用新材料独立验收，阶段提示关闭。</small>}</li>)}</ol>{reviewOnly?<><h3>还需补齐</h3><ul>{(design.missing_validation||[]).map((item:string)=><li key={item}>{item}</li>)}</ul><p>{text(design.next_action)}</p></>:<details><summary>环境、交付与初始文件</summary><p>{typeof design.environment==='object'?Object.values(design.environment||{}).map(strings).filter(Boolean).join('；'):text(design.environment)}</p><p>{strings(design.deliverables)}</p><ul>{array(design.starter_files).map((file,index)=><li key={index}><code>{text(file.path)}</code></li>)}</ul><p>使用 LearnFlow 0.3.0 或更新版本，在客户端选择目录并确认导入，之后再开始操作。</p></details>}</>}
            <div className="wtc-handoff"><h3>从这里继续</h3><label>讨论的位置<select value={projectId} disabled={locked} onChange={event=>setProjectId(event.target.value)}><option value="">新的 Tutor 对话</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><div className="wtc-buttons"><button disabled={locked||changed||invalidSelection} onClick={()=>handoff('discuss')}>带上来源，继续和 Tutor 讨论</button>{learning&&<button className="wtc-primary" disabled={locked||changed||invalidSelection} onClick={()=>handoff('create_project')}>确认并创建学习项目 →</button>}{design&&!reviewOnly&&<button className="wtc-primary" disabled={locked||changed} onClick={()=>handoff('desktop')}>确认方案并打开客户端 ↗</button>}</div>{desktopLink&&<div className="wtc-note"><p>接续链接已准备好。客户端没有打开时，可在安装后再次点击；导入前会预览项目并选择目录。</p><a href={desktopLink}>再次打开 LearnFlow 客户端 ↗</a>{desktopExpiry&&<small>链接有效期至 {new Date(desktopExpiry).toLocaleString()}</small>}<button disabled={locked} onClick={()=>{keys.current.clear();handoff('desktop')}}>重新获取接续链接</button></div>}<small>确认前不会创建正式项目。生成方案和操作记录不代表已掌握。</small></div>
          </section>}
        </>}
      </div>
    </main>
  </div>
}
