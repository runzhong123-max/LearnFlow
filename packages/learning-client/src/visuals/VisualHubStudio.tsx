import {useEffect, useRef, useState} from 'react'
import VisualPluginArtifact from './VisualPluginArtifact'
import {artifactHostRequest, VISUAL_PLUGIN_ID} from './plugin-host.ts'
import {createVisualWork, directVisualWorkflowCall, iterateVisualWork, resumeVisualWork, type VisualWorkKind, type VisualSourceMode, type VisualWorkEnvelope} from './workflow.ts'

export type HubRequest = (action: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<any>
type Config = {base_url: string; model: string; api_key: string}
const emptyConfig: Config = {base_url: '', model: '', api_key: ''}
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

/** Credentials remain component-local; the existing workspace only receives artifact operations. */
export default function VisualHubStudio({request, active, initialRequest = '', initialKind = 'animation'}: {request: HubRequest; active: boolean; initialRequest?: string; initialKind?: VisualWorkKind}) {
  const [config, setConfig] = useState<Config>(emptyConfig)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [draft, setDraft] = useState(initialRequest)
  const [kind, setKind] = useState<VisualWorkKind>(initialKind)
  const [source, setSource] = useState<VisualSourceMode>('fresh')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [connection, setConnection] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<any[]>([])
  const [jobs, setJobs] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<Record<string, any> | null>(null)
  const controller = useRef<AbortController>()
  const alive = useRef(true)
  const running = useRef(false)
  const currentJob = useRef('')
  const canGenerate = Boolean(config.api_key.trim() && config.base_url.trim() && config.model.trim())
  useEffect(() => {
    alive.current = true
    const clearSecret = () => {setConfig(value => ({...value, api_key: ''})); controller.current?.abort()}
    window.addEventListener('pagehide', clearSecret)
    return () => {alive.current = false; controller.current?.abort(); window.removeEventListener('pagehide', clearSecret)}
  }, [])
  useEffect(() => {
    if (!active) return
    const abort = new AbortController()
    setLoading(true)
    request('workspace', {operation: 'search', payload: {query}}, abort.signal).then(result => {
      if (!abort.signal.aborted) {setItems(result.items || []); setJobs(result.jobs || [])}
    }).catch(cause => {if (!abort.signal.aborted) setError(errorText(cause))}).finally(() => {if (!abort.signal.aborted) setLoading(false)})
    return () => abort.abort()
  }, [active, query, refresh, request])

  async function workspace(operation: string, payload: Record<string, any> = {}) {
    const routed = artifactHostRequest(VISUAL_PLUGIN_ID, operation, payload)
    return request(routed.path.slice('/api/visuals/'.length), routed.body)
  }
  const rendererHost = {request: workspace, context: '', generate: async () => {throw new Error('请使用生成面板。')}}
  function changeConfig(key: keyof Config, value: string) {
    setConfig(previous => ({...previous, [key]: value})); setConnection('')
  }
  function requireConfig() {
    if (canGenerate) return true
    setSettingsOpen(true); setError('生成前请先填写自己的 Base URL、模型名称和 API Key。')
    return false
  }
  async function testConnection() {
    if (running.current || !requireConfig()) return
    running.current = true
    const abort = new AbortController(); controller.current = abort
    setTesting(true); setError(''); setConnection('正在测试…')
    try {
      await request('user-model', {operation: 'test', config: {...config}}, abort.signal)
      if (alive.current) setConnection('连接成功，可以生成。')
    } catch (cause) {if (alive.current) {setConnection(''); setError(errorText(cause))}}
    finally {running.current = false; if (alive.current) setTesting(false)}
  }
  async function run(action: 'create' | 'resume' | 'iterate', input: Record<string, any>) {
    if (running.current || !requireConfig()) return
    running.current = true
    const abort = new AbortController(); controller.current = abort
    const modelConfig = {...config} // Fixed for this run; never forwarded to checkpoint/source/context.
    currentJob.current = action === 'resume' ? input.job_id : ''
    setBusy(true); setError(''); setStage('正在准备构建…'); setSettingsOpen(false)
    const context = {
      signal: abort.signal, scope: {mode: 'visual_hub'},
      artifactHost: {
        context: '',
        request: async (operation: string, payload: Record<string, any> = {}) => {
          const value = await workspace(operation, payload)
          if (operation === 'start_job' || operation === 'get_job') currentJob.current = value.job_id
          return value
        },
        generate: async (prompt: string) => {
          if (abort.signal.aborted) throw new Error('visual_workflow_aborted')
          const value = await request('user-model', {operation: 'generate', config: modelConfig, job_id: currentJob.current, prompt}, abort.signal)
          return value.text
        },
        onStage: (_stage: string, detail: string) => {if (alive.current) setStage(detail)},
      },
    }
    try {
      const result: VisualWorkEnvelope = action === 'resume' ? await resumeVisualWork(input.job_id, context)
        : action === 'iterate' ? await iterateVisualWork({revision_id: input.revision_id, request: input.request, request_id: crypto.randomUUID()}, context)
        : await createVisualWork({request: draft.trim(), kind, source_mode: source, request_id: crypto.randomUUID()}, context)
      if (alive.current) {setSelected(result.artifact ? {...result, ...result.artifact} : result); setStage(result.status === 'ready' ? '作品已保存到我的作品。' : result.message || '构建进度已保存。')}
    } catch (cause) {if (alive.current) setError(errorText(cause))}
    finally {
      modelConfig.api_key = ''
      running.current = false
      if (alive.current) {setBusy(false); setRefresh(value => value + 1)}
    }
  }
  function onPrompt(prompt: string) {
    const call = directVisualWorkflowCall({message: prompt, kind: 'none', requestId: crypto.randomUUID()})
    if (call?.name.endsWith('__resume')) void run('resume', call.arguments)
    else if (call?.name.endsWith('__iterate')) void run('iterate', call.arguments)
    else if (call?.name.endsWith('__open')) setSelected({revision_id: (call.arguments as any).revision_id, status: 'ready'})
    else {setDraft(prompt); setStage('已放入创作要求，可调整后生成。')}
  }
  async function cancelJob(jobId: string) {
    try {await workspace('cancel_job', {job_id: jobId}); setRefresh(value => value + 1); if (selected?.job_id === jobId) setSelected(null)}
    catch (cause) {setError(errorText(cause))}
  }
  return <div hidden={!active} className="visual-hub-studio">
    <div className="visual-studio-layout">
      <div className="visual-studio-sidebar">
        <form className="visual-studio-form" onSubmit={event => {event.preventDefault(); if (draft.trim()) void run('create', {})}}>
          <h2>生成图解与动画</h2>
          <p>描述想看清的机制，再用自己的模型生成。</p>
          <label>创作要求<textarea value={draft} onChange={event => setDraft(event.target.value)} maxLength={6000} required disabled={busy || testing} placeholder="例如：用六个节点演示 Dijkstra。逐步突出选点与松弛，并显示距离变化。"/></label>
          <div className="visual-studio-options"><label>作品形式<select value={kind} onChange={e => setKind(e.target.value as VisualWorkKind)} disabled={busy || testing}><option value="animation">动画</option><option value="diagram">图解</option></select></label>
            <label>生成方式<select value={source} onChange={e => setSource(e.target.value as VisualSourceMode)} disabled={busy || testing}><option value="fresh">从零生成</option><option value="auto">允许检索复用</option></select></label></div>
          <details open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)} className="visual-model-settings">
            <summary>我的模型配置{canGenerate ? ' · 已填写' : ' · 必填'}</summary>
            <label>Base URL<input type="url" placeholder="https://your-provider.example/v1" value={config.base_url} onChange={e => changeConfig('base_url', e.target.value)} maxLength={2048} disabled={busy || testing} autoComplete="off"/></label>
            <small>兼容 OpenAI Chat Completions；填写 API 根地址或完整 /chat/completions 地址。</small>
            <label>模型名称<input placeholder="提供商的模型 ID" value={config.model} onChange={e => changeConfig('model', e.target.value)} maxLength={200} disabled={busy || testing} autoComplete="off"/></label>
            <label>API Key<input type="password" placeholder="填写你自己的 API Key" value={config.api_key} onChange={e => changeConfig('api_key', e.target.value)} maxLength={4096} disabled={busy || testing} autoComplete="off" spellCheck={false}/></label>
            <small>密钥只在本页内存中暂存，刷新后需重填。点击测试或生成后，服务端代发到你配置的模型；不保存密钥，不使用网站公共额度。连接测试会产生少量模型调用。</small>
            <div className="visual-studio-buttons"><button type="button" onClick={() => void testConnection()} disabled={busy || testing || !canGenerate}>{testing ? '正在测试…' : '测试连接'}</button><button type="button" disabled={busy || testing || !config.api_key} onClick={() => {setConfig(emptyConfig); setConnection('')}}>清除配置</button></div>
            {connection && <small role="status">{connection}</small>}
          </details>
          <div className="visual-studio-buttons"><button className="primary" type="submit" disabled={busy || testing || !draft.trim()}>{busy ? '正在生成…' : '生成作品'}</button>{busy && <button type="button" onClick={() => {controller.current?.abort(); setStage('正在停止；已保存的进度可从我的作品恢复。')}}>停止并保留进度</button>}</div>
          {stage && <p role="status">{stage}</p>}
          {error && <p role="alert">{error}</p>}
        </form>
        <section className="visual-studio-library" aria-label="我的作品"><h2>我的作品</h2><p>仅自己可见，不自动加入公共库。</p>
          <input aria-label="搜索我的作品" placeholder="搜索已保存作品或未完成任务" value={query} onChange={e => setQuery(e.target.value)} maxLength={2000}/>
          {loading ? <p role="status">正在读取…</p> : <>
            {!items.length && !jobs.length && <p>还没有匹配的作品。生成后会保存在这里。</p>}
            {jobs.map(job => <div className="visual-studio-job" key={job.job_id}><strong>{job.title}</strong><small>未完成 · 可从已保存进度继续</small><div className="visual-studio-buttons"><button type="button" disabled={busy || testing} onClick={() => void run('resume', {job_id: job.job_id})}>继续构建</button><button type="button" disabled={busy || testing} onClick={() => void cancelJob(job.job_id)}>取消任务</button></div></div>)}
            <div className="visual-hub-list">{items.map(item => <button type="button" disabled={busy || testing} className={selected?.revision_id === item.revision_id ? 'selected' : ''} key={item.revision_id} onClick={() => setSelected({...item, status: 'ready'})}><strong>{item.title}</strong><span>{item.summary}</span></button>)}</div>
          </>}
        </section>
      </div>
      <aside aria-label="创作预览">{selected ? <VisualPluginArtifact allowQuestions={false} key={selected.revision_id || selected.job_id} reference={selected} host={rendererHost} onPrompt={busy || testing ? undefined : onPrompt}/> : <div className="visual-hub-empty"><span>◇</span><h2>从一个具体问题开始</h2><p>完成后在这里播放、单步查看或调整参数。<br/>改编会保留原版本。</p></div>}</aside>
    </div>
  </div>
}
