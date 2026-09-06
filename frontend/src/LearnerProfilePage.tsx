import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  FormalConceptEdge,
  FormalConceptNode,
  FormalLearnerProfilePatch,
  FormalLearnerSnapshot,
  FormalRuntimeConnection,
  KernelName,
} from './formal-runtime'
import {
  presentClaimText,
  presentEvidenceCount,
  presentModuleScope,
  presentModuleTitle,
  presentVerification,
} from './profile-presentation'

import { buildProfileOverview, profileGrowthArea, profileTimeLabel } from './profile-overview'
import './profile-overview.css'

const KERNELS: Array<{ id: KernelName; name: string; short: string; description: string }> = [
  { id: 'structure', name: '结构核', short: '结构', description: '学习位置、路径依赖、当前锚点与可返回的位置。它与知识核共享主题标识，但不替知识核判断掌握。' },
  { id: 'knowledge', name: '知识核', short: '知识', description: '概念理解、误解、缺口与经过验证的表现。自报学过只记为接触，不自动升级为掌握。' },
  { id: 'human', name: '人因核', short: '人因', description: '节奏、负荷、可访问性、偏好与支持需求。只保留能改善学习的凝练信息，敏感内容优先可见、可纠正。' },
  { id: 'value', name: '价值核', short: '价值', description: '目标、兴趣、优先级与意义连接。长期方向必须由你明确确认，规划 Agent 只能提出候选。' },
  { id: 'practice', name: '实践核', short: '实践', description: '尝试、支架等级、可检查产物、迁移与项目表现。讲解完成、一次答对或自述都不能代替独立实践证据。' },
]

type Props = {
  connection: FormalRuntimeConnection
  snapshot?: FormalLearnerSnapshot
  busyKey: string
  error: string
  onRefresh: () => void
  onOpenPath: () => void
  onMemoryArchive: (memoryId: string, archived: boolean) => void
  onClaimAction: (claimId: number, action: 'confirm' | 'correct' | 'retract', correction?: string) => void
  onRecordSelfReport: (rawText: string) => Promise<boolean>
  onUpdateProfile: (patch: FormalLearnerProfilePatch) => Promise<boolean>
}

type ConceptPosition = {
  x: number
  y: number
  width: number
  height: number
  lane: number
}

const CONCEPT_CANVAS_WIDTH = 760
const CONCEPT_CARD_HEIGHT = 40

const KNOWLEDGE_LANES = [
  { label: '用户自述', caption: '接触与待验证', color: '#82705d' },
  { label: '学习中验证', caption: '事件与冲突证据', color: '#3f718c' },
  { label: '稳定认识', caption: '证据支持的 Claim', color: '#247052' },
]

const STRUCTURE_LANES = [
  { label: '前置与来源', caption: '从哪里来' },
  { label: '当前连接', caption: '正在形成关系' },
  { label: '迁移与应用', caption: '向哪里去' },
  { label: '后续概念', caption: '可继续展开' },
]

function conceptKnowledgeStatus(node: FormalConceptNode) {
  return node.knowledge.current_state?.status
    || (node.knowledge.timeline.length ? 'self_report_only' : 'relation_only')
}

function knowledgeLane(node: FormalConceptNode) {
  const status = conceptKnowledgeStatus(node)
  if (status === 'evidence_backed_claim' || node.knowledge.current_state?.certain_claims.length) return 2
  if (status === 'verified_events' || status === 'conflicting_evidence' || node.knowledge.verified_count > 0) return 1
  return 0
}

function layoutKnowledgeConcepts(nodes: FormalConceptNode[]) {
  const laneRows = [0, 0, 0]
  const positions = new Map<string, ConceptPosition>()
  nodes.forEach(node => {
    const lane = knowledgeLane(node)
    const row = laneRows[lane]++
    positions.set(node.concept_key, {
      x: 24 + lane * 246,
      y: 72 + row * 49,
      width: 220,
      height: CONCEPT_CARD_HEIGHT,
      lane,
    })
  })
  return {
    positions,
    height: Math.max(330, 88 + Math.max(...laneRows) * 49),
  }
}

function layoutStructureConcepts(nodes: FormalConceptNode[], edges: FormalConceptEdge[]) {
  const nodeKeys = new Set(nodes.map(node => node.concept_key))
  const visibleEdges = edges.filter(edge => nodeKeys.has(edge.source_key) && nodeKeys.has(edge.target_key))
  const positions = new Map<string, ConceptPosition>()
  if (visibleEdges.length === 0) {
    nodes.forEach((node, index) => {
      const column = index % 3
      const row = Math.floor(index / 3)
      positions.set(node.concept_key, {
        x: 35 + column * 240,
        y: 80 + row * 54,
        width: 210,
        height: CONCEPT_CARD_HEIGHT,
        lane: column,
      })
    })
    return { positions, height: Math.max(330, 100 + Math.ceil(nodes.length / 3) * 54), hasRelations: false }
  }

  const incoming = new Map(nodes.map(node => [node.concept_key, 0]))
  const outgoing = new Map(nodes.map(node => [node.concept_key, [] as string[]]))
  visibleEdges.forEach(edge => {
    incoming.set(edge.target_key, (incoming.get(edge.target_key) || 0) + 1)
    outgoing.get(edge.source_key)?.push(edge.target_key)
  })
  const queue = nodes.filter(node => incoming.get(node.concept_key) === 0).map(node => node.concept_key)
  const layers = new Map(nodes.map(node => [node.concept_key, 0]))
  const visited = new Set<string>()
  while (queue.length) {
    const key = queue.shift()!
    if (visited.has(key)) continue
    visited.add(key)
    outgoing.get(key)?.forEach(target => {
      layers.set(target, Math.max(layers.get(target) || 0, (layers.get(key) || 0) + 1))
      incoming.set(target, (incoming.get(target) || 0) - 1)
      if (incoming.get(target) === 0) queue.push(target)
    })
  }
  nodes.filter(node => !visited.has(node.concept_key)).forEach(node => layers.set(node.concept_key, 1))
  const maxLayer = Math.max(1, ...layers.values())
  const laneRows = [0, 0, 0, 0]
  nodes.forEach(node => {
    const rawLayer = layers.get(node.concept_key) || 0
    const lane = Math.min(3, Math.round((rawLayer / maxLayer) * 3))
    const row = laneRows[lane]++
    positions.set(node.concept_key, {
      x: 18 + lane * 186,
      y: 72 + row * 51,
      width: 168,
      height: CONCEPT_CARD_HEIGHT,
      lane,
    })
  })
  return { positions, height: Math.max(330, 90 + Math.max(...laneRows) * 51), hasRelations: true }
}

function conceptEdgePath(source: ConceptPosition, target: ConceptPosition) {
  const fromRight = target.x >= source.x
  const x1 = fromRight ? source.x + source.width : source.x
  const x2 = fromRight ? target.x : target.x + target.width
  const y1 = source.y + source.height / 2
  const y2 = target.y + target.height / 2
  const bend = Math.max(28, Math.abs(x2 - x1) * .46)
  const c1 = x1 + (fromRight ? bend : -bend)
  const c2 = x2 - (fromRight ? bend : -bend)
  return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`
}

function PersonalConceptGraph({ snapshot, kernel }: { snapshot: FormalLearnerSnapshot; kernel: KernelName }) {
  const [selectedKey, setSelectedKey] = useState('')
  const [hoveredKey, setHoveredKey] = useState('')
  const graph = snapshot.concept_graph
  const visibleNodes = graph.nodes.slice(0, 18)
  const visibleKeys = new Set(visibleNodes.map(node => node.concept_key))
  const visibleEdges = graph.edges.filter(edge => visibleKeys.has(edge.source_key) && visibleKeys.has(edge.target_key))
  const selected = graph.nodes.find(node => node.concept_key === selectedKey) || visibleNodes[0]
  const layout = kernel === 'knowledge'
    ? { ...layoutKnowledgeConcepts(visibleNodes), hasRelations: false }
    : layoutStructureConcepts(visibleNodes, visibleEdges)
  const positions = layout.positions
  const focusKey = hoveredKey || selected?.concept_key || ''
  const relatedKeys = new Set<string>([focusKey])
  visibleEdges.forEach(edge => {
    if (edge.source_key === focusKey) relatedKeys.add(edge.target_key)
    if (edge.target_key === focusKey) relatedKeys.add(edge.source_key)
  })
  const selectedEdges = selected
    ? graph.edges.filter(edge => edge.source_key === selected.concept_key || edge.target_key === selected.concept_key)
    : []
  const currentState = selected?.knowledge.current_state || {
    status: selected?.knowledge.timeline.length ? 'self_report_only' : 'relation_only',
    certain_claims: [],
    uncertain_observations: [],
    conflicts: [],
  }

  return (
    <section className={`personal-concept-panel concept-panel-${kernel}`}>
      <header>
        <div><span>KNOWLEDGE × STRUCTURE</span><h2>个人概念学习图</h2><p>节点身份共享；节点内部的认识历程归知识核，节点之间的关系归结构核。</p></div>
        <div><strong>{graph.manifest.node_count}</strong><small>概念</small><strong>{graph.manifest.edge_count}</strong><small>关系</small></div>
      </header>
      {visibleNodes.length === 0 ? (
        <p className="formal-empty-copy">尚无个人概念节点。可在上方录入明确自述，或在学习过程中由正式事件逐步形成。</p>
      ) : (
        <div className="personal-concept-layout">
          <div className="concept-graph-canvas">
            <div className="concept-graph-guide">
              <div><strong>{kernel === 'knowledge' ? '认识成熟度' : '关系方向'}</strong><span>{kernel === 'knowledge' ? '每个概念沿证据链移动，不用单一掌握度替代历程' : '箭头从来源指向被支持、被阻碍或被迁移的概念'}</span></div>
              <small>{kernel === 'knowledge' ? '自述 → 验证 → Claim' : visibleEdges.length ? '悬停聚焦一跳 · 点击固定概念' : '当前只有节点，没有已验证关系'}</small>
            </div>
            <svg viewBox={`0 0 ${CONCEPT_CANVAS_WIDTH} ${layout.height}`} role="img" aria-label="个人概念学习图">
              <defs>
                <marker id="concept-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" /></marker>
              </defs>
              {kernel === 'knowledge' ? <>
                {KNOWLEDGE_LANES.map((lane, index) => <g key={lane.label} className="concept-lane-heading" transform={`translate(${24 + index * 246},18)`}>
                  <rect width="220" height="36" rx="8" style={{ '--concept-lane-color': lane.color } as CSSProperties} />
                  <text x="11" y="15">{lane.label}</text><text className="concept-lane-caption" x="11" y="27">{lane.caption}</text>
                </g>)}
                <path className="concept-maturity-arrow" d="M 236 36 L 268 36 M 482 36 L 514 36" markerEnd="url(#concept-arrow)" />
              </> : <>
                {layout.hasRelations && STRUCTURE_LANES.map((lane, index) => <g key={lane.label} className="concept-lane-heading structure" transform={`translate(${18 + index * 186},18)`}>
                  <text x="8" y="13">{lane.label}</text><text className="concept-lane-caption" x="8" y="25">{lane.caption}</text>
                </g>)}
                {!layout.hasRelations && <text className="concept-isolated-note" x="35" y="42">未记录概念之间的前置、阻碍、推动或迁移关系；以下节点按孤立概念展示。</text>}
              </>}
              {kernel === 'structure' && visibleEdges.map(edge => {
                const source = positions.get(edge.source_key)
                const target = positions.get(edge.target_key)
                if (!source || !target) return null
                const highlighted = focusKey === edge.source_key || focusKey === edge.target_key
                const muted = focusKey && !highlighted
                const mx = (source.x + source.width + target.x) / 2
                const my = (source.y + target.y) / 2 + 13
                return <g key={edge.id} className={`concept-edge${highlighted ? ' highlighted' : ''}${muted ? ' muted' : ''}`}>
                  <path d={conceptEdgePath(source, target)} markerEnd="url(#concept-arrow)" />
                  {highlighted && <text x={mx} y={my}>{edge.label}</text>}
                </g>
              })}
              {visibleNodes.map(node => {
                const position = positions.get(node.concept_key)!
                const active = selected?.concept_key === node.concept_key
                const muted = kernel === 'structure' && layout.hasRelations && Boolean(focusKey) && !relatedKeys.has(node.concept_key)
                const state = conceptKnowledgeStatus(node)
                return <g key={node.concept_key} role="button" tabIndex={0} aria-label={`查看${node.name}`} className={`concept-node concept-node-card${active ? ' active' : ''}${muted ? ' muted' : ''} state-${state}`} transform={`translate(${position.x},${position.y})`} onMouseEnter={() => setHoveredKey(node.concept_key)} onMouseLeave={() => setHoveredKey('')} onClick={() => setSelectedKey(node.concept_key)} onKeyDown={event => { if (event.key === 'Enter') setSelectedKey(node.concept_key) }}>
                  <rect width={position.width} height={position.height} rx="8" />
                  <circle cx="12" cy="13" r="3" />
                  <text x="21" y="16">{node.name.length > 13 ? `${node.name.slice(0, 12)}…` : node.name}</text>
                  <text className="concept-node-count" x="12" y="30">{kernel === 'knowledge' ? `${node.knowledge_event_count} 条认识历程 · ${node.knowledge.verified_count} 条验证` : `${node.structure_relation_count} 条关系`}</text>
                </g>
              })}
            </svg>
            {graph.nodes.length > visibleNodes.length && <small>当前显示最相关的 {visibleNodes.length} 个节点；详情列表仍保留全部 {graph.nodes.length} 个节点。</small>}
          </div>
          <aside className="concept-node-inspector">
            {selected && <>
              <span>{selected.official_node_id ? '官方课程节点叠加' : '个人概念节点'}</span>
              <h3>{selected.name}</h3>
              <code>{selected.concept_key}</code>
              <div className="concept-inspector-stats"><b>{selected.knowledge_event_count}<small>知识历程</small></b><b>{selected.structure_relation_count}<small>结构关系</small></b><b>{selected.knowledge.verified_count}<small>验证证据</small></b></div>
              {kernel === 'knowledge' ? (
                <div className="concept-timeline">
                  <h4>节点内部发生了什么</h4>
                  <div className={`concept-current-state state-${currentState.status}`}>
                    <b>{currentState.status === 'self_report_only' ? '目前只有自述，等待验证' : currentState.status === 'evidence_backed_claim' ? '已有证据支持的可纠正认识' : currentState.status === 'conflicting_evidence' ? '当前证据存在冲突' : currentState.status === 'verified_events' ? '已有验证事件，尚未凝练 Claim' : '尚无节点内部证据'}</b>
                    <span>{currentState.uncertain_observations.length} 条模糊/缺口 · {currentState.conflicts.length} 条冲突</span>
                  </div>
                  {currentState.certain_claims.slice(-2).map(claim => <article key={`claim-${claim.claim_id}`} className="concept-evidence-claim">
                    <i /><div><span>Claim · {claim.verification_status} · {Math.round(claim.confidence * 100)}%</span><p>{claim.statement}</p></div>
                  </article>)}
                  {selected.knowledge.timeline.length === 0 && <p>目前只有结构关系，还没有知识历程。</p>}
                  {[...selected.knowledge.timeline].reverse().slice(0, 6).map(item => <article key={item.fact_id}>
                    <i /><div><span>{item.observation_type} · {item.verification}</span><p>{item.statement}</p>{item.raw_text && <details><summary>查看保留的原文</summary><q>{item.raw_text}</q></details>}</div>
                  </article>)}
                </div>
              ) : (
                <div className="concept-relation-list">
                  <h4>它与什么相连</h4>
                  {selectedEdges.length === 0 && <p>还没有记录概念关系。</p>}
                  {selectedEdges.slice(0, 8).map(edge => {
                    const outgoing = edge.source_key === selected.concept_key
                    const peerKey = outgoing ? edge.target_key : edge.source_key
                    const peer = graph.nodes.find(node => node.concept_key === peerKey)
                    return <article key={edge.id}><b>{outgoing ? '→' : '←'} {edge.label}</b><span>{peer?.name || peerKey}</span><p>{edge.rationale || '暂无关系说明'}</p><small>{edge.verification} · 不推断掌握</small></article>
                  })}
                </div>
              )}
            </>}
          </aside>
        </div>
      )}
      <footer>官方课程图描述一般培养路径；这里描述你实际怎样理解、联想、受阻和迁移。规划时两张图可以叠加，但不会合并权威。</footer>
    </section>
  )
}

export default function LearnerProfilePage({
  connection, snapshot, busyKey, error, onRefresh, onOpenPath, onMemoryArchive, onClaimAction, onRecordSelfReport, onUpdateProfile,
}: Props) {
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const recordsRef = useRef<HTMLDetailsElement>(null)
  const [activeKernel, setActiveKernel] = useState<KernelName>('structure')
  const [corrections, setCorrections] = useState<Record<number, string>>({})
  const [selfReport, setSelfReport] = useState('')
  const [background, setBackground] = useState('')
  const [weeklyHours, setWeeklyHours] = useState(8)
  const [preferredModes, setPreferredModes] = useState('')
  const [focusAreas, setFocusAreas] = useState('')
  const [careerGoal, setCareerGoal] = useState('')
  const [careerGoalConfirmed, setCareerGoalConfirmed] = useState(false)
  const meta = KERNELS.find(item => item.id === activeKernel) || KERNELS[0]
  const area = snapshot ? profileGrowthArea(snapshot.growth.areas, activeKernel) : undefined
  const modules = useMemo(
    () => snapshot?.modules.filter(item => item.kernel === activeKernel) || [],
    [activeKernel, snapshot],
  )
  useEffect(() => {
    if (!snapshot) return
    setBackground(snapshot.profile.background || '')
    setWeeklyHours(snapshot.profile.weekly_hours || 8)
    setPreferredModes(snapshot.profile.preferred_modes.join('、'))
    setFocusAreas(snapshot.profile.focus_areas.join('、'))
    setCareerGoal(snapshot.profile.career_goal || '')
    setCareerGoalConfirmed(snapshot.profile.career_goal_status === 'confirmed')
  }, [snapshot])

  const splitItems = (value: string) => [...new Set(value.split(/[，,、\n]/).map(item => item.trim()).filter(Boolean))]

  if (!snapshot) {
    return (
      <section className="profile-page formal-empty-page">
        <div className="formal-empty-card">
          <span className="eyebrow">FIVE-KERNEL AUTHORITY</span>
          <h1>正式五核尚未连接</h1>
          <p>{connection.detail || '正在读取正式用户状态。'}</p>
          <button type="button" onClick={onRefresh}>重新连接</button>
        </div>
      </section>
    )
  }

  return (
    <section className="profile-page formal-profile-page">
      <header className="profile-page-heading">
        <div>
          <h1>{snapshot.learner.display_name}的学习画像</h1>
          <p>你的基础、目标、偏好，以及学习过程中逐渐形成的认识。</p>
        </div>
        <div className="profile-version formal-authority-badge">
          <i /> <span>{connection.status === 'connected' ? '已同步' : '离线'}</span>
        </div>
      </header>

      {error && <div className="formal-inline-error" role="alert">{error}</div>}

      <div className="profile-learning-overview">
        {buildProfileOverview(snapshot).map(section => <section key={section.id} className="profile-learning-section">
          <header><h2>{section.title}</h2><button type="button" onClick={() => {
            setActiveKernel(section.kernel)
            setRecordsOpen(true)
            setEditorOpen(section.id !== 'progress')
            requestAnimationFrame(() => recordsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
          }}>{section.id === 'progress' ? '查看依据' : '修改'}</button></header>
          {section.items.length ? <ul>{section.items.map(item => <li key={item.id}>
            <p>{item.text}</p><small>{item.source}</small>
            <small><time>{profileTimeLabel(item.time)}</time>{item.time ? ' · 记录时间' : ''}</small>
          </li>)}</ul> : <p className="formal-empty-copy">{section.empty}</p>}
        </section>)}
      </div>
      <div className="profile-overview-footer"><span>这里呈现当前已读取的资料。自述帮助选择讲解起点，具体能力由学习表现逐步确认。</span><button type="button" onClick={onOpenPath}>打开学习路径</button></div>

      <details className="profile-input-disclosure">
        <summary>＋ 补充学习经历、阻碍或联想</summary>
        <form onSubmit={event => {
          event.preventDefault()
          if (!selfReport.trim()) return
          void onRecordSelfReport(selfReport.trim()).then(saved => { if (saved) setSelfReport('') })
        }}>
          <p>可以写“我学过……”“我不懂……”或某个知识怎样阻碍、推动了理解。</p>
          <textarea value={selfReport} onChange={event => setSelfReport(event.target.value)} placeholder="例如：我学过概率论，但条件概率总是搞混。链式法则帮助我理解反向传播。" />
          <button type="submit" disabled={!selfReport.trim() || busyKey === 'concept-report'}>{busyKey === 'concept-report' ? '正在保存…' : '记录明确自述'}</button>
        </form>
      </details>

      <details ref={recordsRef} className="profile-record-disclosure" open={recordsOpen} onToggle={event => setRecordsOpen(event.currentTarget.open)}>
        <summary>查看与管理全部学习认识</summary>
      <nav className="kernel-tabs" aria-label="五核切换" role="tablist">
        {KERNELS.map(item => (
          <button key={item.id} type="button" role="tab" aria-selected={activeKernel === item.id} className={activeKernel === item.id ? 'active' : ''} onClick={() => setActiveKernel(item.id)}>
            <span>{item.short}</span><small>{snapshot.modules.filter(module => module.kernel === item.id).length} 个主题</small>
          </button>
        ))}
      </nav>

      <div className="kernel-definition-card">
        <div><span>{meta.name}</span><p>{meta.description}</p></div>
        <small>{area?.active_count || 0} 条当前参考</small>
      </div>

      <details className={`kernel-explicit-editor kernel-explicit-editor-${activeKernel}`} open={editorOpen} onToggle={event => setEditorOpen(event.currentTarget.open)}>
        <summary>修改{activeKernel === 'knowledge' ? '学习背景' : activeKernel === 'human' ? '学习支持设置' : activeKernel === 'value' ? '目标与方向' : '学习记录'}</summary>
        <div className="kernel-editor-body">
        {activeKernel === 'knowledge' && (
          <form onSubmit={event => { event.preventDefault(); if (background.trim()) void onUpdateProfile({ background: background.trim() }) }}>
            <p>知识背景只作为“用户自述、待验证”写入；具体概念的认识、误解和题目历程请使用上方“补充到个人概念图”。</p>
            <label><span>我的知识背景原文</span><textarea value={background} onChange={event => setBackground(event.target.value)} maxLength={500} /></label>
            <button type="submit" disabled={!background.trim() || busyKey === 'profile-edit'}>更新知识背景自述</button>
          </form>
        )}
        {activeKernel === 'structure' && (
          <div className="kernel-edit-guidance">
            <p>结构核不接受一个模糊的“掌握度”开关。用上方自述记录“谁阻碍谁、谁推动谁、联想到什么”；用学习路径页确认、修订或归档长期路线。</p>
            <button type="button" onClick={onOpenPath}>打开学习路径与目标</button>
          </div>
        )}
        {activeKernel === 'human' && (
          <form onSubmit={event => {
            event.preventDefault()
            const modes = splitItems(preferredModes).slice(0, 6)
            if (modes.length) void onUpdateProfile({ weekly_hours: weeklyHours, preferred_modes: modes })
          }}>
            <p>只记录能改善教学的节奏、负荷和形式偏好。它们是明确偏好，不会被解释成人格或固定学习风格。</p>
            <div className="kernel-edit-row"><label><span>每周可投入小时</span><input type="number" min="1" max="80" value={weeklyHours} onChange={event => setWeeklyHours(Number(event.target.value) || 1)} /></label><label><span>偏好形式（用顿号分隔）</span><input value={preferredModes} onChange={event => setPreferredModes(event.target.value)} placeholder="可视化、定义后直接举例、代码" /></label></div>
            <button type="submit" disabled={!splitItems(preferredModes).length || busyKey === 'profile-edit'}>更新人因偏好</button>
          </form>
        )}
        {activeKernel === 'value' && (
          <form onSubmit={event => {
            event.preventDefault()
            const areas = splitItems(focusAreas).slice(0, 5)
            if (!areas.length || careerGoalConfirmed && !careerGoal.trim()) return
            void onUpdateProfile({ focus_areas: areas, career_goal: careerGoal.trim(), career_goal_status: careerGoalConfirmed ? 'confirmed' : 'exploring' })
          }}>
            <p>兴趣与方向可以随时修订；只有勾选确认的长期方向才进入 Value 长期记忆。规划 Agent 可以提议，但不能替你确认。</p>
            <div className="kernel-edit-row"><label><span>关注方向</span><input value={focusAreas} onChange={event => setFocusAreas(event.target.value)} placeholder="机器学习、Agent、强化学习" /></label><label><span>职业或研究方向</span><input value={careerGoal} onChange={event => setCareerGoal(event.target.value)} placeholder="例如：Agent 工程或机器学习科研" /></label></div>
            <label className="kernel-edit-confirm"><input type="checkbox" checked={careerGoalConfirmed} onChange={event => setCareerGoalConfirmed(event.target.checked)} /><span>这是我当前明确确认的长期方向（以后仍可修订或撤回）</span></label>
            <button type="submit" disabled={!splitItems(focusAreas).length || careerGoalConfirmed && !careerGoal.trim() || busyKey === 'profile-edit'}>更新价值目标</button>
          </form>
        )}
        {activeKernel === 'practice' && (
          <div className="kernel-edit-guidance kernel-edit-boundary">
            <p>实践核不能靠自述把自己升级为“会做”。你可以在下方纠正或撤回已有 Claim；新的正向结论只能来自做题、代码、项目产物、独立重做或迁移验证。</p>
          </div>
        )}
        </div>
      </details>

      {(activeKernel === 'knowledge' || activeKernel === 'structure') && <details className="concept-graph-disclosure"><summary>个人概念学习图</summary><PersonalConceptGraph snapshot={snapshot} kernel={activeKernel} /></details>}

      <div className="formal-profile-grid" role="tabpanel" aria-label={meta.name}>
        <section className="kernel-memory-column">
          <header><div><span>Agent 当前可参考</span><h2>核状态记忆</h2></div><small>{area?.active_count || 0} 条有效</small></header>
          {(area?.memories || []).length === 0 && <p className="formal-empty-copy">这个核还没有可展示的有效记忆。它会随着明确自述、学习事件和可验证表现逐步形成。</p>}
          {(area?.memories || []).map(memory => (
            <article key={memory.memory_id} className={`kernel-memory-row ${memory.status === 'archived' ? 'archived' : ''}`}>
              <div><span>{memory.retention_label} · {memory.source_label}</span><h3>{memory.title}</h3><p>{memory.summary}</p><small>{memory.related_record_count} 条关联记录 · {profileTimeLabel(memory.updated_at)}{memory.updated_at ? ' 更新' : ''}</small></div>
              <button
                type="button"
                disabled={busyKey === `memory:${memory.memory_id}`}
                onClick={() => onMemoryArchive(memory.memory_id, memory.status !== 'archived')}
              >{memory.status === 'archived' ? '恢复使用' : '停止使用'}</button>
            </article>
          ))}
        </section>

        <section className="kernel-module-column">
          <header><div><span>长期认识如何形成</span><h2>主题记忆与可纠正认识</h2></div><small>{modules.length} 个主题</small></header>
          <div className="memory-formation-map" aria-label="长期记忆形成过程">
            <div><b>学习事件</b><span>回答、选择与实践</span></div><i aria-hidden="true">→</i>
            <div><b>Fact</b><span>记录发生了什么</span></div><i aria-hidden="true">→</i>
            <div className="module-stage"><b>Module</b><span>按主题归在一起</span></div><i aria-hidden="true">→</i>
            <div className="claim-stage"><b>Claim</b><span>形成可纠正认识</span></div>
          </div>
          {modules.length === 0 && <p className="formal-empty-copy">当前还没有形成稳定的主题记忆。学习事件会先成为事实；只有相关事实达到本核门槛，才会凝练为 Module 和可纠正的 Claim。</p>}
          {modules.map(module => {
            const title = presentModuleTitle(module)
            return (
              <details key={module.id} className="formal-module-card">
                <summary>
                  <div className="module-node-mark" aria-hidden="true">M</div>
                  <div className="module-summary-copy">
                    <span>主题记忆 · {presentModuleScope(module)}</span>
                    <strong>{title}</strong>
                    <p>{presentEvidenceCount(module)}</p>
                  </div>
                  <div className="module-summary-meta"><em>第 {module.version} 版</em><small>{module.claims.length} 条认识</small></div>
                </summary>
                <div className="formal-claim-list">
                  {module.claims.map(claim => (
                    <article key={claim.id} className={claim.status === 'challenged' ? 'challenged' : ''}>
                      <div className="claim-node-mark" aria-hidden="true">C</div>
                      <div className="claim-node-body">
                        <div className="claim-node-heading"><span>可纠正认识 Claim</span><b>{presentVerification(claim)} · {Math.round(claim.confidence * 100)}%</b></div>
                        <p>{presentClaimText(module, claim)}</p>
                        <small>{presentModuleScope(module)} · {presentEvidenceCount(module)} · 未提供形成时间</small>
                        <div className="claim-actions">
                          <button type="button" disabled={busyKey === `claim:${claim.id}`} onClick={() => onClaimAction(claim.id, 'confirm')}>仍然准确</button>
                          <details>
                            <summary>修改</summary>
                            <textarea value={corrections[claim.id] || ''} onChange={event => setCorrections(previous => ({ ...previous, [claim.id]: event.target.value }))} placeholder="写出你认为更准确的版本" />
                            <button type="button" disabled={!corrections[claim.id]?.trim() || busyKey === `claim:${claim.id}`} onClick={() => onClaimAction(claim.id, 'correct', corrections[claim.id])}>保存修改</button>
                          </details>
                          <button type="button" className="claim-retract" disabled={busyKey === `claim:${claim.id}`} onClick={() => onClaimAction(claim.id, 'retract')}>停止使用</button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
                <details className="memory-technical-record">
                  <summary>查看形成依据与技术记录</summary>
                  <div><span>主题键</span><code>{module.subject_key}</code></div>
                  <div><span>事实依据</span><code>{module.evidence_fact_ids.length ? module.evidence_fact_ids.join('、') : '未公开编号'}</code></div>
                  <div><span>版本类型</span><code>{module.revision_kind || 'initial'}</code></div>
                  <pre>{module.summary || module.title}</pre>
                </details>
              </details>
            )
          })}
        </section>
      </div>
      </details>
    </section>
  )
}
