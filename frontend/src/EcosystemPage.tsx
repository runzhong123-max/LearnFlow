import { useEffect, useRef, useState } from 'react'
import { createEcosystemClient, citationLabels, newEcosystemRequestId, type AgentRun, type CatalogItem, type RolePackage, type ResolutionPreview, type CommitReceipt } from './ecosystem-client.ts'
import type { PathNodeV2 } from './learning-path-contract-v2.ts'
import { isDesktopRuntime } from './runtime-client.ts'
import './ecosystem.css'
const api = createEcosystemClient()
const kinds: Record<string, string> = { task: '工作任务', capability: '岗位能力', capability_unit: '能力单元', knowledge_skill: '知识技能点', role: '岗位' }
const unresolvedReasons: Record<string, string> = { needs_decomposition: '该对象还需要拆分出明确的知识或技能要求。', needs_definition: '需要补充适用范围和可检查的考核要求。', needs_evidence: '缺少可追溯的岗位证据。', ambiguous_definition: '名称相近，但定义或适用范围不能确定为相同。', needs_anchor: '需要确定应归属的课程或知识领域。' }
const relations: Record<string, string> = { equivalent: '语义等价', narrower_than: '岗位要求更具体', related: '相关，尚不等价' }
function textError(error: unknown) { return error instanceof Error ? error.message : '服务暂不可用，请稍后重试。' }
export default function GraphHubRedirect() {
  return <section className="page-loading"><h1>岗位图谱</h1><p>在 Graph Hub 浏览岗位与知识技能。</p><a href="https://graphs.learnflow.club/hub" target="_blank" rel="noopener noreferrer">打开 Graph Hub ↗</a></section>
}

export function EcosystemPage() {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<CatalogItem[]>([])
  const [searched, setSearched] = useState(false)
  const [total, setTotal] = useState(0)
  const [pkg, setPkg] = useState<RolePackage>()
  const [nodeId, setNodeId] = useState('')
  const [evidence, setEvidence] = useState<any>()
  const [message, setMessage] = useState('')
  const [run, setRun] = useState<AgentRun>()
  const [preview, setPreview] = useState<ResolutionPreview>()
  const [receipt, setReceipt] = useState<CommitReceipt>()
  const [graphVersion, setGraphVersion] = useState('')
  const [graphNodes, setGraphNodes] = useState<PathNodeV2[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [service, setService] = useState('正在检查服务连接…')
  const [operations, setOperations] = useState<string[]>([])
  const agentAttempt = useRef<{ key: string; id: string }>()
  const resolveAttempt = useRef<{ key: string; id: string }>()
  const commitAttempt = useRef<{ key: string; id: string }>()
  const mounted = useRef(true)
  const selected = pkg?.result.semantic.nodes.find(node => node.id === nodeId)
  async function act(key: string, action: () => Promise<void>) {
    setBusy(key); setError('')
    try { await action() } catch (e) { if (mounted.current) { setError(textError(e)); if (key === 'connect') { setService('无法连接岗位服务，请刷新重试。'); setOperations([]) } } } finally { if (mounted.current) setBusy('') }
  }
  async function connect() {
    const caps = await api.capabilities()
    setOperations(caps.available ? caps.operations : [])
    setService(caps.available ? '已配置岗位服务。搜索后选择一个固定版本。' : isDesktopRuntime() ? '当前使用桌面本地身份，无法访问中央岗位服务。请在 LearnFlow 网页端使用中央账号登录；桌面中央登录尚未接入。' : '岗位服务尚未配置，请联系维护者连接 Graph Hub 与 Role Atlas。')
    const current = await api.graph(); setGraphVersion(current.graph.revision); setGraphNodes(current.graph.nodes); resolveAttempt.current = undefined
  }
  useEffect(() => { mounted.current = true; void act('connect', connect); return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (run?.status !== 'running' || !operations.includes('agent.get_run')) return
    let cancelled = false; let count = 0; let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const next = await api.getRun(run.runId, pkg?.packageRef); if (cancelled) return; setRun(next); if (next.status === 'running' && ++count < 12) timer = setTimeout(poll, 2500) }
      catch (e) { if (!cancelled) setError(textError(e)) }
    }
    timer = setTimeout(poll, 2500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [run?.runId, run?.status, operations])
  const can = (op: string) => operations.includes(op)
  async function choose(item: CatalogItem) {
    await act('package', async () => {
      const loaded = await api.package(item.packageRef)
      setPkg(loaded); setNodeId(loaded.result.semantic.nodes[0]?.id || ''); setEvidence(undefined); setRun(undefined); setPreview(undefined); setReceipt(undefined); agentAttempt.current = undefined
    })
  }
  async function ask() {
    if (!pkg || !selected || !message.trim()) return
    const key = JSON.stringify([pkg.packageRef, nodeId, message.trim()])
    if (agentAttempt.current?.key !== key) agentAttempt.current = { key, id: newEcosystemRequestId() }
    const id = agentAttempt.current.id
    await act('agent', async () => setRun(await api.run(pkg.packageRef, message.trim(), [nodeId], id)))
  }
  const evidenceData = evidence?.data?.data ?? evidence?.data ?? evidence
  return <section className="projects-page ecosystem-page">
    <header className="projects-hero"><span className="eyebrow">ROLE KNOWLEDGE</span><h1>岗位图谱</h1><p>浏览岗位任务与知识技能，查看依据，再将合适的知识技能挂载到学习路径。</p></header>
    <div className="ecosystem-status"><span>{service}</span><button disabled={!!busy} onClick={() => void act('connect', connect)}>刷新连接与路径</button>{graphVersion && <small>学习路径版本：{graphVersion}</small>}</div>
    {error && <p className="project-error" role="alert">{error}</p>}
    <form className="ecosystem-search" onSubmit={e => { e.preventDefault(); void act('search', async () => { const result = await api.search(query); setItems(result.items); setTotal(result.total); setSearched(true) }) }}>
      <label htmlFor="role-search">查找岗位包</label><input id="role-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="例如：软件测试工程师" /><button disabled={!!busy || !can('catalog.search')}>搜索 Graph Hub</button>
    </form>
    {searched && <p>{total ? `找到 ${total} 个版本，当前显示 ${items.length} 个。` : '已成功查询，当前没有匹配的岗位包。'}</p>}
    <div className="ecosystem-catalog">{items.map(item => <button className="ecosystem-package" key={JSON.stringify(item.packageRef)} disabled={!!busy || run?.status === 'running' || !can('package.resolve')} onClick={() => void choose(item)}><strong>{item.title}</strong><p>{item.summary}</p><small>版本 {item.packageRef.packageVersion} · {item.packageRef.snapshotId}</small></button>)}</div>
    {pkg && <><header className="ecosystem-package-heading"><h2>{pkg.title}</h2><small>固定版本 {pkg.packageRef.packageVersion} · {pkg.packageRef.snapshotId}</small><details><summary>完整包标识</summary><p>{pkg.packageRef.packageId}</p><code>{pkg.packageRef.rootHash}</code></details></header>
      <div className="ecosystem-grid"><nav className="ecosystem-nodes" aria-label="岗位对象">{pkg.result.semantic.nodes.map(node => <button key={node.id} aria-pressed={nodeId === node.id} disabled={!!busy || run?.status === 'running'} onClick={() => { setNodeId(node.id); setEvidence(undefined); setRun(undefined); setPreview(undefined); setReceipt(undefined); agentAttempt.current = undefined }}><small>{kinds[node.type] || node.type}{node.learningKind ? ` · ${node.learningKind === 'knowledge' ? '知识' : node.learningKind === 'skill' ? '技能' : '待拆分'}` : ''}</small><strong>{node.label}</strong></button>)}</nav>
      {selected && <article className="ecosystem-detail"><h2>{selected.label}</h2><p>{selected.summary}</p>{selected.learningDefinition && <><h3>范围与验收</h3><p>{selected.learningDefinition.scopeNote}</p><ul>{selected.learningDefinition.assessmentCriteria.map(c => <li key={c}>{c}</li>)}</ul></>}
        {can('role.query') && <button disabled={!!busy} onClick={() => void act('evidence', async () => setEvidence(await api.evidence(pkg.packageRef, nodeId)))}>查看节点证据</button>}
        {evidence && <div className="ecosystem-evidence"><h3>来源依据</h3>{evidenceData?.interpretation && <p>{evidenceData.interpretation}</p>}{Array.isArray(evidenceData?.sources) && evidenceData.sources.map((source: any, i: number) => <p key={source.id || i}><strong>{source.title || source.id || '来源'}</strong>{source.summary && <span>：{source.summary}</span>}</p>)}{Array.isArray(evidenceData?.segments) && evidenceData.segments.slice(0, 12).map((segment: any, i: number) => <blockquote key={segment.id || i}>{segment.text || segment.content || segment.summary || segment.sourceTitle}</blockquote>)}{!evidenceData?.sources?.length && <p>该节点未返回可展示的直接来源。</p>}</div>}
        {can('agent.run') && <form onSubmit={e => { e.preventDefault(); void ask() }}><label htmlFor="role-question">围绕此节点向岗位 Agent 提问</label><textarea id="role-question" value={message} onChange={e => setMessage(e.target.value)} placeholder="这个技能在实际工作中如何验收？" /><button disabled={!!busy || run?.status === 'running' || !message.trim()}>{busy === 'agent' ? '正在发送…' : '发送问题'}</button></form>}
        {run && <div aria-live="polite"><h3>{run.status === 'running' ? 'Agent 正在处理' : run.status === 'failed' ? '本次运行未完成' : 'Agent 回答'}</h3><small>运行 {run.runId}</small>{run.result?.answer && <p className="ecosystem-answer">{run.result.answer}</p>}{run.result && citationLabels(run.result.citations).length > 0 && <p>回答依据：{citationLabels(run.result.citations).join('、')}</p>}{run.status === 'running' && can('agent.get_run') && <button disabled={!!busy} onClick={() => void act('poll', async () => setRun(await api.getRun(run.runId, pkg?.packageRef)))}>查询运行结果</button>}</div>}
        <hr /><button disabled={!!busy || run?.status === 'running' || !can('package.resolve')} onClick={() => void act('resolve', async () => { const key = JSON.stringify([pkg.packageRef, nodeId]); if (resolveAttempt.current?.key !== key) resolveAttempt.current = { key, id: newEcosystemRequestId() }; setPreview(await api.resolve(pkg.packageRef, [nodeId], resolveAttempt.current.id)); setReceipt(undefined); commitAttempt.current = undefined })}>预览此节点与学习路径的挂载</button>
      </article>}</div>
      {preview && <section className="ecosystem-preview"><h2>学习路径变更预览</h2><p>这是当前账号知识技能源图的变更，不表示个人已掌握，也不会加入个人学习计划。</p>{preview.resolution.alignment.bindings.map(binding => <p key={binding.id}><strong>{relations[binding.relation]}</strong> → {graphNodes.find(n => n.namespace === binding.target.namespace && n.id === binding.target.id)?.title || binding.target.id}：{binding.rationale}</p>)}{preview.resolution.unresolved.map(item => <div key={item.roleNodeId}><strong>尚未挂载：{item.roleNodeId}</strong><p>{unresolvedReasons[item.reason] || '需要进一步核对。'}</p>{item.candidates.map(c => <p key={`${c.namespace}:${c.id}`}>候选：{c.title}（{c.kind === 'course' ? '课程' : c.kind === 'skill_domain' ? '领域' : c.kind === 'skill' ? '技能' : '知识'}）</p>)}</div>)}{preview.resolution.extensionProposal?.nodes.map(node => <article key={node.id}><h3>拟新增特殊节点：{node.title}</h3><p>{node.summary}</p>{node.atomic && <><p>范围：{node.atomic.scopeNote}</p><ul>{node.atomic.assessmentCriteria.map(c => <li key={c}>{c}</li>)}</ul></>}<p>归属课程：{preview.resolution.extensionProposal?.edges.filter(e => e.kind === 'contains' && e.to.namespace === node.namespace && e.to.id === node.id).map(e => graphNodes.find(n => n.namespace === e.from.namespace && n.id === e.from.id)?.title || e.from.id).join('、')}</p><small>尚未入库 · {node.kind === 'knowledge' ? '知识' : '技能'}</small></article>)}{preview.resolution.pendingBindings.length > 0 && <p>{preview.resolution.pendingBindings.length} 条绑定等待特殊节点入库后生效。</p>}
        {!receipt && (preview.resolution.alignment.bindings.length > 0 || (preview.resolution.extensionProposal?.nodes.length || 0) > 0) && <button disabled={!!busy} onClick={() => void act('commit', async () => { if (commitAttempt.current?.key !== preview.resolutionId) commitAttempt.current = { key: preview.resolutionId, id: newEcosystemRequestId() }; const result = await api.commit(preview.resolutionId, commitAttempt.current.id); setReceipt(result); setGraphVersion(result.graphRef.revision); window.dispatchEvent(new CustomEvent('learnflow:source-graph-updated')) })}>应用已预览的源图变更</button>}
        {receipt && <p role="status">已保存，新增 {receipt.addedNodeIds.length} 个节点。路径版本 {receipt.graphRef.revision}；回执 {receipt.receiptId}。</p>}
      </section>}
    </>}
  </section>
}
