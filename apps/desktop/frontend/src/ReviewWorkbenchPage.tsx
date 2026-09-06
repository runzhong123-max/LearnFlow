import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { FormalRuntimeConnection } from './formal-runtime'
import {
  actOnReviewItem,
  loadReviewItems,
  loadReviewSummary,
  recordReviewReflection,
  submitReviewItem,
  type ReviewBucket,
  type ReviewItem,
  type ReviewMemoryNote,
  type ReviewSummary,
} from './review-runtime'
import './review-workbench.css'

const BUCKETS: Array<{ id: ReviewBucket; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'due', label: '今天' },
  { id: 'wrong', label: '错题' },
  { id: 'upcoming', label: '稍后' },
  { id: 'stable', label: '稳定' },
  { id: 'suspended', label: '暂停' },
]

const DIMENSION_LABELS: Record<string, string> = {
  accuracy: '作答可靠性',
  retrievability: '当前可提取性',
  independence: '独立完成',
  transfer: '变式迁移',
  spacing: '间隔稳定性',
}

const NOTE_KIND_LABELS: Record<string, string> = {
  misconception: '误解',
  insight: '启发',
  strength: '做得好',
  support: '讲法证据',
  question: '待解决',
}

function dueLabel(value: string) {
  const due = new Date(value)
  const delta = due.getTime() - Date.now()
  const days = Math.round(delta / 86_400_000)
  if (days < -1) return `逾期 ${Math.abs(days)} 天`
  if (days === -1) return '昨天到期'
  if (days === 0) return '今天'
  if (days === 1) return '明天'
  return `${days} 天后`
}

function ProficiencyDial({ item }: { item: ReviewItem }) {
  const score = item.proficiency.score
  return (
    <div className="review-proficiency-dial" style={{ '--score': score } as CSSProperties}>
      <div><strong>{score || '—'}</strong><span>{item.proficiency.label}</span></div>
    </div>
  )
}

function MemoryNoteCard({ note }: { note: ReviewMemoryNote }) {
  return (
    <article className={`review-memory-note note-${note.kind}`}>
      <header><span>{NOTE_KIND_LABELS[note.kind] || note.kind}</span><small>{note.status}</small></header>
      <strong>{note.title}</strong>
      <p>{note.text}</p>
      <footer>{note.evidence_refs.length ? note.evidence_refs.join(' · ') : note.source}</footer>
    </article>
  )
}

function EvidencePanel({ item }: { item: ReviewItem }) {
  const state = item.proficiency.memory_state as undefined | {
    difficulty: number
    stability_days: number
    retrievability: number
    target_retention: number
    calibration: string
  }
  return (
    <section className="review-evidence-panel">
      <div className="review-score-row">
        <ProficiencyDial item={item} />
        <div>
          <span className="review-kicker">EVIDENCE PROFICIENCY</span>
          <h2>证据化熟练度</h2>
          <p>置信度 {Math.round(item.proficiency.confidence * 100)}% · {item.proficiency.policy_version}</p>
        </div>
      </div>
      <div className="review-dimensions">
        {Object.entries(item.proficiency.dimensions).map(([key, value]) => (
          <div className="review-dimension" key={key}>
            <span><b>{DIMENSION_LABELS[key] || key}</b><em>{value}</em></span>
            <i><u style={{ width: `${value}%` }} /></i>
          </div>
        ))}
      </div>
      {state ? (
        <div className="review-dsr-state">
          <span><b>D</b> 难度 {state.difficulty}</span>
          <span><b>S</b> 稳定性 {state.stability_days} 天</span>
          <span><b>R</b> 当前可提取 {Math.round(state.retrievability * 100)}%</span>
        </div>
      ) : null}
      <div className="review-score-explanation">
        <strong>为什么是这个分数</strong>
        <p>{item.proficiency.caps.length
          ? item.proficiency.caps.map(cap => `${cap.reason}（上限 ${cap.limit}）`).join('；')
          : '现有证据没有触发额外上限。'}</p>
        <p className="review-next-evidence">下一条最有价值的证据：{item.proficiency.next_evidence}</p>
      </div>
      <details className="review-model-details">
        <summary>模型依据与边界</summary>
        <p>{item.proficiency.mastery_boundary}</p>
        <p>当前是 DSR 兼容冷启动代理；积累足够时序日志后才能训练个体参数，不能冒充完整 FSRS。</p>
        {(item.proficiency.research_basis || []).map(source => (
          <a key={source.id} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
        ))}
      </details>
    </section>
  )
}

function QuestionRunner({ item, busy, onSubmit }: {
  item: ReviewItem
  busy: boolean
  onSubmit: (input: Parameters<typeof submitReviewItem>[1]) => Promise<void>
}) {
  const payload = item.presentation.payload
  const [indexes, setIndexes] = useState<number[]>([])
  const [text, setText] = useState('')
  const [code, setCode] = useState('')
  const [assistance, setAssistance] = useState<'none' | 'hint' | 'guided'>('none')

  useEffect(() => {
    setIndexes([])
    setText('')
    setCode(payload.starter_code || '')
    setAssistance('none')
  }, [item.id, item.version, payload.starter_code])

  const toggle = (index: number) => {
    setIndexes(current => payload.multiple
      ? current.includes(index) ? current.filter(value => value !== index) : [...current, index]
      : [index])
  }
  const answerReady = payload.type === 'concept_choice' ? indexes.length > 0 : payload.type === 'code' ? code.trim() : text.trim()

  return (
    <section className="review-question-card">
      <header>
        <div><span>{item.presentation.question_form === 'validated_variant' ? '迁移变式' : '主动检索'}</span><small>{item.item_type === 'concept' ? '概念' : '实践'} · {dueLabel(item.due_at)}</small></div>
        <label>支架等级
          <select value={assistance} onChange={event => setAssistance(event.target.value as typeof assistance)}>
            <option value="none">无提示</option>
            <option value="hint">提示</option>
            <option value="guided">引导</option>
          </select>
        </label>
      </header>
      <h2>{payload.title || item.title}</h2>
      <p className="review-prompt">{payload.prompt || item.title}</p>
      {payload.input ? <pre>{payload.input}</pre> : null}
      {payload.type === 'concept_choice' ? (
        <div className="review-options">
          {(payload.options || []).map((option, index) => (
            <button type="button" key={index} onClick={() => toggle(index)} className={indexes.includes(index) ? 'selected' : ''}>
              <i>{String.fromCharCode(65 + index)}</i><span>{option}</span>
            </button>
          ))}
        </div>
      ) : payload.type === 'code' ? (
        <textarea className="review-code-input" value={code} onChange={event => setCode(event.target.value)} spellCheck={false} />
      ) : (
        <textarea value={text} onChange={event => setText(event.target.value)} placeholder="先从记忆中提取，再提交答案…" />
      )}
      <footer>
        <button type="button" className="review-secondary" disabled={busy} onClick={() => onSubmit({ responseStatus: 'skipped', assistanceLevel: assistance })}>跳过本轮</button>
        <button type="button" className="review-secondary" disabled={busy} onClick={() => onSubmit({ responseStatus: 'unknown', assistanceLevel: assistance })}>暂时不会</button>
        <button type="button" className="review-primary" disabled={busy || !answerReady} onClick={() => onSubmit({
          responseStatus: 'answered', answerIndexes: indexes, answerText: text, code, assistanceLevel: assistance,
        })}>{busy ? '正在判定…' : '提交并更新证据'}</button>
      </footer>
    </section>
  )
}

export default function ReviewWorkbenchPage({ connection }: { connection: FormalRuntimeConnection }) {
  const [summary, setSummary] = useState<ReviewSummary>()
  const [items, setItems] = useState<ReviewItem[]>([])
  const [bucket, setBucket] = useState<ReviewBucket>('all')
  const [selectedId, setSelectedId] = useState<number>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [reflectionKind, setReflectionKind] = useState<'insight' | 'misconception' | 'strength' | 'question'>('insight')
  const [reflection, setReflection] = useState('')

  const selected = useMemo(() => items.find(item => item.id === selectedId) || items[0], [items, selectedId])

  const load = async (nextBucket = bucket) => {
    if (connection.status !== 'connected') return
    setBusy('load')
    setError('')
    try {
      const [nextSummary, nextItems] = await Promise.all([loadReviewSummary(), loadReviewItems(nextBucket)])
      setSummary(nextSummary)
      setItems(nextItems.items)
      setSelectedId(current => nextItems.items.some(item => item.id === current) ? current : nextItems.items[0]?.id)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '复习队列读取失败')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => { void load(bucket) }, [connection.status, bucket])

  const replaceItem = (next: ReviewItem) => {
    setItems(current => current.map(item => item.id === next.id ? next : item))
  }

  const submit = async (input: Parameters<typeof submitReviewItem>[1]) => {
    if (!selected) return
    setBusy('submit')
    setError('')
    setResult('')
    try {
      const response = await submitReviewItem(selected, input)
      replaceItem(response.item)
      setResult(response.outcome === 'correct'
        ? '本轮通过。新的 Attempt 与 EvidenceEvent 已进入五核链。'
        : response.outcome === 'unknown'
          ? '已记录“不会”，与答错分开处理。'
          : response.outcome === 'skipped'
            ? '已跳过本轮；它不会被记成答错或不会。'
            : '本轮未通过，已进入纠错流程。')
      setSummary(await loadReviewSummary())
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '复习提交失败')
    } finally {
      setBusy('')
    }
  }

  const act = async (action: 'defer' | 'suspend' | 'resume') => {
    if (!selected) return
    setBusy(action)
    setError('')
    try {
      const response = await actOnReviewItem(selected, action)
      replaceItem(response.item)
      await load(bucket)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '复习状态更新失败')
    } finally {
      setBusy('')
    }
  }

  const addReflection = async () => {
    if (!selected || reflection.trim().length < 2) return
    setBusy('reflection')
    setError('')
    try {
      const response = await recordReviewReflection(selected, reflectionKind, reflection.trim())
      replaceItem(response.item)
      setReflection('')
      setResult('这条反思已作为“用户自输入、待验证、可纠正”证据进入知识核。')
    } catch (reflectionError) {
      setError(reflectionError instanceof Error ? reflectionError.message : '反思保存失败')
    } finally {
      setBusy('')
    }
  }

  if (connection.status !== 'connected') {
    return <section className="review-page review-offline"><span>REVIEW AUTHORITY</span><h1>复习工作台尚未连接</h1><p>{connection.detail}</p></section>
  }

  return (
    <section className="review-page">
      <header className="review-page-heading">
        <div><span className="review-kicker">RETRIEVAL · EVIDENCE · MEMORY</span><h1>复习工作台</h1><p>任务交付复习，检索产生证据，证据更新知识核；分数只负责解释与排序。</p></div>
        <div className="review-summary-cards">
          <article><strong>{summary?.due || 0}</strong><span>今天</span></article>
          <article><strong>{summary?.remediation || 0}</strong><span>纠错</span></article>
          <article><strong>{summary?.stable || 0}</strong><span>稳定</span></article>
        </div>
      </header>
      <div className="review-boundary-strip"><b>证据边界</b> 学习任务“完成”只触发交接；必须有已判分 Attempt 才会进入复习量化。内容曝光、用户自述和模型生成不会自动提升掌握。</div>
      {error ? <div className="review-alert review-alert-error">{error}</div> : null}
      {result ? <div className="review-alert review-alert-success">{result}</div> : null}
      <div className="review-workspace-grid">
        <aside className="review-queue">
          <div className="review-buckets">{BUCKETS.map(item => <button type="button" key={item.id} className={bucket === item.id ? 'active' : ''} onClick={() => setBucket(item.id)}>{item.label}</button>)}</div>
          <div className="review-queue-list">
            {items.map(item => (
              <button type="button" key={item.id} className={selected?.id === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
                <span><b>{item.proficiency.score || '—'}</b><small>{item.proficiency.label}</small></span>
                <div><strong>{item.title}</strong><small>{item.checkpoint_title || item.subject_key}</small><em>{dueLabel(item.due_at)}</em></div>
              </button>
            ))}
            {!items.length && busy !== 'load' ? <p className="review-empty-queue">这个筛选下没有复习项。</p> : null}
          </div>
        </aside>
        <main className="review-focus">
          {selected ? (
            <>
              <div className="review-linkage-bar">
                <span>学习任务</span><strong>{selected.learning_task?.title || '来自独立练习'}</strong>
                <i>→</i><span>复习任务 #{selected.id}</span><i>→</i><span>Knowledge / Practice 证据</span>
              </div>
              <QuestionRunner item={selected} busy={busy === 'submit'} onSubmit={submit} />
              <div className="review-item-actions">
                {selected.phase === 'suspended'
                  ? <button type="button" onClick={() => act('resume')}>恢复复习</button>
                  : <><button type="button" onClick={() => act('defer')}>延期 1 天</button><button type="button" onClick={() => act('suspend')}>暂停此项</button></>}
              </div>
            </>
          ) : (
            <div className="review-empty-focus"><strong>还没有可复习的已判分项目</strong><p>完成学习任务中的独立验证后，ReviewSchedule 会由证据自动重建并出现在这里。</p></div>
          )}
        </main>
        <aside className="review-evidence-column">
          {selected ? (
            <>
              <EvidencePanel item={selected} />
              <section className="review-memory-panel">
                <header><div><span className="review-kicker">KNOWLEDGE MEMORY</span><h2>这次学习留下了什么</h2></div><small>{selected.memory_notes.length} 条</small></header>
                <div className="review-memory-list">{selected.memory_notes.map(note => <MemoryNoteCard key={note.id} note={note} />)}</div>
                {!selected.memory_notes.length ? <p className="review-empty-memory">还没有具体误解、启发或优势证据。下一次作答和纠错会逐步形成。</p> : null}
                <div className="review-reflection-form">
                  <div><select value={reflectionKind} onChange={event => setReflectionKind(event.target.value as typeof reflectionKind)}><option value="insight">我的启发</option><option value="misconception">我发现的误解</option><option value="strength">我做得好的地方</option><option value="question">仍待解决</option></select><span>用户自输入 · 待验证</span></div>
                  <textarea value={reflection} onChange={event => setReflection(event.target.value)} placeholder="把具体内容写下来，例如：我总把条件概率的方向弄反…" />
                  <button type="button" disabled={busy === 'reflection' || reflection.trim().length < 2} onClick={addReflection}>写入知识核</button>
                </div>
              </section>
            </>
          ) : null}
        </aside>
      </div>
    </section>
  )
}
