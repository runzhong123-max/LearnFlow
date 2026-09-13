import { useEffect, useState } from 'react'
import { qualificationLabel, type EvidenceCard, type EvidencePage, type EvidenceRequest } from './evidence'
import './evidence.css'

type Props = { reader: (input: EvidenceRequest, signal?: AbortSignal) => Promise<EvidencePage>; scopeKey: string; nodeId?: number; reviewScheduleId?: number; label?: string }
const LABELS: Record<string, string> = { self_reported: '用户自述，尚待验证', verified: '经验证的表现', observed: '已观察的行为', corrected: '用户纠正', inferred: '待核验的推断', none: '无辅助', hint: '使用提示', guided: '引导下完成', original: '原题', validated_variant: '已校验变式', correct: '本次成功', incorrect: '本次答错', unknown: '本次不会' }
const RELATIONS: Record<string, string> = { SUPPORTS: '支持', CONSOLIDATED_INTO: '形成', SUPERSEDES: '更新', REFINES: '细化', CONTRADICTS: '存在冲突' }
function timeLabel(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN') : '未记录时间' }

function Card({ card, navigate }: { card: EvidenceCard; navigate: (id: number, card: EvidenceCard) => void }) {
  return <article className="lf-evidence-card" id={`evidence-${card.id}`}>
    <header><strong>{card.title}</strong><time>{timeLabel(card.occurred_at)}</time></header>
    <p className={`lf-evidence-status is-${card.availability}`}>{qualificationLabel(card)}</p>
    {card.statement && <p>{card.statement}</p>}
    {card.qualification?.invalidated_by_event_id && <p>后续复习改变了当前资格。原来的成功记录仍可在下方关联中查看。</p>}
    {!card.coverage.complete && <p role="status" className="lf-evidence-gap">可核对来源 {card.coverage.source_returned}/{card.coverage.source_total} 条。未显示或无法核对的内容不计作已验证依据。</p>}
    {card.sources.map(source => <section className="lf-evidence-source" key={source.node_id}>
      <div className="lf-evidence-qualifiers">{[source.qualifiers.evidence_grade, source.qualifiers.assistance_level, source.qualifiers.question_form, source.qualifiers.outcome, source.qualifiers.independent === true ? '独立作答' : source.qualifiers.independent === false ? '非独立作答' : ''].filter(Boolean).map((value, i) => <span key={`${value}-${i}`}>{LABELS[value] || value}</span>)}</div>
      <time>{timeLabel(source.occurred_at)}</time>
      {source.source_format === 'canonical_json' ? <details><summary>查看原始记录</summary><blockquote>{source.text}</blockquote></details> : <blockquote>{source.text}</blockquote>}
      {source.truncated && <small>当前展示来源片段，完整性以标注范围为准。{source.qualifier_spans_omitted > 0 ? ` 有 ${source.qualifier_spans_omitted} 处限制条件未完整展示，不应仅凭片段判断。` : ''}</small>}
      <details><summary>核对来源</summary><dl><dt>事件 / 变更 / 事实</dt><dd>{source.event_id} / {source.mutation_id} / {source.node_id}</dd><dt>正文指纹</dt><dd>{source.source_sha256}</dd><dt>引用范围</dt><dd>{source.ranges.map(r => `${r[0]}–${r[1]}`).join('、')} · {source.source_format}</dd></dl></details>
    </section>)}
    {card.links.length > 0 && <section className="lf-evidence-links"><h4>已记录的依据与关联</h4>{card.links.map(link => <button type="button" key={`${link.id}-${link.relation}-${link.direction}`} onClick={() => navigate(link.id, card)}>
      <span>{link.direction === 'in' ? '此记录的来源或后续更新' : RELATIONS[link.relation] || link.relation} · {link.title}</span><small>{['active', 'legacy'].includes(link.status) ? '当前记录' : '历史记录'} ↗</small>
    </button>)}{card.coverage.links_truncated && <p>当前仅展示部分关联，可进入具体记录继续查看。</p>}</section>}
    {card.correction.claim_id && <p className="lf-evidence-boundary">{card.correction.allowed ? '可在这条认识的操作区纠正或停止使用。正式作答与评分记录不会因此改写。' : '这条认识已更新或停止使用，请查看后续记录。'}</p>}
  </article>
}

export function EvidenceInspector({ reader, scopeKey, nodeId, reviewScheduleId, label = '查看学习依据与关联' }: Props) {
  const [open, setOpen] = useState(false)
  const [navigation, setNavigation] = useState<EvidenceRequest[]>([])
  const [page, setPage] = useState<EvidencePage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const selected = navigation[navigation.length - 1]
  useEffect(() => { setPage(null); setNavigation([]); setError(''); setOpen(false) }, [scopeKey, nodeId, reviewScheduleId])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setBusy(true); setError(''); setPage(null)
    reader(selected || { nodeId, reviewScheduleId }, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(value)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取失败')
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [open, reader, selected, nodeId, reviewScheduleId, scopeKey, retry])
  return <section className="lf-evidence-inspector">
    <button type="button" className="lf-evidence-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起学习依据' : label}<span aria-hidden="true">{open ? '−' : '＋'}</span></button>
    {open && <div className="lf-evidence-content">
      <p className="lf-evidence-intro">查看系统判断的来源、适用条件，以及已记录的关联。学习安排与完成状态分别保留。</p>
      {navigation.length > 0 && <button type="button" onClick={() => setNavigation(previous => previous.slice(0, -1))}>← 返回上一组依据</button>}
      {busy && <p role="status">正在读取学习依据…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {page?.cards.map(card => <Card key={card.id} card={card} navigate={(id, origin) => setNavigation(previous => [...previous, { nodeId: id, projectId: origin.scope.project_id, checkpointId: origin.scope.checkpoint_id }])} />)}
      {page && !page.cards.length && <p>这里还没有可展示的学习依据。正式学习与明确自述会逐步留下记录。</p>}
      {page?.next_before_id && <button type="button" onClick={() => setNavigation(previous => [...previous, { reviewScheduleId, beforeId: page.next_before_id! }])}>查看更早记录</button>}
    </div>}
  </section>
}
