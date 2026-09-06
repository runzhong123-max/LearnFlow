import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { loadFormalProject, type FormalLearningFileRef, type FormalLearningTask } from './formal-runtime'
import type { FormalProjectCheckpoint, FormalProjectWorkspace } from './project'
import ProjectContextPanel from './ProjectContextPanel'
import ProjectFileWorkbench, { type FileSelection } from './ProjectFileWorkbench'
import {
  deliverProjectMilestone, initializeProjectWorkflow, listPracticeCases, loadPracticeCase, loadProjectWorkflow,
  saveProjectReading, saveProjectWorkbench, workbenchActionId, validatePracticeCase, requestMilestoneHint,
  type ArtifactReference, type PracticeCaseSummary, type ProjectPaper, type ProjectWorkflow, type WorkbenchState, type WorkflowMilestone,
} from './project-workbench-api'
import './project-workbench.css'
import { validateLocalWorkCaseCandidate } from '../plugins/learning_task_conversion/work-case'

const SourceFilePage = lazy(() => import('./SourceFilePage'))
const LectureFilePage = lazy(() => import('./LectureFilePage'))
const PracticeFilePage = lazy(() => import('./PracticeFilePage'))
const MarkdownContent = lazy(() => import('./MarkdownContent'))
const modeLabels = { learning: '学习型项目', experiment: '实验型项目', practice: '实践型项目' }
const paperLabels = { note: '笔记', question: '问题', hypothesis: '假设', reflection: '复盘' }
const initialWorkbench: WorkbenchState = { active_tab: 'overview', papers: [], open_files: [], delivery_drafts: {} }
export type ProjectWorkbenchSelection = FileSelection & { workspace: FormalProjectWorkspace; checkpoint?: FormalProjectCheckpoint }
type Props = {
  projectId: number
  onOpenTutor: (workspace: FormalProjectWorkspace) => void
  onOpenCheckpoint: (workspace: FormalProjectWorkspace, checkpoint: FormalProjectCheckpoint) => void
  onOpenFree: (workspace: FormalProjectWorkspace, session: { session_id: number; title: string }) => void
  onOpenFile: (file: FormalLearningFileRef) => void
  onGenerateFiles: (task: FormalLearningTask) => Promise<void>
  onPrepareTutor?: (workspace: FormalProjectWorkspace, checkpoint?: FormalProjectCheckpoint) => void
  renderTutor?: (workspace: FormalProjectWorkspace, checkpoint?: FormalProjectCheckpoint) => ReactNode
  onAskSelection?: (selection: ProjectWorkbenchSelection) => void
  onOpenReview?: () => void
  onWorkspaceChange?: (workspace: FormalProjectWorkspace) => void
  onDirtyChange?: (dirty: boolean) => void
}

function SubmissionForm({ milestone, artifactRefs, onRemoveArtifact, onSubmit, busy, draft, onDraft }: {
  milestone: WorkflowMilestone; artifactRefs: ArtifactReference[]; onRemoveArtifact: (index: number) => void
  onSubmit: (answers: Record<string, string>, assistance: string) => Promise<void>; busy: boolean
  draft?: { answers: Record<string, string>; assistance_level: string }; onDraft: (answers: Record<string, string>, assistance: string) => void
}) {
  const answers = draft?.answers || milestone.submission?.answers || {}
  const assistance = draft?.assistance_level || milestone.submission?.assistance_level || 'independent'
  const setAnswers = (update: (previous: Record<string, string>) => Record<string, string>) => onDraft(update(answers), assistance)
  const setAssistance = (value: string) => onDraft(answers, value)
  const feedback = milestone.submission?.feedback
  return <form className="pw-submission" onSubmit={event => { event.preventDefault(); void onSubmit(answers, assistance) }}>
    <header><span>DELIVER & REFLECT</span><h2>交付本阶段</h2><p>把过程说清楚，并附上可定位的产物。</p></header>
    {milestone.fields.map(field => <label key={field.key}><span>{field.label}</span>{field.kind === 'text' ? <input value={answers[field.key] || ''} placeholder={field.placeholder} onChange={event => setAnswers(previous => ({ ...previous, [field.key]: event.target.value }))} /> : <textarea value={answers[field.key] || ''} placeholder={field.placeholder} onChange={event => setAnswers(previous => ({ ...previous, [field.key]: event.target.value }))} />}</label>)}
    <div className="pw-delivery-artifacts"><strong>附上的产物{milestone.required_artifacts ? ' · 必填' : ' · 可选'}</strong>{artifactRefs.map((ref, index) => <div key={`${ref.kind}:${ref.ref}`}><code>{ref.kind} · {ref.ref}{ref.revision ? ` @ ${ref.revision.slice(0, 10)}` : ''}</code><button type="button" aria-label={`移除产物 ${ref.ref}`} onClick={() => onRemoveArtifact(index)}>×</button></div>)}{!artifactRefs.length && <p>在文件、运行记录或资料上点击“加入交付”。</p>}</div>
    <label><span>这次完成时的帮助程度</span><select value={assistance} onChange={event => setAssistance(event.target.value)}><option value="independent">独立完成</option><option value="hint">用过提示</option><option value="together">和导师一起完成</option><option value="demonstrated">参照了完整示范</option></select></label>
    <button className="pw-primary" disabled={busy || milestone.status === 'accepted' || (milestone.required_artifacts && !artifactRefs.length)}>{busy ? '正在核对交付…' : milestone.status === 'accepted' ? '交付已通过' : '提交并查看反馈'}</button>
    {feedback && <div className={`pw-feedback ${feedback.accepted ? 'accepted' : ''}`} role="status"><strong>{feedback.summary}</strong><ul>{feedback.checks.map(check => <li key={check.key}><span>{check.passed ? '✓' : '○'} {check.label}</span><p>{check.detail}</p></li>)}</ul>{feedback.review_required && <p>解释与设计质量仍需导师评审。</p>}<small>阶段交付通过与知识掌握分别记录。</small></div>}
  </form>
}

export default function ProjectWorkspacePage(props: Props) {
  const { projectId, onOpenTutor, onOpenCheckpoint, onOpenFree, onOpenFile, onGenerateFiles, onPrepareTutor, renderTutor, onAskSelection, onOpenReview, onWorkspaceChange, onDirtyChange } = props
  const [workspace, setWorkspace] = useState<FormalProjectWorkspace>()
  const [workflow, setWorkflow] = useState<ProjectWorkflow>()
  const [workbench, setWorkbench] = useState<WorkbenchState>(initialWorkbench)
  const [cases, setCases] = useState<PracticeCaseSummary[]>([])
  const [selectedCase, setSelectedCase] = useState('')
  const [starterFiles, setStarterFiles] = useState<Array<{ path: string; content: string }>>([])
  const [resourcesOpen, setResourcesOpen] = useState(false)
  const [tutorOpen, setTutorOpen] = useState(true)
  const [artifacts, setArtifacts] = useState<Record<number, ArtifactReference[]>>({})
  const [busy, setBusy] = useState('')
  const [saveStatus, setSaveStatus] = useState('已恢复')
  const [error, setError] = useState('')
  const [sourceNote, setSourceNote] = useState('')
  const workflowRef = useRef<ProjectWorkflow>()
  const localRef = useRef<WorkbenchState>(initialWorkbench)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const contentRef = useRef<HTMLDivElement>(null)
  const preparedScope = useRef('')
  const acceptWorkflow = (next: ProjectWorkflow) => { workflowRef.current = next; setWorkflow(next) }
  const refreshProject = async () => { const next = await loadFormalProject(projectId); setWorkspace(next); onWorkspaceChange?.(next); return next }
  const persistNow = () => {
    clearTimeout(saveTimer.current); saveTimer.current = undefined
    const snapshot = { ...localRef.current, papers: localRef.current.papers.map(paper => ({ ...paper, title: paper.title.trim() || paperLabels[paper.kind] })) }
    const localSnapshot = localRef.current
    const task = saveQueue.current.catch(() => undefined).then(async () => {
      if (!workflowRef.current) return
      const next = await saveProjectWorkbench(projectId, workflowRef.current.revision, snapshot)
      acceptWorkflow(next); setSaveStatus(localRef.current === localSnapshot ? '已保存' : '正在保存…')
    })
    saveQueue.current = task
    task.catch(failure => { setSaveStatus('保存失败 · 草稿仍在'); setError(`${failure.message}。可重试保存；若其他窗口有更新，请先保留当前草稿。`) })
    return task
  }
  const mutateWorkflow = async (operation: () => Promise<ProjectWorkflow>) => {
    await persistNow()
    const pending = saveQueue.current.catch(() => undefined).then(operation).then(next => { acceptWorkflow(next); return next })
    saveQueue.current = pending
    return pending
  }
  useEffect(() => {
    let live = true
    setWorkspace(undefined); setWorkflow(undefined); setError(''); preparedScope.current = ''
    void Promise.all([loadFormalProject(projectId), loadProjectWorkflow(projectId)]).then(([project, state]) => {
      if (!live) return
      setWorkspace(project); onWorkspaceChange?.(project); acceptWorkflow(state)
      localRef.current = { ...initialWorkbench, ...state.workbench }; setWorkbench(localRef.current)
      const refs: Record<number, ArtifactReference[]> = {}
      state.milestones.forEach(milestone => { refs[milestone.checkpoint_id] = state.workbench.delivery_drafts?.[milestone.checkpoint_id]?.artifact_refs || milestone.submission?.artifact_refs || [] })
      setArtifacts(refs)
      if (state.project_mode === 'practice' && !state.initialized) void listPracticeCases().then(result => live && setCases(result.cases)).catch(failure => live && setError(failure.message))
    }).catch(failure => live && setError(failure instanceof Error ? failure.message : '项目读取失败'))
    return () => { live = false; if (saveTimer.current) { clearTimeout(saveTimer.current); void persistNow() } }
  }, [projectId])
  useEffect(() => {
    let live = true
    setStarterFiles([])
    if (workflow?.case_ref) void loadPracticeCase(workflow.case_ref.id).then(result => {
      if (!live) return
      if (result.root_hash !== workflow.case_ref!.root_hash) { setError('案例版本已变化，暂停读取初始文件。'); return }
      setStarterFiles(result.starter_files)
    }).catch(failure => live && setError(failure.message))
    return () => { live = false }
  }, [workflow?.case_ref?.id, workflow?.case_ref?.root_hash])
  const changeWorkbench = (patch: Partial<WorkbenchState>) => {
    const next = { ...localRef.current, ...patch }; localRef.current = next; setWorkbench(next); setSaveStatus('正在保存…')
    clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => { void persistNow() }, 650)
  }
  const currentCheckpoint = workspace?.roadmap.checkpoints.find(checkpoint => checkpoint.id === workbench.active_checkpoint_id)
  const milestone = workflow?.milestones.find(item => item.checkpoint_id === currentCheckpoint?.id)
  useEffect(() => {
    if (!workspace) return
    const scope = `${workspace.project.id}:${currentCheckpoint?.id || 0}`
    if (preparedScope.current === scope) return
    preparedScope.current = scope; onPrepareTutor?.(workspace, currentCheckpoint)
  }, [workspace, currentCheckpoint?.id, onPrepareTutor])
  const action = async (name: string, operation: () => Promise<void>) => {
    setBusy(name); setError('')
    try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败') } finally { setBusy('') }
  }
  const ask = (selection: FileSelection) => { if (workspace) { setTutorOpen(true); onAskSelection?.({ ...selection, workspace, checkpoint: currentCheckpoint }) } }
  const askSelectedMaterial = () => {
    const selection = window.getSelection()
    if (!selection?.toString().trim() || !selection.anchorNode || !contentRef.current?.contains(selection.anchorNode)) { setError('先在当前材料中选中文字，再打开提问纸。'); return }
    ask({ title: currentCheckpoint?.title || workspace?.project.name || '材料追问', text: selection.toString() })
  }
  const addPaper = (kind: ProjectPaper['kind']) => {
    const paper: ProjectPaper = { id: workbenchActionId('paper'), kind, title: `${paperLabels[kind]} · ${workbench.papers.length + 1}`, body: kind === 'hypothesis' ? '我的问题：\n\n我的预测：\n\n最小实验与控制条件：\n\n观察到的结果：\n\n解释与下一步：\n' : kind === 'reflection' ? '我完成了什么：\n\n我做过的关键选择：\n\n证据与不足：\n\n下次独立尝试：\n' : '' }
    changeWorkbench({ papers: [...workbench.papers, paper], active_paper_id: paper.id, active_tab: 'papers' })
  }
  const addArtifact = (ref: ArtifactReference) => {
    if (!currentCheckpoint) { setError('先从左侧选一个阶段，再把产物加入这一阶段的交付。'); return }
    const refs = [...(artifacts[currentCheckpoint.id] || []).filter(item => !(item.kind === ref.kind && item.ref === ref.ref)), ref]
    setArtifacts(previous => ({ ...previous, [currentCheckpoint.id]: refs }))
    const draft = workbench.delivery_drafts?.[currentCheckpoint.id] || { answers: milestone?.submission?.answers || {}, artifact_refs: [], assistance_level: 'independent' }
    changeWorkbench({ delivery_drafts: { ...workbench.delivery_drafts, [currentCheckpoint.id]: { ...draft, artifact_refs: refs } } })
    setSaveStatus('已加入本阶段交付，提交后留存')
  }
  const openLearningFile = (file: FormalLearningFileRef) => { changeWorkbench({ active_tab: `${file.kind}:${file.ref}:0` }); setResourcesOpen(false) }
  const tab = workbench.active_tab || 'overview'
  const material = tab.match(/^(source|lecture|practice):(.+):(\d+)$/)
  const activePaper = workbench.papers.find(paper => paper.id === workbench.active_paper_id) || workbench.papers[0]
  const selectedSource = material?.[1] === 'source' ? workspace?.sources.find(source => source.id === Number(material[2])) : undefined
  const materialPosition = Number(material?.[3] || 0)
  const restoredReading = [...(workflow?.reading_records || [])].reverse().find(record => record.source_id === selectedSource?.id && record.source_version_id === Number(selectedSource?.active_version?.id) && record.locator === `section:${materialPosition}`)
  useEffect(() => { setSourceNote(restoredReading?.notes || '') }, [selectedSource?.id, materialPosition, restoredReading?.id])
  const changePosition = (position: number) => { if (material) changeWorkbench({ active_tab: `${material[1]}:${material[2]}:${position}` }) }
  if (!workspace || !workflow) return <section className="project-workbench"><div className="pw-empty">{error || '正在恢复项目、阶段与学习现场…'}{error && <button onClick={() => window.location.reload()}>重新加载</button>}</div></section>
  const mode = workflow.project_mode
  return <section className={`project-workbench pw-mode-${mode}`}>
    <header className="pw-heading"><div><span>{modeLabels[mode]}</span><h1>{workspace.project.name}</h1><p>{currentCheckpoint ? currentCheckpoint.title : workspace.project.objective}</p></div><div className="pw-heading-actions"><small role="status">{saveStatus}</small>{saveStatus.startsWith('保存失败') && <button onClick={() => void persistNow()}>重试保存</button>}<button onClick={() => setResourcesOpen(!resourcesOpen)}>资料与路线</button><button aria-pressed={tutorOpen} onClick={() => setTutorOpen(!tutorOpen)}>{tutorOpen ? '收起导师' : '展开导师'}</button></div></header>
    {error && <div className="pw-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
    <div className={`pw-shell${tutorOpen ? '' : ' tutor-collapsed'}`}>
      <aside className="pw-project-nav"><button className={!currentCheckpoint ? 'active' : ''} onClick={() => changeWorkbench({ active_checkpoint_id: null, active_tab: 'overview' })}>项目总览</button><div className="pw-nav-label">这段旅程</div>{workflow.milestones.length ? workflow.milestones.map((item, index) => <button className={`pw-milestone ${currentCheckpoint?.id === item.checkpoint_id ? 'active' : ''}`} key={item.checkpoint_id} onClick={() => changeWorkbench({ active_checkpoint_id: item.checkpoint_id, active_tab: 'overview' })}><i>{item.status === 'accepted' ? '✓' : item.status === 'locked' ? '◇' : String(index + 1).padStart(2, '0')}</i><span>{item.title}<small>{item.status === 'accepted' ? '交付已通过' : item.status === 'locked' ? '完成前置后开启' : '可以开始'}</small></span></button>) : workspace.roadmap.checkpoints.map(checkpoint => <button key={checkpoint.id} className={currentCheckpoint?.id === checkpoint.id ? 'active' : ''} onClick={() => changeWorkbench({ active_checkpoint_id: checkpoint.id, active_tab: 'overview' })}>{checkpoint.title}</button>)}
        <div className="pw-nav-label">边做边想</div><button onClick={() => addPaper('question')}>＋ 提一个问题</button><button onClick={() => addPaper('hypothesis')}>＋ 设计小实验</button><button onClick={() => addPaper('reflection')}>＋ 写一次复盘</button><div className="pw-nav-bottom"><button onClick={onOpenReview}>进入复习</button><button onClick={() => currentCheckpoint ? onOpenCheckpoint(workspace, currentCheckpoint) : onOpenTutor(workspace)}>独立打开导师 ↗</button></div>
      </aside>
      <main className="pw-main"><nav className="pw-main-tabs" aria-label="工作台区域"><button className={tab === 'overview' ? 'active' : ''} onClick={() => changeWorkbench({ active_tab: 'overview' })}>{mode === 'practice' ? '工作情境' : '任务与交付'}</button><button className={tab === 'files' ? 'active' : ''} onClick={() => changeWorkbench({ active_tab: 'files' })}>本地文件</button><button className={tab === 'materials' || material ? 'active' : ''} onClick={() => changeWorkbench({ active_tab: 'materials' })}>学习材料</button><button className={tab === 'papers' ? 'active' : ''} onClick={() => changeWorkbench({ active_tab: 'papers' })}>思考纸张 <small>{workbench.papers.length || ''}</small></button></nav>
        <div className="pw-main-content" ref={contentRef}>
          {tab === 'overview' && <div className="pw-overview">
            {!workflow.initialized && <div className="pw-onboarding"><span>START WITH A CLEAR QUESTION</span><h2>{mode === 'practice' ? '选择一段值得亲手经历的工作' : mode === 'experiment' ? '先定交付，再动手验证' : '把资料变成一条能走下去的路线'}</h2><p>{workspace.project.objective}</p>{mode === 'practice' ? <div className="pw-case-picker">{cases.map(item => <label className={selectedCase === item.id ? 'selected' : ''} key={item.id}><input type="radio" name="practice-case" value={item.id} checked={selectedCase === item.id} onChange={() => setSelectedCase(item.id)} /><div><strong>{item.title}</strong><p>{item.summary}</p><small>v{item.version} · 约 {item.estimated_minutes} 分钟</small><details><summary>来源与版本</summary><pre>{JSON.stringify(item.provenance, null, 2)}</pre><code>{item.root_hash}</code></details></div></label>)}{!cases.length && <p>当前尚未载入可用案例。</p>}</div> : <p className="pw-learning-loop">明确目标 → 先作预测 → 动手尝试 → 观察证据 → 解释与迁移</p>}<button className="pw-primary" disabled={!!busy || (mode === 'practice' && !selectedCase)} onClick={() => void action('initialize', async () => { const selected = cases.find(item => item.id === selectedCase); if (selected) { const checked = await validatePracticeCase(selected); validateLocalWorkCaseCandidate(checked.candidate) } const next = await mutateWorkflow(() => initializeProjectWorkflow(projectId, selected)); await refreshProject(); changeWorkbench({ active_checkpoint_id: next.milestones.find(item => item.status === 'available')?.checkpoint_id || null }) })}>{busy === 'initialize' ? '正在建立正式路线…' : '确认并建立阶段路线'}</button><small>确认后创建正式关卡与任务。已有路线会保留。</small></div>}
            {workflow.case_ref && <div className="pw-case-badge"><span>CASE {workflow.case_ref.version}</span><strong>{workflow.case_ref.title}</strong><details><summary>查看案例依据</summary><pre>{JSON.stringify(workflow.case_ref.provenance, null, 2)}</pre><code>{workflow.case_ref.root_hash}</code></details>{starterFiles.length > 0 && <details><summary>初始工程文件（{starterFiles.length}）</summary>{starterFiles.map(file => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre><button onClick={() => { const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = file.path.split('/').pop() || file.path; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }}>下载文件</button></details>)}<button onClick={() => changeWorkbench({ active_tab: 'files' })}>在桌面工程中准备文件</button></details>}</div>}
            {currentCheckpoint ? <>
              <div className="pw-task-brief"><span>{milestone?.status === 'accepted' ? 'DELIVERY ACCEPTED' : 'CURRENT MILESTONE'}</span><h2>{currentCheckpoint.title}</h2><p>{currentCheckpoint.objective}</p><div className="pw-learning-loop">先预测 <b>→</b> 动手 <b>→</b> 观察 <b>→</b> 解释 / 新实验</div></div>
              {milestone?.status === 'locked' ? <div className="pw-empty"><h3>先完成前一个阶段</h3><p>当前材料与提交入口会在满足前置交付后开放。</p></div> : <>
                {milestone && milestone.status !== 'accepted' && !!milestone.hint_levels && <div className="pw-quick-actions">{([1, 2] as const).map(level => <button key={level} disabled={!!busy} onClick={() => void action('hint', async () => { await mutateWorkflow(async () => (await requestMilestoneHint(projectId, milestone.checkpoint_id, level)).workflow) })}>{level === 1 ? '给我一个方向' : '帮我拆成小步骤'}</button>)}</div>}{milestone?.hints_used?.map(hint => <article className="pw-material-card" key={hint.level}><strong>{hint.level === 1 ? '思考方向' : '拆解提示'}</strong><p>{hint.body}</p></article>)}{milestone?.materials.map(item => <article className="pw-material-card" key={item.id}><header><h3>{item.title}</h3><button onMouseDown={event => event.preventDefault()} onClick={askSelectedMaterial}>选区提问</button></header><Suspense fallback={<p>正在渲染材料…</p>}><MarkdownContent content={item.body} /></Suspense></article>)}
                <div className="pw-quick-actions"><button onClick={() => changeWorkbench({ active_tab: mode === 'learning' ? 'materials' : 'files' })}>{mode === 'learning' ? '打开学习资料' : '打开实验工程'}</button>{currentCheckpoint.learning_task && <button disabled={!!busy} onClick={() => void action('generate', async () => { await onGenerateFiles(currentCheckpoint.learning_task!); await refreshProject(); changeWorkbench({ active_tab: 'materials' }) })}>生成本关讲义与练习</button>}<button onClick={() => addPaper('hypothesis')}>探索一个新想法</button></div>
                {milestone && <SubmissionForm key={`${milestone.checkpoint_id}`} milestone={milestone} draft={workbench.delivery_drafts?.[currentCheckpoint.id]} onDraft={(answers, assistance) => changeWorkbench({ delivery_drafts: { ...workbench.delivery_drafts, [currentCheckpoint.id]: { answers, assistance_level: assistance, artifact_refs: artifacts[currentCheckpoint.id] || [] } } })} artifactRefs={artifacts[currentCheckpoint.id] || []} onRemoveArtifact={index => { const refs = (artifacts[currentCheckpoint.id] || []).filter((_, position) => position !== index); setArtifacts(previous => ({ ...previous, [currentCheckpoint.id]: refs })); const draft = workbench.delivery_drafts?.[currentCheckpoint.id] || { answers: milestone.submission?.answers || {}, artifact_refs: [], assistance_level: 'independent' }; changeWorkbench({ delivery_drafts: { ...workbench.delivery_drafts, [currentCheckpoint.id]: { ...draft, artifact_refs: refs } } }) }} busy={!!busy} onSubmit={(answers, assistance) => action('deliver', async () => { await mutateWorkflow(() => deliverProjectMilestone(projectId, currentCheckpoint.id, answers, artifacts[currentCheckpoint.id] || [], assistance)); await refreshProject() })} />}
              </>}
            </> : <div className="pw-project-overview"><h2>这次想走到哪里？</h2><p>{workspace.project.objective}</p><div className="pw-goal-columns"><section><h3>核心交付</h3><ul>{(workflow.brief?.deliverables?.length ? workflow.brief.deliverables : [workspace.project.expected_outcome || '和导师一起确定可检查的成果']).map(item => <li key={item}>{item}</li>)}</ul></section><section><h3>可选探索</h3><p>把新问题留在假设纸里：改变一个条件，预测结果，再设计最小实验。</p><button onClick={() => addPaper('hypothesis')}>写下第一个假设</button></section></div>{workflow.initialized && <p>从左侧选择一个阶段，恢复同一个 Tutor 和正式学习任务。</p>}</div>}
          </div>}
          <div hidden={tab !== 'files'}><ProjectFileWorkbench projectId={projectId} checkpointId={currentCheckpoint?.id} openPaths={workbench.open_files} activePath={workbench.active_file} onLayout={(paths, path) => changeWorkbench({ open_files: paths, active_file: path })} onAsk={ask} onArtifact={addArtifact} onDirtyChange={onDirtyChange} starterFiles={starterFiles} /></div>
          {tab === 'materials' && <div className="pw-material-library"><header><h2>资料就在问题旁边</h2><p>阅读记录用于恢复现场；正式练习会独立记录理解与迁移。</p><button onClick={() => setResourcesOpen(true)}>添加 / 管理来源</button></header>{workspace.sources.map(source => <article key={source.id}><span>来源 · {source.status === 'processed' ? `${source.chunk_count} 个片段` : source.status}</span><strong>{source.name}</strong><div><button disabled={source.status !== 'processed'} onClick={() => { const saved = [...(workflow.reading_records || [])].reverse().find(record => record.source_id === source.id); const sameVersion = !saved || saved.source_version_id === Number(source.active_version?.id); const position = sameVersion ? saved?.locator.match(/^section:(\d+)$/)?.[1] || '0' : '0'; if (!sameVersion) setError('资料版本已更新，已从新版本开头打开；旧阅读记录保留。'); setSourceNote(sameVersion ? saved?.notes || '' : ''); changeWorkbench({ active_tab: `source:${source.id}:${position}` }) }}>继续阅读</button>{Boolean(source.active_version?.id) && <button onClick={() => addArtifact({ kind: 'source_version', ref: String(source.active_version!.id) })}>加入交付</button>}</div></article>)}{[...workspace.files.lectures, ...workspace.files.practices].filter(file => !currentCheckpoint || file.checkpoint_id === currentCheckpoint.id).map(file => <article key={`${file.kind}:${file.ref}`}><span>{file.kind === 'lecture' ? '讲义' : '正式练习'}</span><strong>{file.title}</strong><div><button onClick={() => openLearningFile(file)}>打开</button><button onClick={() => onOpenFile(file)}>独立打开 ↗</button><button onClick={() => addArtifact({ kind: 'learning_file', ref: `${file.kind}:${file.ref}` })}>加入交付</button></div></article>)}{!workspace.sources.length && !workspace.files.lectures.length && !workspace.files.practices.length && <div className="pw-empty">先添加教材或课程资料，也可以从关卡生成讲义与练习。</div>}</div>}
          {material && <div className="pw-reading"><Suspense fallback={<p>正在打开材料…</p>}>{material[1] === 'source' ? <SourceFilePage key={`${material[1]}:${material[2]}`} sourceId={Number(material[2])} embedded initialPosition={materialPosition} onPositionChange={changePosition} onFollowUp={askSelectedMaterial} /> : material[1] === 'lecture' ? <LectureFilePage key={`${material[1]}:${material[2]}`} lectureId={Number(material[2])} embedded initialPosition={materialPosition} onPositionChange={changePosition} onFollowUp={askSelectedMaterial} /> : <PracticeFilePage key={`${material[1]}:${material[2]}`} practiceRef={material[2]} embedded onFollowUp={askSelectedMaterial} />}</Suspense>{Boolean(selectedSource?.active_version?.id) && <div className="pw-reading-note"><label>读到这里，我的问题 / 解释<textarea maxLength={10000} value={sourceNote} onChange={event => setSourceNote(event.target.value)} placeholder="记下不理解的地方，或用自己的话解释本节。" /></label><button disabled={!!busy} onClick={() => void action('reading', async () => { await mutateWorkflow(() => saveProjectReading(projectId, { source_id: selectedSource!.id, source_version_id: Number(selectedSource!.active_version!.id), locator: `section:${materialPosition}`, notes: sourceNote })); setSaveStatus('阅读锚点与笔记已保存') })}>记录阅读位置</button></div>}</div>}
          {tab === 'papers' && <div className="pw-paper-desk"><aside><header><strong>我的思考</strong><button onClick={() => addPaper('note')}>＋</button></header>{workbench.papers.map(paper => <button className={activePaper?.id === paper.id ? 'active' : ''} key={paper.id} onClick={() => changeWorkbench({ active_paper_id: paper.id })}><span>{paperLabels[paper.kind]}</span>{paper.title}</button>)}</aside>{activePaper ? <article className="pw-paper"><header><span>{paperLabels[activePaper.kind]} · 自动保存</span><button onClick={() => ask({ title: activePaper.title, text: activePaper.body || activePaper.title })}>和导师讨论</button><button onClick={() => { if (confirm('删除这张思考纸？关联的文件和正式对话会保留。')) changeWorkbench({ papers: workbench.papers.filter(paper => paper.id !== activePaper.id), active_paper_id: undefined }) }}>删除</button></header><input aria-label="思考纸标题" maxLength={200} value={activePaper.title} onChange={event => changeWorkbench({ papers: workbench.papers.map(paper => paper.id === activePaper.id ? { ...paper, title: event.target.value } : paper) })} /><textarea aria-label="思考纸正文" maxLength={30000} value={activePaper.body} onChange={event => changeWorkbench({ papers: workbench.papers.map(paper => paper.id === activePaper.id ? { ...paper, body: event.target.value } : paper) })} placeholder="先写下你的想法，不必等到答案确定。" /></article> : <div className="pw-empty"><h2>给还没想明白的事留一张纸</h2><p>问题、假设、观察和复盘，随时可以交给当前导师继续讨论。</p><button onClick={() => addPaper('hypothesis')}>开始一个小实验</button></div>}</div>}
        </div>
      </main>
      {tutorOpen && <aside className="pw-tutor" aria-label="持续项目导师"><header><span>你的导师</span><small>{currentCheckpoint ? '陪你完成当前阶段' : '一起规划这段旅程'}</small></header>{renderTutor?.(workspace, currentCheckpoint) || <div className="pw-empty"><p>正在恢复正式导师会话…</p><button onClick={() => onOpenTutor(workspace)}>打开项目导师</button></div>}</aside>}
    </div>
    {resourcesOpen && <div className="pw-resources-overlay"><button className="pw-overlay-backdrop" aria-label="收起资料面板" onClick={() => setResourcesOpen(false)} /><ProjectContextPanel projectId={projectId} onClose={() => setResourcesOpen(false)} onOpenCheckpoint={(_, checkpoint) => { changeWorkbench({ active_checkpoint_id: checkpoint.id, active_tab: 'overview' }); setResourcesOpen(false) }} onOpenFree={onOpenFree} onOpenFile={openLearningFile} onGenerateFiles={onGenerateFiles} onWorkspaceChange={next => { setWorkspace(next); onWorkspaceChange?.(next) }} /></div>}
  </section>
}
