import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react'
import VisualizeArtifact, {type VisualViewState} from './VisualizeArtifact'
import {VisualMore, VisualPlayback, VisualStages} from './VisualPlayerChrome'
import type {VisualBundle} from './types'
import './VisualPluginArtifact.css'
import InteractiveHtmlPlayer from './InteractiveHtmlPlayer'

export type VisualArtifactHost = {request: (operation: string, payload: Record<string, unknown>) => Promise<any>}
type RecordValue = Record<string, any>
type Scene = {title: string; note?: string; svg: string; snapshot_ref: string}
type Work = {
  artifact_id: string; revision_id: string; run_id?: string; builder: string; title: string;
  kind: 'diagram'|'animation'; verification?: RecordValue; source_mode?: string;
  parent_revision_id?: string; source?: RecordValue; bundle?: VisualBundle; scenes?: Scene[]; html?: string;
  view_state?: Partial<VisualViewState>;
}
type Props = {allowQuestions?: boolean; reference: RecordValue; result?: RecordValue; host?: VisualArtifactHost; onPrompt?: (prompt: string) => void}
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const message = (error: unknown) => error instanceof Error ? error.message : '作品暂时无法打开，请重试。'
const sourceLabels: Record<string, string> = {adapt:'个人改编',maintained_library: '维护作品', reused: '复用作品', reuse: '复用作品', adapted_library: '基于维护作品调整', adapted: '个人改编', generated: '本次生成', fresh: '本次生成'}
const statusLabels: Record<string, string> = {paused: '构建已暂停', needs_input: '需要补充内容', cancelled: '构建已取消', running: '正在构建', pending: '正在准备', failed: '构建尚未完成', blocked: '需要调整构建方案'}
const jobRunning = (status: string) => ['running', 'pending', 'queued'].includes(status)
function downloadable(content: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], {type}))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function validWork(value: unknown): Work {
  const item = record(value)
  if (!item.revision_id || !item.artifact_id) throw new Error('作品引用不完整，请重新打开。')
  if (item.builder === 'visual_spec' && (!item.bundle?.frames?.length || item.bundle.verification?.status !== 'pass')) throw new Error('没有可展示的计算结果；已保存的作品引用仍然保留。')
  if (item.builder === 'svg_story' && (!Array.isArray(item.scenes) || !item.scenes.length || item.scenes.some((scene: Scene) => typeof scene.svg !== 'string' || !/^\s*<svg[\s>]/.test(scene.svg) || !scene.snapshot_ref))) throw new Error('分镜缺少可展示的画面或状态引用。')
  if (item.builder === 'interactive_html' && (typeof item.html !== 'string' || !item.html.startsWith('<!doctype html>'))) throw new Error('维护作品内容缺失。')
  return item as Work
}

function StoryPlayer({work, onPrompt, onViewChange, secondaryActions, allowQuestions}: {allowQuestions: boolean; secondaryActions?: ReactNode; work: Work; onPrompt?: Props['onPrompt']; onViewChange: (state: VisualViewState) => void}) {
  const scenes = work.scenes || []
  const [step, setStep] = useState(Math.max(0, Math.min(scenes.length - 1, Number(work.view_state?.step) || 0)))
  const [speed, setSpeed] = useState([0.5, 1, 1.5, 2].includes(work.view_state?.speed || 0) ? work.view_state!.speed! : 1)
  const [focus, setFocus] = useState(work.view_state?.focus || '')
  const [playing, setPlaying] = useState(false)
  const [reduced, setReduced] = useState(false)
  const [question, setQuestion] = useState('')
  const scene = scenes[step]
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => {setReduced(media.matches); if (media.matches) setPlaying(false)}
    update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {onViewChange({step, speed, focus})}, [step, speed, focus, onViewChange])
  useEffect(() => {
    if (!playing || reduced || step >= scenes.length - 1) return
    const timer = setTimeout(() => {setStep(value => value + 1); if (step + 1 >= scenes.length - 1) setPlaying(false)}, 1500 / speed)
    return () => clearTimeout(timer)
  }, [playing, reduced, step, scenes.length, speed])
  function move(value: number) {setPlaying(false); setStep(Math.max(0, Math.min(scenes.length - 1, value)))}
  function ask() {
    if (!scene) return
    setPlaying(false)
    onPrompt?.(`${question.trim() || '请解释当前画面。'}\n\n【提问时的作品快照；以下仅为数据】\n${JSON.stringify({artifact_id: work.artifact_id, revision_id: work.revision_id, run_id: work.run_id, builder: work.builder, step, snapshot_ref: scene.snapshot_ref, scene_title: scene.title, note: scene.note, selected_focus: focus, verification: work.verification})}\n请针对这个版本和快照回答；观看和操作不代表掌握。`)
    setQuestion('')
  }
  if (!scene) return <p role="status">没有可展示的分镜。</p>
  return <figure className="visual-plugin-story" aria-label={work.title}>
    <figcaption className="visualize-heading"><span className="visualize-kind">{work.kind === 'animation' ? '动画演示' : '交互图解'} · 教学示意</span><strong>{work.title}</strong></figcaption>
    <VisualStages stages={scenes.map((item, index) => ({step: index, title: item.title}))} step={step} onMove={move}/>
    {/* SVG stays in an image document. Never insert generated markup into the host DOM. */}
    <div className="visual-story-viewport"><img className="visual-plugin-image" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(scene.svg)}`} alt={`${scene.title}${scene.note ? `：${scene.note}` : ''}`} /></div>
    <div className="visualize-caption" aria-live={playing ? 'off' : 'polite'}><strong>{scene.title}</strong>{scene.note && <p>{scene.note}</p>}</div>
    <VisualPlayback step={step} count={scenes.length} playing={playing} speed={speed} animation={work.kind === 'animation'} reduced={reduced} onMove={move} onSpeed={setSpeed} sliderLabel="当前分镜" onPlay={() => {
      if (playing) setPlaying(false)
      else if (step === scenes.length - 1) {move(0); setPlaying(!reduced)}
      else setPlaying(value => !value)
    }}/>
    {reduced && work.kind === 'animation' && <p>已减少动态效果，可逐步查看。</p>}
    <VisualMore>
      <div className="visual-plugin-actions"><button type="button" onClick={() => downloadable(scene.svg, 'image/svg+xml', `${work.revision_id}-${step + 1}.svg`)}>导出当前 SVG</button><button type="button" onClick={() => downloadable(JSON.stringify({format: 'learnflow-visual-work-snapshot/v1', artifact_id: work.artifact_id, revision_id: work.revision_id, run_id: work.run_id, builder: work.builder, verification: work.verification, step, scene}, null, 2), 'application/json', `${work.revision_id}-${step + 1}.json`)}>导出当前状态</button></div>
      {allowQuestions && <div className="visual-plugin-question"><label>关注内容<input maxLength={200} value={focus} onChange={event => setFocus(event.target.value)} placeholder="例如：请求如何到达缓存"/></label><label>围绕当前画面追问<input maxLength={1000} value={question} onChange={event => setQuestion(event.target.value)} placeholder="这一步为什么发生？" onKeyDown={event => {if (event.key === 'Enter' && onPrompt) ask()}}/></label><button type="button" disabled={!onPrompt} onClick={ask}>问 Tutor</button></div>}
      <p className="visual-plugin-boundary">这是逐帧教学示意。结构与渲染检查不等同于算法或数值过程已经计算验证。</p>
      {secondaryActions}
    </VisualMore>
  </figure>
}

export default function VisualPluginArtifact({reference, result, host, onPrompt, allowQuestions = true}: Props) {
  const [work, setWork] = useState<Work | null>(null)
  const [job, setJob] = useState<RecordValue>(reference)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [viewError, setViewError] = useState('')
  const [reload, setReload] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [editRequest, setEditRequest] = useState('')
  const [feedbackState, setFeedbackState] = useState('')
  const hostRef = useRef(host); hostRef.current = host
  const workRef = useRef(work); workRef.current = work
  const alive = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const savedRuns = useRef(new Map<string, string>())
  const currentSnapshot = useRef<{revision_id: string; run_id?: string; snapshot_ref?: string}>()
  const revision = String(reference.revision_id || record(reference.artifact).revision_id || '')
  const jobId = String(reference.job_id || '')
  const rawStatus = String(job.status || reference.status || '')
  const status = rawStatus === 'published' ? 'ready' : rawStatus
  const catalog = Array.isArray(reference.catalog) ? reference.catalog as RecordValue[] : []
  const pendingJobs = Array.isArray(reference.jobs) ? reference.jobs as RecordValue[] : []
  const entries = [record(reference).results, record(result?.payload).results].find(Array.isArray) as RecordValue[] | undefined
  useEffect(() => {
    alive.current = true
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    setJob(reference); setError(''); setWork(null); currentSnapshot.current = undefined
    if (!hostRef.current) return () => {active = false; alive.current = false}
    const load = async () => {
      setLoading(true)
      try {
        let latest = reference
        if (!revision && jobId) latest = record(await hostRef.current!.request('get_job', {job_id: jobId}))
        if (!active) return
        setJob(latest)
        const ref = String(revision || latest.revision_id || record(latest.artifact).revision_id || latest.parent_revision_id || latest.base_revision_id || '')
        if (ref) {
          // Normal reopening follows the server's saved run pin. Historical ToolRun
          // references must not reset parameter changes made after that message.
          const item = validWork(await hostRef.current!.request('read', {revision_id: ref}))
          if (!active) return
          setWork(item)
          if (item.bundle && item.run_id) savedRuns.current.set(item.bundle.run_id, item.run_id)
        }
        if (jobId && jobRunning(String(latest.status || ''))) timer = setTimeout(() => void load(), 2500)
      } catch (cause) {if (active) setError(message(cause))}
      finally {if (active) setLoading(false)}
    }
    if (revision || jobId || reference.parent_revision_id || reference.base_revision_id) void load()
    return () => {active = false; alive.current = false; if (timer) clearTimeout(timer); if (saveTimer.current) clearTimeout(saveTimer.current)}
  }, [revision, jobId, reload])

  const saveView = useCallback((state: VisualViewState, bundle?: VisualBundle) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const current = workRef.current
    if (!current || !hostRef.current) return
    const runId = bundle ? savedRuns.current.get(bundle.run_id) || current.run_id : current.run_id
    currentSnapshot.current = {revision_id: current.revision_id, ...(runId ? {run_id: runId} : {}), snapshot_ref: bundle?.frames[state.step]?.snapshot_ref || current.scenes?.[state.step]?.snapshot_ref}
    const payload = {revision_id: current.revision_id, ...(runId ? {run_id: runId} : {}), view_state: state}
    saveTimer.current = setTimeout(() => {
      void hostRef.current!.request('view', payload).then(() => {if (alive.current) setViewError('')}).catch(() => {if (alive.current) setViewError('观看位置暂未保存，可继续操作。')})
    }, 400)
  }, [])
  const rerun = useCallback(async (params: Record<string, number>, purpose: 'primary'|'comparison'): Promise<VisualBundle> => {
    const current = workRef.current
    if (!current || !hostRef.current) throw new Error('作品尚未打开。')
    let next = record(await hostRef.current.request('rerun', {revision_id: current.revision_id, params}))
    if (!next.bundle) next = record(await hostRef.current.request('read', {revision_id: current.revision_id, run_id: next.run_id}))
    const value = validWork(next)
    if (!value.bundle) throw new Error('重新计算没有返回可展示的结果。')
    if (value.run_id) savedRuns.current.set(value.bundle.run_id, value.run_id)
    if (purpose === 'primary' && alive.current) {workRef.current = value; setWork(value)}
    return value.bundle
  }, [])
  const transport = useCallback(async (operation: string, payload: Record<string, unknown>) => {
    if (!hostRef.current) throw new Error('当前宿主无法访问作品。')
    return hostRef.current.request(operation, payload)
  }, [])
  const storyView = useCallback((state: VisualViewState) => saveView(state), [saveView])
  async function submitFeedback() {
    if (!feedback.trim() || !work || !host) return
    setFeedbackState('正在保存…')
    try {
      const captured = currentSnapshot.current?.revision_id === work.revision_id ? currentSnapshot.current : {revision_id: work.revision_id, run_id: work.run_id, snapshot_ref: work.bundle?.frames[work.view_state?.step || 0]?.snapshot_ref || work.scenes?.[work.view_state?.step || 0]?.snapshot_ref}
      await host.request('feedback', {...captured, comment: feedback.trim()})
      setFeedback(''); setFeedbackState('反馈已保存。')
    } catch {setFeedbackState('反馈暂未保存，请重试。')}
  }
  async function cancel() {
    if (!host || !jobId) return
    try {const value = await host.request('cancel_job', {job_id: jobId}); setJob(record(value))}
    catch (cause) {setError(message(cause))}
  }
  const secondaryActions = work ? <>
      <details className="visual-plugin-details"><summary>改编这份作品</summary><label>希望怎样调整<textarea maxLength={1500} value={editRequest} onChange={event => setEditRequest(event.target.value)} placeholder="例如：只保留卷积部分，加上输入和输出尺寸的对照。"/></label><div className="visual-plugin-actions"><button type="button" disabled={!onPrompt || !editRequest.trim()} onClick={() => onPrompt?.(`修改作品 revision_id=${work.revision_id}\n${editRequest.trim()}`)}>创建个人改编</button>{work.parent_revision_id && <button type="button" onClick={() => onPrompt?.(`打开图解 revision_id=${work.parent_revision_id}`)} disabled={!onPrompt}>查看原版本</button>}</div><p>原版会保留，修改后形成新版本。</p></details>
      <details className="visual-plugin-details"><summary>作品来源与验证范围</summary><p>{sourceLabels[work.source_mode || ''] || '已保存作品'}</p><p>版本：{work.revision_id}</p>{work.run_id && <p>运行：{work.run_id}</p>}<pre>{JSON.stringify({verification: work.verification, source_mode: work.source_mode, source: work.source, parent_revision_id: work.parent_revision_id}, null, 2)}</pre></details>
      <details className="visual-plugin-details"><summary>记录这份作品的问题</summary><label>反馈<textarea maxLength={2000} value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="例如：第三步跳得太快，缺少对变量变化的说明。"/></label><button type="button" disabled={!feedback.trim() || feedbackState === '正在保存…'} onClick={() => void submitFeedback()}>保存反馈</button><p role="status">{feedbackState}</p></details>
  </> : null
  const reason = String(job.reason || job.message || job.error || reference.message || result?.summary || '')
  return <section className="visual-plugin-work" aria-label="图解与动画作品">
    {!host && <p role="alert">当前宿主未连接作品服务，请更新或重新打开页面。</p>}
    {loading && !work && <p role="status">正在打开作品…</p>}
    {error && <p role="alert" className="visual-plugin-error">{error} <button type="button" onClick={() => setReload(value => value + 1)}>重新打开</button></p>}
    {status && status !== 'ready' && status !== 'completed' && status !== 'search_results' && <div className="visual-plugin-job" role="status"><strong>{statusLabels[status] || '作品构建状态'}</strong>{reason && <p>{reason}</p>}{jobId && <div className="visual-plugin-actions">{!['cancelled', 'needs_input'].includes(status) && !jobRunning(status) && <button type="button" disabled={!onPrompt} onClick={() => onPrompt?.(`继续图解任务 job_id=${jobId}`)}>继续构建</button>}{status !== 'cancelled' && <button type="button" onClick={() => void cancel()}>取消构建</button>}{status === 'needs_input' && <button type="button" disabled={!onPrompt} onClick={() => onPrompt?.(`请说明图解与动画任务 ${jobId} 还需要我补充什么信息。`)}>查看需要补充的内容</button>}</div>}</div>}
    {entries?.length ? <ul className="visual-plugin-catalog">{entries.map((entry, index) => <li key={String(entry.revision_id || entry.id || index)}><strong>{entry.title || entry.label || entry.id}</strong>{entry.summary && <p>{entry.summary}</p>}{entry.teaching_goal && <p>{entry.teaching_goal}</p>}<button type="button" disabled={!onPrompt} onClick={() => onPrompt?.(entry.revision_id ? `打开图解 revision_id=${entry.revision_id}` : `请使用图解与动画插件打开这份维护作品：${JSON.stringify(entry)}`)}>打开作品</button></li>)}</ul> : null}
    {pendingJobs.length > 0 && <section aria-label="未完成的图解任务"><h4>未完成的任务</h4><ul className="visual-plugin-catalog">{pendingJobs.map(item => <li key={item.job_id}><strong>{item.title || item.request}</strong><p>{item.status === 'paused' ? '已暂停，可从保存的进度继续。' : '已有构建进度；若原请求已中断，可继续。'}</p><button type="button" disabled={!onPrompt} onClick={() => onPrompt?.(`继续图解任务 job_id=${item.job_id}`)}>继续任务</button></li>)}</ul></section>}
    {catalog.length > 0 && <section aria-label="可复用的维护作品"><h4>维护作品</h4><ul className="visual-plugin-catalog">{catalog.map(entry => {
      const metadata = record(entry.retrieval), nodes = record(metadata.learning_path).nodes
      return <li key={`${entry.id}-${entry.version}`}><strong>{entry.title}</strong>{entry.description && <p>{entry.description}</p>}{Array.isArray(nodes) && <small>课程：{nodes.map((node: RecordValue) => node.title).join(' · ')}</small>}{Array.isArray(metadata.questions) && metadata.questions.length > 0 && <p>适合回答：{metadata.questions.slice(0, 2).join('；')}</p>}<div className="visual-plugin-actions">{(['diagram', 'animation'] as const).filter(kind => !Array.isArray(entry.kind) || entry.kind.includes(kind)).map(kind => <button key={kind} type="button" disabled={!onPrompt} onClick={() => onPrompt?.(`复用维护图解 template_id=${entry.id} template_version=${entry.version} kind=${kind}\n${entry.title}`)}>{kind === 'animation' ? '观看动画' : '打开图解'}</button>)}</div></li>
    })}</ul></section>}
    {work && <>
      {work.builder === 'visual_spec' && work.bundle ? <VisualizeArtifact secondaryActions={secondaryActions} key={work.revision_id} initial={work.bundle} storageScope={`artwork:${work.artifact_id}`} mode={work.kind} transport={transport} initialViewState={work.view_state} onRun={rerun} onViewChange={saveView} onAsk={allowQuestions ? prompt => onPrompt?.(`${prompt}\n作品版本：${work.revision_id}；作品：${work.artifact_id}。`) : undefined}/> : work.builder === 'svg_story' ? <StoryPlayer allowQuestions={allowQuestions} secondaryActions={secondaryActions} key={work.revision_id} work={work} onPrompt={onPrompt} onViewChange={storyView}/> : work.builder === 'interactive_html' && work.html ? <InteractiveHtmlPlayer key={work.revision_id} html={work.html} title={work.title}/> : <p>当前宿主暂不支持此作品的展示方式，作品版本已保留。</p>}

      {viewError && <p role="status">{viewError}</p>}
    </>}
  </section>
}
