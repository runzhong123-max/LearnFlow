import { useEffect, useRef, useState } from 'react'
import { addFormalProjectUrl, uploadFormalProjectFile, processFormalProjectSource, loadFormalProject, addKnowledgeLibraryUrl, uploadKnowledgeLibraryFile, processKnowledgeLibrarySource, loadKnowledgeLibrary } from './formal-runtime'
import type { FormalProjectWorkspace } from './project'
import type { TutorToolRun } from './tooling'
import { planningResourcePrompt, resourceCandidates, planningSourceType } from './planning-resources'
import './planning-resources.css'

type SavedSource = { id: number; name: string; url: string; status: string; error: string }
export default function PlanningResourceWorkbench({ projectId, topic, runs, pending, onRequest, onProjectChange }: {
  projectId?: number; topic: string; runs: TutorToolRun[]; pending: boolean
  onRequest: (prompt: string) => void
  onProjectChange: (workspace: FormalProjectWorkspace) => void
}) {
  const [sources, setSources] = useState<SavedSource[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const candidates = resourceCandidates(runs)
  const refresh = async () => {
    if (projectId) { const workspace = await loadFormalProject(projectId); setSources(workspace.sources); onProjectChange(workspace) }
    else setSources((await loadKnowledgeLibrary()).sources)
    setLoaded(true)
  }
  useEffect(() => { void refresh().catch(e => setError(e instanceof Error ? e.message : '资料读取失败')) }, [projectId])
  const add = async (input: string | File) => {
    setBusy(true); setError('')
    try {
      if (typeof input === 'string') { const target = new URL(input); if (!['https:', 'http:'].includes(target.protocol)) throw Error('请填写网页或仓库的 HTTP(S) 链接') }
      const existing = typeof input === 'string' ? sources.find(s => s.url === input) : undefined
      if (projectId) {
        const source = existing || (typeof input === 'string' ? await addFormalProjectUrl(projectId, input, planningSourceType(input)) : await uploadFormalProjectFile(projectId, input))
        if (source.status !== 'processed') await processFormalProjectSource(projectId, source.id)
      } else {
        const source = existing || (typeof input === 'string' ? await addKnowledgeLibraryUrl(input) : await uploadKnowledgeLibraryFile(input))
        if (source.status !== 'processed') await processKnowledgeLibrarySource(source.id)
      }
      setUrl(''); await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : '资料接入失败'); await refresh().catch(() => {}) }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const retry = async (sourceId: number) => {
    setBusy(true); setError('')
    try {
      if (projectId) await processFormalProjectSource(projectId, sourceId)
      else await processKnowledgeLibrarySource(sourceId)
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : '资料处理失败') }
    finally { setBusy(false) }
  }
  const request = (stage: 'sources' | 'roadmap' | 'schedule') => onRequest(planningResourcePrompt(topic, Boolean(projectId), stage))
  return <section className="planning-resources" aria-label="学习资料工作台">
    <header><div><small>{projectId ? '项目 Tutor · 围绕当前项目' : '普通对话 · 探索学习方向'}</small><h3>先选资料，再安排学习</h3></div><button type="button" disabled={pending || busy} onClick={() => request('sources')}>推荐书籍与仓库</button></header>
    <p>{projectId ? '选择后保存到本项目；Tutor 将据此设置关卡并安排长期学习。' : '选择后保存到你的资料库；先比较方向与学习负担，再形成长期计划。'}</p>
    <div className="planning-resource-add"><input aria-label="教材或仓库链接" value={url} onChange={e => setUrl(e.target.value)} placeholder="粘贴开放教材、文档或仓库链接" /><button type="button" disabled={busy || !url.trim()} onClick={() => void add(url.trim())}>选择此链接</button><button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>上传资料</button><input ref={fileInput} type="file" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void add(file) }} /></div>
    {busy && <p role="status">正在保存并处理资料…</p>}{error && <p role="alert">{error}</p>}
    <details open={!sources.length}><summary>候选资料 · {candidates.length}</summary>
      {!candidates.length && <p>点击“推荐书籍与仓库”开始检索，也可以直接上传你的教材。检索失败时可以继续添加链接。</p>}
      <div className="planning-resource-candidates">{candidates.map(source => <article key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><small>{source.quality === 'repository' ? '仓库' : source.role === 'textbook' ? '教材' : '网页资料'} · {source.readState === 'page_excerpt' ? '已读相关片段' : '待阅读核验'} · 许可需以来源为准</small><p>{source.reason || source.snippet.slice(0, 180)}</p><button type="button" disabled={busy || sources.some(s => s.url === source.url && s.status === 'processed')} onClick={() => void add(source.url)}>{sources.some(s => s.url === source.url && s.status === 'processed') ? '已接入' : projectId ? '选入本项目' : '选入资料库'}</button></article>)}</div>
    </details>
    <details open><summary>{projectId ? '本项目资料' : '我的资料库'} · {sources.length}</summary>{!loaded && !error && <p>正在读取资料…</p>}{sources.map(source => <div className="planning-resource-saved" key={source.id}><span>{source.name}</span><small>{source.status === 'processed' ? '已处理，可用于规划' : source.status === 'failed' ? '处理失败' : source.status === 'quarantined' ? '已隔离' : '尚未处理'}</small>{source.error && <small>{source.error}</small>}{!['processed', 'quarantined'].includes(source.status) && <button type="button" disabled={busy} onClick={() => void retry(source.id)}>重试处理</button>}</div>)}</details>
    <footer><button type="button" disabled={pending || busy || !sources.some(s => s.status === 'processed')} onClick={() => request('roadmap')}>{projectId ? '基于资料设置关卡' : '基于资料梳理学习阶段'}</button><button type="button" disabled={pending || busy || !sources.some(s => s.status === 'processed')} onClick={() => request('schedule')}>制定长期学习计划</button><small>资料接入不代表掌握；关卡和正式计划仍需确认。</small></footer>
  </section>
}
