import { useState } from 'react'
import { PROJECT_MODE_CHOICES, projectGuidanceChoicePrompt } from './contract.ts'
import './project-guidance.css'

type Props = {
  objects: readonly any[]; result: { payload?: any }; isDesktopRuntime?: boolean
  onReferenceObject?: (object: any, prompt?: string) => void
  onOpenProject?: (target: { projectId: number; sessionId?: number }) => void
  onConfirmProject?: (candidate: { candidateId: string; rootHash: string }) => Promise<{ projectId: number; sessionId?: number }>
}
export function ProjectGuidanceRenderer(props: Props) {
  const object = props.objects.find(item => item.objectType === 'project_guidance')
  const value = object?.value || props.result.payload || {}
  // Revisions have independent confirmation state. A late callback updates only its unmounted card.
  return <ProjectGuidanceCard key={`${object?.objectId || ''}:${value.candidate_id || ''}:${value.root_hash || ''}`} {...props} />
}
function ProjectGuidanceCard(props: Props) {
  const object = props.objects.find(item => item.objectType === 'project_guidance')
  const value = object?.value || props.result.payload || {}
  const title = value.name || '工作任务转学习项目'
  const brief = value.project_brief || value.candidate?.project_brief || {}
  const draft = (prompt: string) => { if (object) props.onReferenceObject?.(object, prompt) }
  const confirmed = value.status === 'confirmed'
  const ready = value.status === 'ready_for_confirmation'
  const desktop = props.isDesktopRuntime === true
  const [createdProject, setCreatedProject] = useState<{ projectId: number; sessionId?: number }>()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    if (!desktop || !props.onConfirmProject || confirming || !ready) return
    setConfirming(true)
    setError('')
    try {
      const target = await props.onConfirmProject({ candidateId: value.candidate_id, rootHash: value.root_hash })
      if (!Number.isInteger(target.projectId) || target.projectId < 1) throw new Error('项目确认没有返回可用入口')
      setCreatedProject(target)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '项目创建失败，请重试') }
    finally { setConfirming(false) }
  }
  return <section className="project-guidance-card" aria-label="工作任务转学习项目">
    <header><span>{confirmed ? '项目已创建' : value.project_mode === 'experiment' ? '实验项目 · 任务书' : value.project_mode === 'practice' ? '带教实践 · 任务书' : '选择项目类型'}</span><h3>{title}</h3></header>
    {value.status === 'needs_mode_selection' ? <div className="project-guidance-choices">{PROJECT_MODE_CHOICES.map(choice =>
      <button key={choice.id} type="button" disabled={!props.onReferenceObject} onClick={() => draft(projectGuidanceChoicePrompt(choice.id, value.raw_input || '请继续明确工作任务'))}>
        <strong>{choice.label}</strong><p>{choice.description}</p><small>{choice.availability} · 填入输入框</small>
      </button>)}</div> : value.status === 'case_catalog' ? <>
        <p>先核对情境是否符合你的任务，再选择固定版本。目录没有匹配案例时可继续讨论任务书。</p>
        <div className="project-guidance-choices">{(value.case_catalog || []).map((item: any) => <button type="button" key={`${item.id}:${item.root_hash}`} disabled={!props.onReferenceObject}
          onClick={() => draft(`我选择带教案例“${item.title}”。caseId: ${item.id}，caseVersion: ${item.version}，caseRootHash: ${item.root_hash}。请结合当前任务书准备带教项目方案，暂不创建项目。`)}>
          <strong>{item.title}</strong><p>{item.summary}</p><small>固定版本 {item.version} · 填入输入框</small>
        </button>)}</div>
        {!value.case_catalog?.length && <p>当前没有可选案例。请继续与 Tutor 澄清工作情境与交付要求。</p>}
      </> : <>
      {value.objective && <p>{value.objective}</p>}
      <div className="project-guidance-brief">{[
        ['交付物', brief.deliverables], ['约束', brief.constraints], ['验收标准', brief.success_criteria],
      ].map(([label, items]) => <article key={String(label)}><strong>{String(label)}</strong>{Array.isArray(items) && items.length
        ? <ul>{items.map((item, index) => <li key={index}>{String(item)}</li>)}</ul> : <p>待澄清</p>}</article>)}</div>
      {value.missing_fields?.length > 0 && <p>下一步补充：{value.missing_fields.join('、')}。可以直接在对话中描述。</p>}
      {value.status === 'needs_case_selection' && <p>需要选择匹配的版本化带教案例。当前没有匹配案例时，请继续与 Tutor 澄清任务书。</p>}
      {ready && !createdProject && <div className="project-guidance-confirm">
        <p>方案已保存，等待你核对确认；项目尚未创建。</p>
        {desktop && props.onConfirmProject ? <button type="button" disabled={confirming} onClick={() => void confirm()}>{confirming ? '正在创建项目…' : '确认创建桌面项目'}</button>
          : <p>请在 LearnFlow 桌面端打开此对话，确认创建并执行项目。</p>}
        {error && <p role="alert">{error}</p>}
      </div>}
      {createdProject && <div className="project-guidance-confirm"><p>项目已由 LearnFlow 确认创建。</p>{props.onOpenProject && <button type="button" onClick={() => props.onOpenProject?.(createdProject)}>打开项目 Tutor →</button>}</div>}
      {confirmed && (desktop && props.onOpenProject
        ? <button type="button" onClick={() => props.onOpenProject?.({ projectId: value.project_id, ...(value.session_id ? { sessionId: value.session_id } : {}) })}>打开项目 Tutor →</button>
        : <p>项目 #{value.project_id} 已创建。请在桌面端打开项目，继续文件与阶段交付。</p>)}
    </>}
    <footer>任务书、文件和工具结果会回到同一项目 Tutor；学习成果由正式提交与验收确认。</footer>
  </section>
}
