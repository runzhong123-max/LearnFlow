import { useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import {
  defineLearnFlowPluginClient,
  pluginObjectDragProps,
  type PluginToolRendererProps,
} from '../../src/PluginToolResultView.tsx'
import { ROLE_CAPABILITY_PLUGIN, ROLE_RENDERERS } from './shared.ts'
import './plugin.css'

type RecordValue = Record<string, any>

function openExternalProductLink(event: MouseEvent<HTMLAnchorElement>, url: string) {
  if (!('__TAURI_INTERNALS__' in window)) return
  event.preventDefault()
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_external_url', { url }))
    .catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
}

function dataOf(object: PluginToolRendererProps['objects'][number]) {
  const value = object.value as RecordValue
  return (value.data || {}) as RecordValue
}

function categoryOf(object: PluginToolRendererProps['objects'][number]) {
  const value = object.value as RecordValue
  return String(value.category || dataOf(object).type || dataOf(object).kind || 'object')
}

function semanticRingOf(object: PluginToolRendererProps['objects'][number]) {
  const explicit = Number(dataOf(object).ring)
  if (Number.isInteger(explicit) && explicit >= 0) return explicit
  const category = categoryOf(object)
  if (category === 'market_role') return 0
  if (['industry_chain_node', 'job_family', 'occupation_standard', 'related_role'].includes(category)) return 1
  if (category === 'task') return 2
  if (category === 'capability') return 3
  if (category === 'capability_unit') return 4
  if (category === 'knowledge_skill') return 5
  return null
}

function snapshotOf(result: PluginToolRendererProps['result']) {
  const payload = (result.payload || {}) as RecordValue
  return (payload.snapshot || {}) as RecordValue
}

const palette: Record<string, string> = {
  market_role: '#315947', industry_chain_node: '#4f7280', job_family: '#4f7280', occupation_standard: '#4f7280', related_role: '#4f7280',
  task: '#b96649', capability: '#806692', capability_unit: '#9a82aa', knowledge_skill: '#4d8060',
  scenario: '#9b684e', event: '#ba744f', actor: '#55758a', work_object: '#887656', artifact: '#4c796e',
  tool_system: '#687493', quality_criterion: '#64804f', exception_risk: '#a25b56', risk: '#a25b56', decision: '#8d7040',
}

function colorFor(category: string) {
  return palette[category] || '#68766f'
}

function SnapshotBadge({ result }: { result: PluginToolRendererProps['result'] }) {
  const snapshot = snapshotOf(result)
  return (
    <div className="role-plugin-snapshot">
      <span>固定快照</span>
      <strong>{String(snapshot.roleTitle || '岗位包')}</strong>
      <small>v{String(snapshot.packageVersion || '—')} · {String(snapshot.snapshotAsOf || '—')}</small>
    </div>
  )
}

function SnapshotViewTabs<T extends string>({ active, views, onChange }: {
  active: T
  views: Array<{ id: T; label: string }>
  onChange: (view: T) => void
}) {
  return <nav className="role-plugin-view-tabs" aria-label="切换岗位快照展示">
    {views.map(view => <button
      key={view.id}
      type="button"
      aria-pressed={active === view.id}
      onClick={() => onChange(view.id)}
    >{view.label}</button>)}
  </nav>
}

function interactiveObjectProps(props: PluginToolRendererProps, object: PluginToolRendererProps['objects'][number]) {
  return {
    ...pluginObjectDragProps(object),
    onDoubleClick: () => props.onReference?.(object),
  }
}

function FollowActions({ props, objectId, label }: { props: PluginToolRendererProps; objectId: string; label: string }) {
  const object = props.objects.find(item => item.objectId === objectId)
  if (!props.onPrompt && !props.onReference) return null
  const snapshot = snapshotOf(props.result)
  const suffix = `（固定快照 ${String(snapshot.snapshotId || '')}，对象 ${objectId}）`
  return <div className="role-plugin-actions">
    {props.onReference && object && <button type="button" onClick={() => props.onReference?.(object)}>引用到输入框</button>}
    {props.onPrompt && <button type="button" onClick={() => props.onPrompt?.(`详细解释“${label}”${suffix}`)}>继续解释</button>}
    {props.onPrompt && <button type="button" onClick={() => props.onPrompt?.(`展示“${label}”与其他岗位对象的关系${suffix}`)}>查看关系</button>}
    {props.onPrompt && <button type="button" onClick={() => props.onPrompt?.(`核对“${label}”的证据和适用边界${suffix}`)}>查看证据</button>}
  </div>
}

type RoleCardDimension = {
  id: string
  label: string
  description: string
  categories: string[]
}

const roleCardDimensions: RoleCardDimension[] = [
  {
    id: 'position',
    label: '产业与岗位位置',
    description: '产业链、岗位群、具体岗位与相邻岗位',
    categories: ['industry_chain_node', 'job_family', 'occupation_standard', 'market_role', 'related_role'],
  },
  { id: 'task', label: '典型工作任务', description: '能形成独立交付物、可观察工作结果的任务', categories: ['task'] },
  { id: 'capability', label: '岗位能力', description: '能够跨任务迁移的综合能力', categories: ['capability'] },
  { id: 'capability-unit', label: '能力单元', description: '可训练、可观察、可评价的能力组成', categories: ['capability_unit'] },
  { id: 'knowledge-skill', label: '知识点与技能点', description: '支撑任务完成与能力形成的学习对象', categories: ['knowledge_skill'] },
]

function simpleCardDetails(data: RecordValue) {
  const ignored = new Set(['id', 'type', 'kind', 'label', 'summary', 'ring', 'lifecycle', 'confidence', 'assertion_refs', 'evidence_summary'])
  return Object.entries(data).flatMap(([key, value]) => {
    if (ignored.has(key)) return []
    if (['string', 'number', 'boolean'].includes(typeof value)) return [[key, String(value)] as const]
    if (Array.isArray(value)) {
      const text = value.filter(item => ['string', 'number', 'boolean'].includes(typeof item)).slice(0, 4).join('、')
      return text ? [[key, text] as const] : []
    }
    return []
  }).slice(0, 3)
}

function ObjectCardLane({ props, dimension, objects, dimensionIndex, selectedId, relationCounts, onSelect }: {
  props: PluginToolRendererProps
  dimension: RoleCardDimension
  objects: readonly PluginToolRendererProps['objects'][number][]
  dimensionIndex: number
  selectedId: string
  relationCounts: Map<string, number>
  onSelect: (objectId: string) => void
}) {
  const laneRef = useRef<HTMLDivElement | null>(null)
  const moveLane = (direction: -1 | 1) => laneRef.current?.scrollBy({
    left: direction * Math.max(240, laneRef.current.clientWidth * .72),
    behavior: 'smooth',
  })

  return <section className="role-plugin-card-dimension" aria-labelledby={`role-plugin-card-dimension-${dimension.id}`}>
    <header>
      <div>
        <span>维度 {String(dimensionIndex + 1).padStart(2, '0')}</span>
        <strong id={`role-plugin-card-dimension-${dimension.id}`}>{dimension.label}</strong>
        <p>{dimension.description}</p>
      </div>
      <div className="role-plugin-card-row-actions">
        <b>{objects.length} 张卡片</b>
        <button type="button" onClick={() => moveLane(-1)} aria-label={`向左浏览${dimension.label}`}>←</button>
        <button type="button" onClick={() => moveLane(1)} aria-label={`向右浏览${dimension.label}`}>→</button>
      </div>
    </header>
    <div className="role-plugin-card-lane" ref={laneRef}>
      {objects.map(object => {
        const data = dataOf(object)
        const category = categoryOf(object)
        const selected = selectedId === object.objectId
        const evidence = (data.evidence_summary || {}) as RecordValue
        const confidence = typeof data.confidence === 'number'
          ? data.confidence
          : typeof evidence.max_confidence === 'number' ? evidence.max_confidence : null
        const sourceRefs = Array.isArray(evidence.source_refs)
          ? evidence.source_refs
          : Array.isArray(data.evidenceSegmentIds) ? data.evidenceSegmentIds
            : Array.isArray(data.evidenceBindingIds) ? data.evidenceBindingIds : []
        const sourceCount = new Set(sourceRefs.map(item => String(item))).size
        const details = selected ? simpleCardDetails(data) : []
        return <article
          key={object.objectId}
          className={`role-plugin-summary-card ${selected ? 'selected' : ''} ${String(data.lifecycle || data.knowledgeState || 'snapshot')}`}
          style={{ '--role-accent': colorFor(category) } as CSSProperties}
          {...interactiveObjectProps(props, object)}
        >
          <button className="role-plugin-card-select" type="button" aria-pressed={selected} onClick={() => onSelect(object.objectId)}>
            <span className="role-plugin-card-type"><b>{category}</b><i>{String(data.lifecycle || data.knowledgeState || 'snapshot')}</i></span>
            <strong>{object.label}</strong>
            <p>{String(data.summary || '')}</p>
            <div className="role-plugin-card-metrics">
              <span><b>{confidence === null ? '—' : confidence.toFixed(2)}</b><small>置信</small></span>
              <span><b>{sourceCount}</b><small>来源</small></span>
              <span><b>{relationCounts.get(object.objectId) || 0}</b><small>关系</small></span>
            </div>
            {details.length > 0 && <div className="role-plugin-card-expanded">
              {details.map(([key, value]) => <span key={key}><b>{key.replaceAll('_', ' ')}</b><small>{value}</small></span>)}
            </div>}
          </button>
          <footer><code>{object.objectId}</code>{confidence !== null && <b>{Math.round(confidence * 100)}%</b>}</footer>
          <FollowActions props={props} objectId={object.objectId} label={object.label} />
        </article>
      })}
    </div>
  </section>
}

function ObjectCardGrid({ props, objects = props.objects.filter(object => object.objectType === 'role_object') }: {
  props: PluginToolRendererProps
  objects?: readonly PluginToolRendererProps['objects'][number][]
}) {
  const [selectedId, setSelectedId] = useState(objects[0]?.objectId || '')
  const grouped = useMemo(() => {
    const assigned = new Set(roleCardDimensions.flatMap(dimension => dimension.categories))
    const rows = roleCardDimensions.map(dimension => ({
      dimension,
      objects: objects.filter(object => dimension.categories.includes(categoryOf(object))),
    })).filter(row => row.objects.length > 0)
    const otherObjects = objects.filter(object => !assigned.has(categoryOf(object)))
    if (otherObjects.length > 0) rows.push({
      dimension: { id: 'other', label: '其他语义对象', description: '场景、事理及尚未归入核心维度的岗位对象', categories: [] },
      objects: otherObjects,
    })
    return rows
  }, [objects])
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>()
    props.objects.filter(object => object.objectType === 'role_relation').forEach(object => {
      const relation = dataOf(object)
      const source = String(relation.source || '')
      const target = String(relation.target || '')
      if (source) counts.set(source, (counts.get(source) || 0) + 1)
      if (target) counts.set(target, (counts.get(target) || 0) + 1)
    })
    return counts
  }, [props.objects])

  if (!grouped.length) return <p className="role-plugin-card-empty">没有匹配当前结果的岗位卡片。</p>
  return <div className="role-plugin-card-view">
    <header className="role-plugin-card-view-intro">
      <div><span>ROLE CARDS</span><strong>岗位卡片总览</strong></div>
      <p>上下浏览语义维度，左右浏览同维度节点。选择卡片可展开细节，拖动或双击可引用到对话。</p>
    </header>
    {grouped.map((row, index) => <ObjectCardLane
      key={row.dimension.id}
      props={props}
      dimension={row.dimension}
      objects={row.objects}
      dimensionIndex={index}
      selectedId={selectedId}
      relationCounts={relationCounts}
      onSelect={setSelectedId}
    />)}
  </div>
}

type RadarRing = { ring: number; label: string; objectIds: string[]; total?: number }

function RoleDimensionRadar({ props, radar }: { props: PluginToolRendererProps; radar: RecordValue }) {
  const [selectedId, setSelectedId] = useState(String(radar.rootId || ''))
  const objects = new Map(props.objects.filter(object => object.objectType === 'role_object').map(object => [object.objectId, object]))
  const relations = props.objects.filter(object => object.objectType === 'role_relation')
  const rings = ((radar.rings || []) as RadarRing[]).filter(ring => ring.objectIds.some(id => objects.has(id)))
  const rootId = String(radar.rootId || rings.find(ring => ring.ring === 0)?.objectIds[0] || '')
  const width = 820
  const height = 580
  const center = { x: width / 2, y: height / 2 }
  const maxRadius = 242
  const positions = new Map<string, { x: number; y: number; ring: number }>()
  rings.forEach(ring => {
    const visibleIds = ring.objectIds.filter(id => objects.has(id))
    visibleIds.forEach((objectId, index) => {
      if (ring.ring === 0) positions.set(objectId, { ...center, ring: 0 })
      else {
        const radius = maxRadius * (.28 + ring.ring * .14)
        const angle = -Math.PI / 2 + Math.PI * 2 * index / Math.max(visibleIds.length, 1) + (ring.ring % 2 ? .08 : 0)
        positions.set(objectId, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius, ring: ring.ring })
      }
    })
  })
  const visibleIds = new Set(positions.keys())
  const selected = objects.get(selectedId) || objects.get(rootId)
  return <div className="role-plugin-dimension-radar">
    <header><strong>岗位中心语义雷达</strong><span>{Math.max(0, rings.length - 1)} 个维度 · {Math.max(0, visibleIds.size - 1)} 个外围节点</span></header>
    <div className="role-plugin-radar-stage" role="img" aria-label={`以${objects.get(rootId)?.label || '岗位'}为中心，按岗位边界、任务、能力、能力单元和知识技能向外展开`}>
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {rings.filter(ring => ring.ring > 0).map(ring => {
          const radius = maxRadius * (.28 + ring.ring * .14)
          return <circle key={ring.ring} cx={center.x} cy={center.y} r={radius} className={`ring ring-${ring.ring}`} />
        })}
        <g className="role-plugin-radar-edges">{relations.map(relationObject => {
          const relation = dataOf(relationObject)
          const source = positions.get(String(relation.source || ''))
          const target = positions.get(String(relation.target || ''))
          if (!source || !target) return null
          return <line key={relationObject.objectId} x1={source.x} y1={source.y} x2={target.x} y2={target.y}><title>{String(relation.type || '')}</title></line>
        })}</g>
      </svg>
      {rings.filter(ring => ring.ring > 0).map(ring => <span key={ring.ring} className={`role-plugin-ring-label ring-${ring.ring}`}>{ring.label}<small>{ring.objectIds.filter(id => objects.has(id)).length}{ring.total && ring.total > ring.objectIds.length ? ` / ${ring.total}` : ''}</small></span>)}
      {[...positions].map(([objectId, position]) => {
        const object = objects.get(objectId)
        if (!object) return null
        const category = categoryOf(object)
        return <button
          key={objectId}
          type="button"
          className={`role-plugin-radar-node ${position.ring === 0 ? 'root' : ''} ${selected?.objectId === objectId ? 'selected' : ''}`}
          style={{ left: `${position.x / width * 100}%`, top: `${position.y / height * 100}%`, '--role-accent': colorFor(category) } as CSSProperties}
          aria-label={`${object.label}，${category}`}
          {...interactiveObjectProps(props, object)}
          onClick={() => setSelectedId(objectId)}
        ><i /><span>{object.label}</span></button>
      })}
    </div>
    {selected && <article className="role-plugin-radar-selection" style={{ '--role-accent': colorFor(categoryOf(selected)) } as CSSProperties} {...interactiveObjectProps(props, selected)}>
      <span>{categoryOf(selected)} · 第 {semanticRingOf(selected) ?? '—'} 环</span><strong>{selected.label}</strong><p>{String(dataOf(selected).summary || '')}</p>
      <FollowActions props={props} objectId={selected.objectId} label={selected.label} />
    </article>}
    <footer>节点可点击查看、双击引用，也可直接拖入下方输入框。环表示岗位语义维度，不表示分数高低。</footer>
  </div>
}

function RoleOverview(props: PluginToolRendererProps) {
  const [view, setView] = useState<'overview' | 'radar' | 'cards'>('overview')
  const payload = (props.result.payload || {}) as RecordValue
  const sections = payload.sections || {}
  const nodes = new Map(props.objects.filter(object => object.objectType === 'role_object').map(object => [object.objectId, object]))
  const root = nodes.get(String(payload.rootId || ''))
  const inferredRings = [...nodes.values()].reduce<Map<number, string[]>>((groups, object) => {
    const ring = semanticRingOf(object)
    if (ring === null) return groups
    groups.set(ring, [...(groups.get(ring) || []), object.objectId])
    return groups
  }, new Map())
  const radar = (payload.radar || {
    rootId: payload.rootId,
    rings: [...inferredRings].sort(([left], [right]) => left - right).map(([ring, objectIds]) => ({
      ring,
      objectIds,
      label: ({ 0: '岗位中心', 1: '岗位身份与边界', 2: '典型任务', 3: '抽象能力', 4: '能力单元', 5: '知识技能' } as Record<number, string>)[ring] || `第 ${ring} 层`,
    })),
  }) as RecordValue
  const renderSection = (title: string, ids: string[], empty: string) => <section className="role-plugin-overview-section">
    <header><strong>{title}</strong><small>{ids.length}</small></header>
    <div>{ids.map(id => nodes.get(id)).filter(Boolean).map(object => {
      const data = dataOf(object!)
      return <article key={object!.objectId} style={{ '--role-accent': colorFor(categoryOf(object!)) } as CSSProperties} {...interactiveObjectProps(props, object!)}>
        <span>{categoryOf(object!)}</span><strong>{object!.label}</strong><p>{String(data.summary || '')}</p>
        <FollowActions props={props} objectId={object!.objectId} label={object!.label} />
      </article>
    })}</div>
    {!ids.length && <p>{empty}</p>}
  </section>
  return <section className="role-plugin-view role-plugin-overview" aria-label="岗位全景">
    <SnapshotBadge result={props.result} />
    <SnapshotViewTabs active={view} views={[{ id: 'overview', label: '岗位全景' }, { id: 'radar', label: '能力雷达' }, { id: 'cards', label: '对象卡片' }]} onChange={setView} />
    {view === 'overview' && <>
      {root && <article className="role-plugin-identity" {...interactiveObjectProps(props, root)}><span>岗位定位</span><strong>{root.label}</strong><p>{String(dataOf(root).summary || '')}</p><FollowActions props={props} objectId={root.objectId} label={root.label} /></article>}
      <div className="role-plugin-overview-grid">
        {renderSection('典型任务', sections.tasks || [], '当前视图没有任务对象。')}
        {renderSection('核心能力', sections.capabilities || [], '当前视图没有能力对象。')}
        {renderSection('工作场景', sections.scenarios || [], '当前视图没有场景对象。')}
        {renderSection('相邻岗位', sections.relatedRoles || [], '当前视图没有相邻岗位。')}
      </div>
    </>}
    {view === 'radar' && <RoleDimensionRadar props={props} radar={radar} />}
    {view === 'cards' && <ObjectCardGrid props={props} />}
    <p className="role-plugin-boundary">{String(payload.grounding?.requiredDisclosure || '')}</p>
  </section>
}

function CapabilityRadar(props: PluginToolRendererProps) {
  const [view, setView] = useState<'radar' | 'cards'>('radar')
  const payload = (props.result.payload || {}) as RecordValue
  return <section className="role-plugin-view role-plugin-radar" aria-label="岗位能力雷达">
    <SnapshotBadge result={props.result} />
    <SnapshotViewTabs active={view} views={[{ id: 'radar', label: '能力雷达' }, { id: 'cards', label: '能力卡片' }]} onChange={setView} />
    {view === 'radar' ? <RoleDimensionRadar props={props} radar={payload} /> : <ObjectCardGrid props={props} />}
    <p className="role-plugin-boundary">{String(payload.boundary || '')}</p>
  </section>
}

function RoleCards(props: PluginToolRendererProps) {
  const payload = (props.result.payload || {}) as RecordValue
  return (
    <section className="role-plugin-view role-plugin-cards" aria-label="岗位对象卡片">
      <SnapshotBadge result={props.result} />
      <ObjectCardGrid props={props} />
      {payload.omittedIds?.length ? <p className="role-plugin-warning">未找到：{payload.omittedIds.join('、')}</p> : null}
      {payload.coverage?.omitted ? <p className="role-plugin-boundary">结果有界：另有 {payload.coverage.omitted} 个匹配对象未展示。</p> : null}
    </section>
  )
}

function RoleGraph(props: PluginToolRendererProps) {
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const allNodes = props.objects.filter(object => object.objectType === 'role_object')
  const relationObjects = props.objects.filter(object => object.objectType === 'role_relation')
  const payload = (props.result.payload || {}) as RecordValue
  const rootId = String(payload.rootId || allNodes[0]?.objectId || '')
  const nodeLimit = expanded ? allNodes.length : Math.min(16, allNodes.length)
  const nodeObjects = [allNodes.find(object => object.objectId === rootId), ...allNodes.filter(object => object.objectId !== rootId)].filter(Boolean).slice(0, nodeLimit) as typeof allNodes
  const visibleIds = new Set(nodeObjects.map(object => object.objectId))
  const visibleRelations = relationObjects.filter(object => {
    const relation = dataOf(object)
    return visibleIds.has(String(relation.source)) && visibleIds.has(String(relation.target))
  }).slice(0, expanded ? relationObjects.length : 28)
  const width = 760
  const height = expanded ? 560 : 430
  const center = { x: width / 2, y: height / 2 }
  const positions = new Map<string, { x: number; y: number }>()
  const ordered = [...nodeObjects].sort((left, right) => left.objectId === rootId ? -1 : right.objectId === rootId ? 1 : left.objectId.localeCompare(right.objectId))
  ordered.forEach((object, index) => {
    if (object.objectId === rootId) positions.set(object.objectId, center)
    else {
      const ringIndex = index - (ordered[0]?.objectId === rootId ? 1 : 0)
      const count = Math.max(1, ordered.length - 1)
      const angle = (Math.PI * 2 * ringIndex) / count - Math.PI / 2
      const band = ringIndex < 8 ? 0 : ringIndex < 18 ? 1 : 2
      const radius = expanded ? [118, 190, 252][band] : (ringIndex < 8 ? 112 : 176)
      positions.set(object.objectId, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius })
    }
  })
  const selected = allNodes.find(object => object.objectId === (selectedId || rootId))
  const selectedRelations = relationObjects.filter(object => {
    const relation = dataOf(object)
    return String(relation.source) === selected?.objectId || String(relation.target) === selected?.objectId
  })
  return (
    <section className="role-plugin-view role-plugin-graph" aria-label="岗位关系图">
      <SnapshotBadge result={props.result} />
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${nodeObjects.length} 个岗位对象的关系图`}>
        <g className="role-plugin-graph-edges">
          {visibleRelations.map(object => {
            const relation = dataOf(object)
            const source = positions.get(String(relation.source))
            const target = positions.get(String(relation.target))
            if (!source || !target) return null
            return <line key={object.objectId} x1={source.x} y1={source.y} x2={target.x} y2={target.y}><title>{String(relation.type || '')}</title></line>
          })}
        </g>
        <g className="role-plugin-graph-nodes">
          {ordered.map(object => {
            const position = positions.get(object.objectId)!
            const category = categoryOf(object)
            const root = object.objectId === rootId
            return <g key={object.objectId} transform={`translate(${position.x} ${position.y})`}><circle r={root ? 34 : 23} fill={colorFor(category)} /><text y={root ? 49 : 37}>{object.label.length > 14 ? `${object.label.slice(0, 13)}…` : object.label}</text><title>{object.label} · {object.objectId}</title></g>
          })}
        </g>
      </svg>
      <div className="role-plugin-graph-toolbar"><span>显示 {nodeObjects.length}/{allNodes.length} 个节点 · {visibleRelations.length}/{relationObjects.length} 条关系</span>{allNodes.length > 16 && <button type="button" onClick={() => setExpanded(value => !value)}>{expanded ? '收起图谱' : `展示全部 ${allNodes.length} 个节点`}</button>}</div>
      <div className="role-plugin-graph-focus">{ordered.map(object => <button
        key={object.objectId}
        type="button"
        {...interactiveObjectProps(props, object)}
        aria-pressed={selected?.objectId === object.objectId}
        onClick={() => setSelectedId(object.objectId)}
      >{object.label}</button>)}</div>
      {selected && <article className="role-plugin-graph-inspector" {...interactiveObjectProps(props, selected)}>
        <header><span>{categoryOf(selected)}</span><strong>{selected.label}</strong><small>{selectedRelations.length} 条直接关系</small></header>
        <p>{String(dataOf(selected).summary || '')}</p>
        <div>{selectedRelations.map(object => {
          const relation = dataOf(object)
          const outgoing = String(relation.source) === selected.objectId
          const otherId = String(outgoing ? relation.target : relation.source)
          const other = allNodes.find(node => node.objectId === otherId)
          return <button key={object.objectId} type="button" onClick={() => other && setSelectedId(other.objectId)}>
            <small>{outgoing ? '→' : '←'} {String(relation.type || 'relation')}</small><strong>{other?.label || otherId}</strong>
          </button>
        })}</div>
        <FollowActions props={props} objectId={selected.objectId} label={selected.label} />
      </article>}
      <p className="role-plugin-legend">关系类型：{[...new Set(visibleRelations.map(object => String(dataOf(object).type || 'relation')))].join(' · ')}</p>
      {payload.truncated && <p className="role-plugin-boundary">子图达到本次节点上限；这是有界投影，不是完整岗位包。</p>}
    </section>
  )
}

function NodeRiskResearch(props: PluginToolRendererProps) {
  const riskObject = props.objects.find(item => item.objectType === 'role_node_risk')
  const data = riskObject ? dataOf(riskObject) : {}
  return <section className="role-plugin-view role-plugin-audit" aria-label="岗位节点风险研究">
    <SnapshotBadge result={props.result} />
    <header><strong>{String(data.focusLabel || '节点风险研究')}</strong><span>{String(data.question || '围绕节点证据、关系和过程边界进行解释')}</span></header>
    <div className="role-plugin-metrics"><span><strong>{String(data.evidence?.directBindings || 0)}</strong><small>直接证据</small></span><span><strong>{String(data.evidence?.neighborhoodBindings || 0)}</strong><small>邻域证据</small></span><span><strong>{String((data.neighborhoodIds || []).length)}</strong><small>研究节点</small></span></div>
    <div className="role-plugin-audit-issues">{(data.risks || []).map((risk: RecordValue) => <article key={String(risk.id)}><span>{String(risk.severity)}</span><strong>{String(risk.title)}</strong><p>{String(risk.detail)}</p>{risk.objectId && props.onPrompt && <button type="button" onClick={() => props.onPrompt?.(`解释风险节点“${String(risk.title)}”（对象 ${String(risk.objectId)}）`)}>继续解释</button>}</article>)}</div>
    {riskObject && props.onReference && <div className="role-plugin-actions"><button type="button" onClick={() => props.onReference?.(riskObject)}>引用研究结果</button></div>}
    <p className="role-plugin-boundary">{String(data.boundary || '')}</p>
  </section>
}

function ProcessForest(props: PluginToolRendererProps) {
  const nodes = props.objects.filter(object => object.objectType === 'role_object')
  const scenarios = nodes.filter(object => categoryOf(object) === 'scenario')
  const processNodes = nodes.filter(object => categoryOf(object) !== 'scenario')
  const payload = (props.result.payload || {}) as RecordValue
  return (
    <section className="role-plugin-view role-plugin-process" aria-label="岗位事理森林">
      <SnapshotBadge result={props.result} />
      <p className="role-plugin-boundary">{String(payload.boundary || '')}</p>
      {scenarios.map(scenario => {
        const scenarioData = dataOf(scenario)
        const items = processNodes.filter(object => String(dataOf(object).scenarioId || '') === scenario.objectId)
          .sort((left, right) => Number(dataOf(left).sequenceHint || 999) - Number(dataOf(right).sequenceHint || 999))
        return <article className="role-plugin-scenario" key={scenario.objectId}>
          <header><span>{String(scenarioData.knowledgeState || 'process')}</span><strong>{scenario.label}</strong><p>{String(scenarioData.summary || '')}</p></header>
          <div className="role-plugin-process-lanes">
            {items.map((object, index) => {
              const data = dataOf(object)
              const category = categoryOf(object)
              return <div className="role-plugin-process-step" key={object.objectId} style={{ '--role-accent': colorFor(category) } as CSSProperties} {...interactiveObjectProps(props, object)}><i>{index + 1}</i><span><small>{category}</small><strong>{object.label}</strong><p>{String(data.summary || '')}</p><FollowActions props={props} objectId={object.objectId} label={object.label} /></span></div>
            })}
          </div>
        </article>
      })}
      {payload.truncated && <p className="role-plugin-warning">场景节点已按本次工具预算截断。</p>}
    </section>
  )
}

function PackageCatalog(props: PluginToolRendererProps) {
  const payload = (props.result.payload || {}) as RecordValue
  const isNotFound = payload.matchStatus === 'not_found'
  const sourceLabel = (item: RecordValue) => ({
    official_builtin: '官方维护', reviewed_public: '审核通过', owner_private: '我维护的',
    role_agent_simulation: 'role-agent 模拟', installed: '本地已安装',
  } as Record<string, string>)[String(item.sourceKind || '')] || '可用岗位包'
  return <section className="role-plugin-view role-plugin-catalog" aria-label="岗位包目录">
    <header><strong>{isNotFound ? '暂未找到可用岗位包' : '可引用岗位包'}</strong><small>{String(payload.count || 0)} 个匹配版本</small></header>
    {isNotFound && <article className="role-plugin-empty"><span>继续查找或研究</span><strong>{String(payload.requestedRole || '新岗位')}</strong><p>当前插件目录里没有匹配的不可变岗位包。你可以先去共享 Graph Hub 查看其他已发布图谱，也可以进入 Role Atlas 为该岗位做研究和冷启动。</p><div className="role-plugin-actions">{payload.graphHubBrowseUrl && <a href={String(payload.graphHubBrowseUrl)} target="_blank" rel="noreferrer" onClick={event => openExternalProductLink(event, String(payload.graphHubBrowseUrl))}>打开 Graph Hub ↗</a>}{payload.roleAgentResearchUrl && <a href={String(payload.roleAgentResearchUrl)} target="_blank" rel="noreferrer" onClick={event => openExternalProductLink(event, String(payload.roleAgentResearchUrl))}>进入 Role Atlas 研究 ↗</a>}</div></article>}
    {(payload.packages || []).map((item: RecordValue) => <article key={`${String(item.packageId)}@${String(item.packageVersion)}`}><span>{sourceLabel(item)} · {String(item.roleTitle)}</span><strong>v{String(item.packageVersion)}</strong><p>{String(item.snapshotAsOf)} · <code>{String(item.snapshotId)}</code></p>{props.onPrompt && <button type="button" onClick={() => props.onPrompt?.(`引用这个岗位包。请调用 reference_role_package，并原样使用以下身份：packageId=${String(item.packageId)}；packageVersion=${String(item.packageVersion)}；snapshotId=${String(item.snapshotId)}；rootHash=${String(item.rootHash)}`)}>引用此岗位包</button>}</article>)}
    {payload.simulation && <p className="role-plugin-warning">{String(payload.simulation)}</p>}
    {Array.isArray(payload.warnings) && payload.warnings.length > 0 && <p className="role-plugin-warning">另有 {payload.warnings.length} 个 role-agent 目录项未通过协议校验，因此没有加入可引用列表。</p>}
    {!isNotFound && payload.graphHubBrowseUrl && <div className="role-plugin-actions"><a href={String(payload.graphHubBrowseUrl)} target="_blank" rel="noreferrer" onClick={event => openExternalProductLink(event, String(payload.graphHubBrowseUrl))}>在 Graph Hub 查看更多图谱 ↗</a></div>}
    <p className="role-plugin-boundary">{isNotFound ? 'Graph Hub 负责跨产品发现；Role Atlas 负责岗位包研究与迭代；LearnFlow 负责学习对话和个人学习状态。' : '选择动作会固定不可变版本，但不会安装、修改或发布岗位包。'}</p>
  </section>
}

function PackageReference(props: PluginToolRendererProps) {
  const reference = props.objects.find(item => item.objectType === 'role_package_reference')
  const value = (reference?.value || {}) as RecordValue
  const data = (value.data || {}) as RecordValue
  return <section className="role-plugin-view role-plugin-catalog" aria-label="岗位包引用">
    <header><strong>已引用岗位包</strong><small>固定到本次 ToolRun</small></header>
    <article><span>{String(value.roleTitle || reference?.label || '岗位包')}</span><strong>v{String(value.packageVersion || '—')}</strong><p><code>{String(value.snapshotId || '')}</code></p><p><code>{String(value.rootHash || '').slice(0, 20)}…</code></p></article>
    {reference && props.onReference && <div className="role-plugin-actions"><button type="button" onClick={() => props.onReference?.(reference)}>引用到输入框</button></div>}
    <p className="role-plugin-boundary">{String(data.boundary || '后续岗位读取必须复用该精确快照。')}</p>
  </section>
}

function PackageComparison(props: PluginToolRendererProps) {
  const payload = (props.result.payload || {}) as RecordValue
  const group = (title: string, values: string[]) => <section><header><strong>{title}</strong><b>{values.length}</b></header>{values.length ? <ul>{values.slice(0, 16).map(value => <li key={value}><code>{value}</code></li>)}</ul> : <p>无</p>}</section>
  return <section className="role-plugin-view role-plugin-comparison" aria-label="岗位包版本比较">
    <header><span>v{String(payload.base?.packageVersion || '—')}</span><i>→</i><span>v{String(payload.target?.packageVersion || '—')}</span></header>
    <div>{group('新增', payload.added || [])}{group('移除', payload.removed || [])}{group('内容变更', payload.changed || [])}{group('引用迁移', payload.referenceMigrationHits || [])}</div>
    {payload.truncated && <p className="role-plugin-boundary">差异列表已按单类 40 项截断。</p>}
  </section>
}

function EvidencePanel(props: PluginToolRendererProps) {
  const payload = (props.result.payload || {}) as RecordValue
  return (
    <section className="role-plugin-view role-plugin-evidence" aria-label="岗位证据">
      <SnapshotBadge result={props.result} />
      <div className="role-plugin-evidence-list">
        {props.objects.map(object => {
          const evidence = dataOf(object)
          const binding = evidence.binding || {}
          const segment = evidence.segment || {}
          const source = evidence.source || {}
          return <article key={object.objectId}><header><strong>{String(source.title || object.label)}</strong><span>{String(binding.assertionType || binding.support || 'evidence')}</span></header><blockquote>{String(segment.text || '该绑定没有可发布的原文片段。')}</blockquote><p>{String(source.publisher || '')}{segment.locator ? ` · ${segment.locator}` : ''}</p>{Array.isArray(binding.limitations) && binding.limitations.length > 0 && <small>限制：{binding.limitations.join('；')}</small>}</article>
        })}
      </div>
      {payload.truncated && <p className="role-plugin-warning">目标数量超过证据工具预算，已显式截断。</p>}
    </section>
  )
}

function AuditPanel(props: PluginToolRendererProps) {
  const payload = (props.result.payload || {}) as RecordValue
  const validation = payload.validation || {}
  const stats = validation.stats || {}
  const issues = validation.audit?.issues || []
  return (
    <section className="role-plugin-view role-plugin-audit" aria-label="岗位包审计">
      <SnapshotBadge result={props.result} />
      <header className={validation.valid ? 'valid' : 'invalid'}><strong>{validation.valid ? '协议有效' : '协议无效'}</strong><span>这表示包可读取，不表示内容已经完整，也不表示学习者掌握。</span></header>
      <div className="role-plugin-metrics">{Object.entries(stats).map(([key, value]) => <span key={key}><strong>{String(value)}</strong><small>{key}</small></span>)}</div>
      <div className="role-plugin-audit-issues">{issues.map((issue: RecordValue) => <article key={String(issue.id)}><span>{String(issue.severity)}</span><strong>{String(issue.title)}</strong><p>{String(issue.detail)}</p></article>)}</div>
      {Array.isArray(validation.warnings) && validation.warnings.length > 0 && <details><summary>已知警告 {validation.warnings.length}</summary><ul>{validation.warnings.map((warning: string) => <li key={warning}>{warning}</li>)}</ul></details>}
    </section>
  )
}

const GRAPH_TYPE_LABELS: Record<string, string> = {
  learning_path: '学习路径', role_semantic: '岗位语义', role_process: '工作过程', knowledge: '知识图谱', custom: '自定义图谱',
}

function GraphHubRecommendation(props: PluginToolRendererProps) {
  const payload = (props.result.payload || {}) as RecordValue
  const recommendations = useMemo(() => {
    const values = Array.isArray(payload.recommendations) && payload.recommendations.length
      ? payload.recommendations
      : props.objects.map(object => object.value as RecordValue)
    return values.filter(value => value && typeof value === 'object')
  }, [payload.recommendations, props.objects])
  const [typeFilter, setTypeFilter] = useState('all')
  const [textFilter, setTextFilter] = useState('')
  const types = useMemo(() => [...new Set(recommendations.map(item => String(item.graphType || 'custom')))], [recommendations])
  const filtered = useMemo(() => {
    const query = textFilter.trim().toLocaleLowerCase()
    return recommendations.filter(item => {
      if (typeFilter !== 'all' && String(item.graphType) !== typeFilter) return false
      if (!query) return true
      return [item.title, item.summary, ...(Array.isArray(item.keywords) ? item.keywords : []), ...(Array.isArray(item.matchedNodes) ? item.matchedNodes.flatMap((node: RecordValue) => [node.label, node.summary]) : [])]
        .join(' ').toLocaleLowerCase().includes(query)
    })
  }, [recommendations, textFilter, typeFilter])
  return <section className="role-plugin-view role-plugin-hub" aria-label="图谱推荐结果">
    <header className="role-plugin-hub-header"><div><span>GRAPH HUB</span><strong>图谱推荐</strong><small>{String(payload.query || '')}</small></div><label>筛选结果<input value={textFilter} onChange={event => setTextFilter(event.target.value)} placeholder="按名称或节点筛选" /></label></header>
    <nav className="role-plugin-hub-filters" aria-label="图谱类型筛选">
      <button type="button" aria-pressed={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>全部 <b>{recommendations.length}</b></button>
      {types.map(type => <button type="button" key={type} aria-pressed={typeFilter === type} onClick={() => setTypeFilter(type)}>{GRAPH_TYPE_LABELS[type] || type} <b>{recommendations.filter(item => String(item.graphType) === type).length}</b></button>)}
    </nav>
    {filtered.length ? <div className="role-plugin-hub-grid">{filtered.map(item => <article key={`${String(item.graphId)}@${String(item.graphVersion)}`}>
      <header><span>{GRAPH_TYPE_LABELS[String(item.graphType)] || String(item.graphType || '自定义图谱')}</span><strong>{String(item.title || '未命名图谱')}</strong><small>匹配度 {String(item.score ?? '—')}</small></header>
      <p>{String(item.summary || '暂无图谱简介。')}</p>
      <div className="role-plugin-hub-meta"><span>{item.review === 'official' ? '官方' : item.review === 'approved' ? '已审核' : '主体可见'}</span><span>{item.access === 'owner' ? '仅所有者' : '公开可见'}</span><code>{String(item.graphId || '')}@{String(item.graphVersion || '')}</code></div>
      {Array.isArray(item.matchedNodes) && item.matchedNodes.length > 0 && <details><summary>命中节点 {item.matchedNodes.length}</summary><ul>{item.matchedNodes.map((node: RecordValue) => <li key={String(node.id)}><strong>{String(node.label || node.id)}</strong><small>{String(node.summary || '')}</small></li>)}</ul></details>}
      {props.onPrompt && <button type="button" onClick={() => props.onPrompt?.(`继续围绕图谱“${String(item.title || '')}”检索相关学习内容`)}>继续检索</button>}
    </article>)}</div> : <p className="role-plugin-card-empty">没有匹配当前筛选条件的图谱。</p>}
    <footer className="role-plugin-hub-footer">当前可见 {String(payload.coverage?.visibleGraphs ?? recommendations.length)} 个图谱 · 返回 {filtered.length} 个 · 结果仅用于发现，不会自动引用或修改图谱。</footer>
  </section>
}

const plugin = defineLearnFlowPluginClient({
  pluginId: ROLE_CAPABILITY_PLUGIN.id,
  name: ROLE_CAPABILITY_PLUGIN.name,
  description: ROLE_CAPABILITY_PLUGIN.description,
  icon: ROLE_CAPABILITY_PLUGIN.icon,
  renderers: {
    [ROLE_RENDERERS.overview]: RoleOverview,
    [ROLE_RENDERERS.cards]: RoleCards,
    [ROLE_RENDERERS.radar]: CapabilityRadar,
    [ROLE_RENDERERS.graph]: RoleGraph,
    [ROLE_RENDERERS.process]: ProcessForest,
    [ROLE_RENDERERS.evidence]: EvidencePanel,
    [ROLE_RENDERERS.audit]: AuditPanel,
    [ROLE_RENDERERS.catalog]: PackageCatalog,
    [ROLE_RENDERERS.packageReference]: PackageReference,
    [ROLE_RENDERERS.comparison]: PackageComparison,
    [ROLE_RENDERERS.nodeRisk]: NodeRiskResearch,
    [ROLE_RENDERERS.graphHub]: GraphHubRecommendation,
  },
})

export default plugin
