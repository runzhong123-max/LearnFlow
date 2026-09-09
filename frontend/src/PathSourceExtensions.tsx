import { useEffect, useMemo, useRef, useState } from 'react'
import { createEcosystemClient } from './ecosystem-client.ts'
import { pathNodeKey, type LearningPathGraphV2 } from './learning-path-contract-v2.ts'
import { projectPathSourceExtensions } from './path-source-extensions.ts'
import './path-source-extensions.css'
const client = createEcosystemClient()
export default function PathSourceExtensions({ officialId, officialTitle }: { officialId?: string; officialTitle?: string }) {
  const [graph, setGraph] = useState<LearningPathGraphV2>()
  const [selectedKey, setSelectedKey] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  async function refresh() {
    const request = ++generation.current
    setBusy(true); setError('')
    try { const response = await client.graph(); if (request === generation.current) setGraph(response.graph) }
    catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : '岗位知识技能暂不可用。') }
    finally { if (request === generation.current) setBusy(false) }
  }
  useEffect(() => {
    void refresh()
    const update = () => { void refresh() }
    window.addEventListener('learnflow:source-graph-updated', update)
    return () => { generation.current++; window.removeEventListener('learnflow:source-graph-updated', update) }
  }, [])
  const view = useMemo(() => graph ? projectPathSourceExtensions(graph, officialId) : undefined, [graph, officialId])
  const visible = (showAll ? view?.extensions : view?.attached) || []
  const selected = visible.find(node => pathNodeKey(node) === selectedKey) || visible[0]
  return <section className="path-source-extensions">
    <header><h3>岗位课程与应用</h3><button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '读取中…' : '刷新源图'}</button></header>
    <p>当前账号从岗位包补充的课程与历史知识技能。岗位应用的范围、验收与证据保留在岗位包挂载记录中，不表示个人掌握。</p>
    {error && <p role="alert">{error}</p>}
    {view && <><div className="path-source-filter"><button type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)}>当前课程（{view.attached.length}）</button><button type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>全部课程与补充（{view.extensions.length}）</button></div>
      {!showAll && <p className="path-source-parent">{officialTitle || '请选择官方课程'} <span aria-hidden="true">↓</span> 包含的岗位知识技能</p>}
      <ul className="path-source-list">{visible.map(node => <li key={pathNodeKey(node)}><button type="button" aria-pressed={selected && pathNodeKey(selected) === pathNodeKey(node)} onClick={() => setSelectedKey(pathNodeKey(node))}><span>{node.kind === 'course' ? '课程' : node.kind === 'knowledge' ? '知识' : '技能'}</span>{node.title}</button></li>)}</ul>
      {!visible.length && <p>{busy ? '正在刷新…' : '当前范围尚无已保存的岗位知识技能。可在岗位图谱中预览并应用挂载。'}</p>}
      {selected && <article className="path-source-detail"><h4>{selected.title}</h4><p>{selected.summary}</p><p>归属：{view.parents(selected).map(node => node.title).join('、') || (selected.kind === 'course' ? '独立课程' : '未指定包含节点')}</p>{selected.atomic && <><strong>范围</strong><p>{selected.atomic.scopeNote}</p><strong>验收要求</strong><ul>{selected.atomic.assessmentCriteria.map(c => <li key={c}>{c}</li>)}</ul></>}
        <details><summary>来源与版本</summary><p>{selected.namespace} / {selected.id} · 节点修订 {selected.revision}</p>{selected.provenance.packageRef && <p>岗位包 {selected.provenance.packageRef.packageId} · {selected.provenance.packageRef.packageVersion} · 快照 {selected.provenance.packageRef.snapshotId}</p>}<p>证据引用：{selected.provenance.evidenceRefs?.join('、') || '见源图来源记录'}</p></details>
      </article>}
      <small className="path-source-revision">源图版本 {graph?.revision}</small>
    </>}
  </section>
}
