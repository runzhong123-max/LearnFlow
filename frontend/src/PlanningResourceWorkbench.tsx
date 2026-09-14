import { useEffect, useRef, useState } from 'react'
import { addFormalProjectUrl, uploadFormalProjectFile, processFormalProjectSource, loadFormalProject, addKnowledgeLibraryUrl, uploadKnowledgeLibraryFile, processKnowledgeLibrarySource, loadKnowledgeLibrary } from './formal-runtime'
import type { FormalProjectWorkspace } from './project'
import type { SearchSource, TutorToolRun } from './tooling'
import { planningResourcePrompt, resourceCandidates, planningSourceType, resourceUrlKey, resourceIntroduction, resourceInquiryPrompt, savedResourceTitle, savedResourceStatus } from './planning-resources'
import './planning-resources.css'

type SavedSource = { id: number; name: string; url: string; status: string; error: string }
type ResourceToolProps = {
  knownResources?: SearchSource[]
  projectId?: number; topic: string; runs: TutorToolRun[]; pending: boolean
  onRequest: (prompt: string) => void
  onProjectChange: (workspace: FormalProjectWorkspace) => void
}

export default function PlanningResourceWorkbench(props: ResourceToolProps) {
  const [opened, setOpened] = useState(false)
  const count = resourceCandidates(props.runs).length
  const running = props.runs.some(run => run.status === 'running')
  const failed = props.runs.some(run => run.status === 'failed')
  return <details className="planning-resource-tool" onToggle={event => {
    if (event.currentTarget.open) setOpened(true)
  }}>
    <summary><strong>推荐课程、书籍与仓库</strong><span>{running ? '正在检索…' : count ? `${count} 项候选 · 查看与选择` : failed ? '检索失败 · 重试或添加资料' : '暂无候选 · 添加资料'}</span><span className="resource-disclosure-action"><span className="when-closed">查看推荐列表</span><span className="when-open">收起推荐列表</span><span className="resource-chevron" aria-hidden="true">⌄</span></span></summary>
    {opened && <PlanningResourcePanel {...props} />}
  </details>
}

function PlanningResourcePanel({ projectId, topic, runs, pending, onRequest, onProjectChange, knownResources = [] }: ResourceToolProps) {
  const [sources, setSources] = useState<SavedSource[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [inquiryUrls, setInquiryUrls] = useState<string[]>([])
  const [question, setQuestion] = useState('')
  const [notice, setNotice] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const candidates = resourceCandidates(runs)
  const known = [...candidates, ...knownResources]
  const savedFor = (sourceUrl: string) => {
    const key = resourceUrlKey(sourceUrl)
    return key ? sources.find(source => resourceUrlKey(source.url) === key) : undefined
  }
  const consulted = candidates.filter(source => inquiryUrls.includes(source.url))
  const selected = candidates.filter(source => savedFor(source.url))
  const ask = (items: SearchSource[]) => { if (items.length) onRequest(resourceInquiryPrompt(topic, items, question)) }
  const refresh = async () => {
    if (projectId) { const workspace = await loadFormalProject(projectId); setSources(workspace.sources); onProjectChange(workspace) }
    else setSources((await loadKnowledgeLibrary()).sources)
    setLoaded(true)
  }
  useEffect(() => { void refresh().catch(e => setError(e instanceof Error ? e.message : '资料读取失败')) }, [projectId])
  const add = async (input: string | File) => {
    setBusy(true); setError(''); setNotice('')
    try {
      if (typeof input === 'string' && !resourceUrlKey(input)) throw Error('请填写不含账号密码的网页或仓库 HTTP(S) 链接')
      const existing = typeof input === 'string' ? savedFor(input) : undefined
      if (projectId) {
        const source = existing || (typeof input === 'string' ? await addFormalProjectUrl(projectId, input, planningSourceType(input)) : await uploadFormalProjectFile(projectId, input))
        if (source.status !== 'processed') await processFormalProjectSource(projectId, source.id)
      } else {
        const source = existing || (typeof input === 'string' ? await addKnowledgeLibraryUrl(input) : await uploadKnowledgeLibraryFile(input))
        if (source.status !== 'processed') await processKnowledgeLibrarySource(source.id)
      }
      setUrl(''); await refresh()
      const name = typeof input === 'string' ? savedResourceTitle({ name: input, url: input }, known) : input.name
      setNotice(`已选入${projectId ? '本项目' : '资料库'}：${name}`)
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
  const request = (stage: 'sources' | 'roadmap' | 'schedule') => {
    const saved = sources.filter(source => source.status === 'processed').map(source => ({ id: source.id, title: savedResourceTitle(source, known), url: source.url }))
    onRequest(planningResourcePrompt(topic, Boolean(projectId), stage) + (stage === 'sources' ? '' : `\n当前已选入并处理的资料（只按这些引用核实内容）：${JSON.stringify(saved)}`))
  }
  return <section className="planning-resources" aria-label="推荐资料工具结果">
    <header><div><small>{projectId ? '项目 Tutor · 围绕当前项目' : '普通对话 · 探索学习方向'}</small><h3>选择本轮推荐资料</h3></div><button type="button" disabled={pending || busy} onClick={() => request('sources')}>重新推荐</button></header>
    <p>{projectId ? '选择后保存到本项目；Tutor 将据此设置关卡并安排长期学习。' : '选择后保存到你的资料库；先比较方向与学习负担，再形成长期计划。'}</p>
    <p>先阅读简介，勾选一份或多份向 Tutor 询问；确认适合后，再点击“确认选用”。</p>
    {notice && <p className="resource-selection-notice" role="status">✓ {notice}</p>}
    <div className="resource-selection-summary"><strong>本轮推荐中已选用 · {selected.length}</strong>{selected.length ? <ul>{selected.map(source => <li key={source.url}>✓ {source.title}<small>{savedResourceStatus(savedFor(source.url)?.status || '')}</small></li>)}</ul> : <p>尚未选用本轮推荐。勾选咨询不会保存资料。</p>}</div>
    <div className="planning-resource-add"><input aria-label="教材或仓库链接" value={url} onChange={e => setUrl(e.target.value)} placeholder="粘贴开放教材、文档或仓库链接" /><button type="button" disabled={busy || !url.trim()} onClick={() => void add(url.trim())}>选择此链接</button><button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>上传资料</button><input ref={fileInput} type="file" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void add(file) }} /></div>
    {busy && <p role="status">正在保存并处理资料…</p>}{error && <p role="alert">{error}</p>}
    <details className="resource-list-disclosure" open><summary><span>推荐列表 · {candidates.length} 项</span><span className="resource-disclosure-action"><span className="when-closed">展开列表</span><span className="when-open">收起列表</span><span className="resource-chevron" aria-hidden="true">⌄</span></span></summary>
      {!candidates.length && <p>点击“重新推荐”再次检索，也可以直接上传你的教材。检索失败时可以继续添加链接。</p>}
      <div className="resource-inquiry" aria-label="向 Tutor 咨询资料">
        <strong>已勾选咨询 · {consulted.length} 项</strong>
        {consulted.length > 0 && <p>{consulted.map(source => source.title).join('、')}</p>}
        <label>想问什么？<textarea value={question} onChange={event => setQuestion(event.target.value)} placeholder="例如：哪份适合零基础？这两门课有什么区别？" maxLength={2000} /></label>
        <button type="button" disabled={pending || !consulted.length} onClick={() => ask(consulted)}>询问 Tutor{consulted.length > 1 ? '并比较资料' : ''}</button>
        <small>只发送咨询，不会把勾选项自动加入资料库。</small>
      </div>
      <div className="planning-resource-candidates">{candidates.map(source => {
        const saved = savedFor(source.url)
        const intro = resourceIntroduction(source)
        return <article key={source.url} className={saved ? 'resource-card-selected' : ''}>
          <label className="resource-inquiry-checkbox"><input type="checkbox" aria-label={`勾选咨询：${source.title}`} checked={inquiryUrls.includes(source.url)} onChange={event => setInquiryUrls(previous => event.target.checked ? [...previous, source.url] : previous.filter(url => url !== source.url))} />勾选咨询</label>
          <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
          {saved && <strong className="resource-selected-badge">✓ 已选用 · {savedResourceStatus(saved.status)}</strong>}
          <small>{source.quality === 'repository' ? '仓库' : source.role === 'textbook' ? '教材' : source.role === 'course' ? '课程' : '网页资料'} · 许可需以来源为准</small>
          <div className="resource-introduction"><strong>内容简介 · 来源摘要</strong><p>{intro.summary}</p><strong>推荐理由</strong><p>{intro.reason}</p><small>{intro.basis}</small></div>
          <div className="resource-card-actions">
            <a className="resource-open-link" href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`打开资料：${source.title}（新窗口）`}>打开资料 ↗</a>
            <button type="button" disabled={pending} onClick={() => ask([source])}>询问这份资料</button>
            <button type="button" disabled={busy || !loaded || Boolean(saved)} onClick={() => void add(source.url)}>{saved ? '✓ 已选用' : '确认选用'}</button>
          </div>
        </article>
      })}</div>
    </details>
    <details className="resource-list-disclosure" open><summary><span>{projectId ? '已选入本项目的资料' : '已选入资料库的资料'} · {sources.length}</span><span className="resource-disclosure-action"><span className="when-closed">展开资料库</span><span className="when-open">收起资料库</span><span className="resource-chevron" aria-hidden="true">⌄</span></span></summary>{!loaded && !error && <p>正在读取资料…</p>}{sources.map(source => <div className="planning-resource-saved" key={source.id}><strong>✓ {savedResourceTitle(source, known)}</strong>{resourceUrlKey(source.url) && <a href={resourceUrlKey(source.url)} target="_blank" rel="noopener noreferrer">打开已选资料 ↗</a>}<small>{savedResourceStatus(source.status)}</small>{source.error && <small>{source.error}</small>}{!['processed', 'quarantined'].includes(source.status) && <button type="button" disabled={busy} onClick={() => void retry(source.id)}>重试处理</button>}</div>)}</details>
    <footer><button type="button" disabled={pending || busy || !sources.some(s => s.status === 'processed')} onClick={() => request('roadmap')}>{projectId ? '基于资料设置关卡' : '基于资料梳理学习阶段'}</button><button type="button" disabled={pending || busy || !sources.some(s => s.status === 'processed')} onClick={() => request('schedule')}>制定长期学习计划</button><small>资料接入不代表掌握；关卡和正式计划仍需确认。</small></footer>
  </section>
}
