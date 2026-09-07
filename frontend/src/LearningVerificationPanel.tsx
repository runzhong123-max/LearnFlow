import { useCallback, useEffect, useRef, useState } from 'react'
import { formalJsonRequest } from './formal-runtime'
import MarkdownContent from './MarkdownContent'
import PracticeFilePage from './PracticeFilePage'
import { createVerificationRuntime, verificationPresentation, type VerificationAction, type VerificationRun } from './verification-runtime.ts'

type Props = { runId: number; onProgress: () => Promise<void> }
const runtime = createVerificationRuntime(formalJsonRequest)
const buttonStyle = { padding: '8px 14px', borderRadius: 8, cursor: 'pointer' } as const

export default function LearningVerificationPanel({ runId, onProgress }: Props) {
  const [run, setRun] = useState<VerificationRun>()
  const [response, setResponse] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [progressError, setProgressError] = useState('')
  const latest = useRef<VerificationRun>()
  const activeId = useRef(runId)
  const pending = useRef(false)
  const notify = useRef(onProgress)
  activeId.current = runId
  notify.current = onProgress

  const accept = useCallback((value: VerificationRun) => {
    if (activeId.current !== value.id) return
    latest.current = value
    setRun(value)
  }, [])

  // Loading follows run identity only. Parent snapshot updates and onProgress
  // callback identity changes must never initiate another load/sync cycle.
  useEffect(() => {
    let alive = true
    latest.current = undefined
    pending.current = false
    setRun(undefined)
    setResponse('')
    setError('')
    setProgressError('')
    setBusy('load')
    void runtime.load(runId).then(value => {
      if (alive) accept(value)
    }).catch(failure => {
      if (alive) setError(failure instanceof Error ? failure.message : '验证记录读取失败')
    }).finally(() => { if (alive) setBusy('') })
    return () => { alive = false }
  }, [runId, accept])

  const notifyParent = useCallback(async () => {
    try {
      await notify.current()
      setProgressError('')
    } catch (failure) {
      setProgressError(`验证已保存，对话进度暂未刷新：${failure instanceof Error ? failure.message : '请重试刷新'}`)
    }
  }, [])

  const perform = useCallback(async (name: string, operation: () => Promise<VerificationRun>, report = true) => {
    if (pending.current) return
    const expectedId = activeId.current
    pending.current = true
    setBusy(name)
    setError('')
    try {
      const updated = await operation()
      if (activeId.current !== expectedId) return
      accept(updated)
      if (report) await notifyParent()
    } catch (failure) {
      if (activeId.current === expectedId) setError(failure instanceof Error ? failure.message : '验证进度更新失败，请刷新后重试')
    } finally {
      if (activeId.current === expectedId) {
        pending.current = false
        setBusy('')
      }
    }
  }, [accept, notifyParent])

  const refresh = () => perform('refresh', () => runtime.load(runId))
  const advance = (action: VerificationAction) => {
    const current = latest.current
    if (current) void perform(action, () => runtime.advance(current, action))
  }
  const syncPractice = useCallback(async () => {
    const expectedId = activeId.current
    await perform('sync', async () => {
      // GET first reconciles externally submitted attempts and supplies the
      // current server version. Completion is never inferred in this component.
      const current = await runtime.load(expectedId)
      return current.status === 'active' ? runtime.sync(current) : current
    })
  }, [perform])

  const heading = <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 16, flexWrap: 'wrap' }}>
    <div><small>本轮独立验证</small><h2 style={{ margin: '6px 0' }}>{run?.learning_card.title || run?.goal || '载入验证'}</h2>
      {run && <p style={{ margin: '6px 0', color: '#557068' }}>{verificationPresentation(run).label}</p>}</div>
    <div style={{ display: 'flex', gap: 8 }}>
      <button type="button" style={buttonStyle} disabled={Boolean(busy)} onClick={() => void refresh()}>刷新状态</button>
      {run && verificationPresentation(run).actions.includes('pause') && <button type="button" style={buttonStyle} disabled={Boolean(busy)} onClick={() => advance('pause')}>暂停验证</button>}
    </div>
  </header>

  if (!run) return <section className="learning-verification-panel formal-empty-card" style={{ padding: 20 }} aria-label="本轮独立验证">
    {heading}{error ? <p role="alert">{error}</p> : <p role="status">正在载入已保存的验证进度…</p>}
  </section>
  const view = verificationPresentation(run)
  const card = run.learning_card
  const progress = run.progress
  return <section className="learning-verification-panel" aria-label="本轮独立验证" style={{ border: '1px solid #d7e5de', borderRadius: 14, padding: 20, margin: '16px 0', background: '#fff' }}>
    {heading}
    {error && <p className="formal-inline-error" role="alert">{error}。可刷新状态后继续，已保存的作答会保留。</p>}
    {progressError && <div className="formal-inline-error" role="alert"><p>{progressError}</p><button type="button" onClick={() => void notifyParent()}>重试刷新对话进度</button></div>}
    {busy && <p role="status">{busy === 'sync' ? '正在核对正式作答与纠错进度…' : '正在保存或读取验证进度…'}</p>}

    {run.state === 'learning_card' && run.status === 'active' && <div>
      {card.objective && <MarkdownContent content={card.objective} />}
      <h3>回顾要点</h3>
      <ol>{(card.key_points || []).map((point, index) => <li key={index}><MarkdownContent content={point} /></li>)}</ol>
      {card.example && <><h3>具体例子</h3><MarkdownContent content={card.example} /></>}
      {card.common_confusion && <><h3>容易混淆的地方</h3><MarkdownContent content={card.common_confusion} /></>}
      {card.quality_status === 'blocked'
        ? <p role="alert">当前材料尚未通过内容检查。请在原对话中补充资料或重新生成，再刷新这里。</p>
        : <button type="button" style={buttonStyle} disabled={Boolean(busy)} onClick={() => advance('complete_card')}>准备好了，开始独立复述</button>}
    </div>}

    {view.canTeachBack && <form onSubmit={event => {
      event.preventDefault()
      const current = latest.current
      if (current) void perform('teach-back', () => runtime.teachBack(current, response))
    }}>
      <p>先不看讲义，用自己的话说明核心机制、适用条件和一个具体例子。复述用于发现遗漏，随后还要完成正式练习。</p>
      <label htmlFor={`verification-teach-back-${run.id}`}>你的复述（至少20字）</label>
      <textarea id={`verification-teach-back-${run.id}`} value={response} onChange={event => setResponse(event.target.value)} rows={6} maxLength={6000}
        disabled={Boolean(busy)} style={{ display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 12, borderRadius: 8, border: '1px solid #b8ccc2', resize: 'vertical' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <small>{[...response.trim()].length} / 6000字</small><button type="submit" style={buttonStyle} disabled={Boolean(busy) || [...response.trim()].length < 20}>提交复述</button>
      </div>
    </form>}

    {run.state === 'teach_back_feedback' && run.status === 'active' && <div>
      <h3>复述反馈</h3>
      {run.teach_back.response && <blockquote style={{ margin: '12px 0', paddingLeft: 14, borderLeft: '3px solid #bdd7cb', whiteSpace: 'pre-wrap' }}>{run.teach_back.response}</blockquote>}
      {(run.teach_back.covered_points || []).length > 0 && <><h4>已经提到</h4><ul>{run.teach_back.covered_points!.map((point, index) => <li key={index}>{point}</li>)}</ul></>}
      {(run.teach_back.missing_points || []).length > 0 && <><h4>还需注意</h4><ul>{run.teach_back.missing_points!.map((point, index) => <li key={index}>{point}</li>)}</ul></>}
      {run.teach_back.diagnostic_question && <p>{run.teach_back.diagnostic_question}</p>}
      <p>这些是复述覆盖反馈，正式作答会进一步检查你的理解。</p>
      <button type="button" style={buttonStyle} disabled={Boolean(busy)} onClick={() => advance('continue_after_feedback')}>进入正式练习</button>
    </div>}

    {view.practiceRef && <div>
      <p>{run.state === 'remediation' ? '请在练习中完成当前纠错和变式，随后核对本轮进度。' : '请独立完成正式作答。需要提示时，如实选择已经使用的帮助。'}</p>
      {progress && <p>服务端已确认完成 {progress.completed_questions} / {progress.total_questions} 题</p>}
      <PracticeFilePage key={run.id} practiceRef={view.practiceRef} embedded inline onProgress={syncPractice} />
      <button type="button" style={buttonStyle} disabled={Boolean(busy)} onClick={() => void syncPractice()}>核对验证进度</button>
    </div>}

    {run.status === 'paused' && <div><p>进度已保存，可以从暂停的位置继续。</p><button type="button" style={buttonStyle} disabled={Boolean(busy)} onClick={() => advance('resume')}>继续验证</button></div>}
    {view.completed && <div role="status">
      <h3>本轮验证已完成</h3>
      <p>独立验证 {run.summary.independently_verified_question_ids?.length || 0} 题；经纠错与变式完成 {run.summary.remediated_question_ids?.length || 0} 题。</p>
      <p>{run.summary.next_step || '本轮完成不代表稳定掌握。后续通过间隔复习与新的变式继续检验。'}</p>
    </div>}
  </section>
}
