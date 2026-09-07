import { useEffect, useRef, useState } from 'react'
import {
  changeFormalRemediationExplanation, loadFormalRemediationCase, prepareFormalRemediationVariant,
  remediationViewState, submitFormalRemediationVariant, type FormalRemediationCase,
} from './formal-runtime.ts'
import { browserFileProgressStorage, completePracticeSubmission, learningFileProgressKey, preparePracticeSubmission } from './learning-file-progress.ts'

type Props = {
  caseId: number
  itemType: 'concept' | 'exercise'
  itemId: number
  identity: string
  revision?: number
  retrying?: boolean
  disabled?: boolean
  onCaseChange: (remediation: FormalRemediationCase) => void
  onRetry: (remediation: FormalRemediationCase) => void
  onShowExplanation: () => void
  onProgress: () => Promise<void>
}

export default function RemediationPanel({ caseId, itemType, itemId, identity, revision, retrying, disabled, onCaseChange, onRetry, onShowExplanation, onProgress }: Props) {
  const [remediation, setRemediation] = useState<FormalRemediationCase>()
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [answerText, setAnswerText] = useState('')
  const [feedback, setFeedback] = useState('')
  const inFlight = useRef(false)
  const alive = useRef(true)
  const callbacks = useRef({ onCaseChange, onProgress })
  callbacks.current = { onCaseChange, onProgress }
  const accept = (value: FormalRemediationCase) => {
    if (value.id !== caseId || value.item_type !== itemType || value.item_id !== itemId) throw new Error('纠错记录与当前题目不一致，请重新打开练习')
    if (!alive.current) return
    setRemediation(value)
    callbacks.current.onCaseChange(value)
  }
  useEffect(() => {
    alive.current = true
    let current = true
    setUncertain(true)
    void loadFormalRemediationCase(caseId).then(value => {
      if (!current) return
      accept(value)
      setUncertain(false)
      setError('')
    }).catch(failure => current && setError(failure instanceof Error ? failure.message : '纠错读取失败'))
    return () => { current = false; alive.current = false }
  }, [caseId, revision, itemType, itemId])

  const refresh = async () => {
    setError('')
    try {
      accept(await loadFormalRemediationCase(caseId))
      if (alive.current) setUncertain(false)
    } catch (failure) {
      if (alive.current) { setUncertain(true); setError(failure instanceof Error ? failure.message : '纠错读取失败') }
    }
  }
  const mutate = async (operation: () => Promise<FormalRemediationCase>) => {
    if (inFlight.current || disabled || uncertain) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      accept(await operation())
      try { await callbacks.current.onProgress() }
      catch { if (alive.current) setError('纠错已保存，学习进度暂未更新。') }
    } catch (failure) {
      // A lost response may already have changed the case. Read it before another write.
      if (alive.current) setUncertain(true)
      try {
        accept(await loadFormalRemediationCase(caseId))
        if (alive.current) {
          setUncertain(false)
          setError(`${failure instanceof Error ? failure.message : '操作结果未确认'}。已重新读取纠错进度，请按当前状态继续。`)
        }
        await callbacks.current.onProgress().catch(() => undefined)
      } catch {
        if (alive.current) setError('操作结果暂未确认。请先重新读取纠错进度，再继续。')
      }
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  const state = remediationViewState(remediation)
  const variant = remediation?.variant
  const selection = variant?.type === 'concept_choice'
  const supportedVariant = selection || variant?.type === 'predict_output'
  const locked = busy || disabled || uncertain
  const submitVariant = (unknown = false) => void mutate(async () => {
    const submission = unknown ? { response_status: 'unknown' as const }
      : selection ? { answer_indexes: selected, response_status: 'answered' as const }
        : { answer_text: answerText.trim(), response_status: 'answered' as const }
    const key = `${learningFileProgressKey(identity, 'remediation', caseId)}:variant-request`
    const context = await preparePracticeSubmission(browserFileProgressStorage(), key, submission, { assistance_level: 'none' })
    const result = await submitFormalRemediationVariant(caseId, submission, context.client_submission_id!)
    completePracticeSubmission(browserFileProgressStorage(), key, context)
    if (alive.current) {
      setFeedback(result.result.outcome === 'unknown' ? '已记录暂时不会，可以继续分析后再作答。'
        : result.result.correct ? '这次变式回答正确。' : '这次变式尚未通过，可以重新分析后再作答。')
    }
    return result.remediation
  })
  return <section className="practice-remediation" aria-label="当前题目纠错">
    <h3>这道题的纠错</h3>
    {error && <p role="alert">{error}</p>}
    {(!remediation || uncertain) && <button type="button" disabled={busy} onClick={() => void refresh()}>重新读取纠错进度</button>}
    {remediation && <>
      <p role="status">{state.statusText}</p>
      {!state.completed && !retrying && <>
        {!state.canVariant && <>
          {remediation.explanation?.delivery_mode_label && <p>{remediation.explanation.delivery_mode_label}</p>}
          {(remediation.explanation?.sections || []).map((section, index) => <div key={index}><h4>{section.title}</h4><p>{section.content}</p></div>)}
        </>}
        <div>{state.explanationActions.map(action => <button key={action} type="button" disabled={locked}
          onClick={() => void mutate(() => changeFormalRemediationExplanation(caseId, action))}>
          {action === 'switch' ? '换种讲法' : action === 'steps' ? '看步骤' : '看示例'}
        </button>)}</div>
      </>}
      {state.canRetry && <button type="button" disabled={locked} onClick={() => onRetry(remediation)}>{retrying ? '清空并重新作答原题' : '收起讲解，重做原题'}</button>}
      {retrying && state.canRetry && <><p>请在原题中重新作答。本次仍保留已使用帮助和原题重做记录。</p><button type="button" disabled={locked} onClick={onShowExplanation}>重新查看讲解</button></>}
      {state.canVariant && (!variant?.type ? <button type="button" disabled={locked} onClick={() => void mutate(() => prepareFormalRemediationVariant(caseId))}>打开变式练习</button> : <div>
        <h4>变式验证</h4><p>{variant.prompt}</p>
        {variant.input && <pre>{variant.input}</pre>}
        {selection ? <div className="practice-options">{(variant.options || []).map((option, index) => <label key={index}>
          <input type={variant.multiple ? 'checkbox' : 'radio'} name={`remediation-${caseId}`} checked={selected.includes(index)} disabled={locked}
            onChange={() => { setFeedback(''); setSelected(previous => variant.multiple ? previous.includes(index) ? previous.filter(value => value !== index) : [...previous, index] : [index]) }} />{option}
        </label>)}</div> : supportedVariant ? <textarea aria-label="变式答案" value={answerText} disabled={locked} onChange={event => { setFeedback(''); setAnswerText(event.target.value) }} />
          : <p>这道变式暂不支持在当前页面作答，请返回对话继续处理。</p>}
        {supportedVariant && <div><button type="button" disabled={locked || (selection ? selected.length === 0 : !answerText.trim())} onClick={() => submitVariant()}>提交变式答案</button>
          <button type="button" disabled={locked} onClick={() => submitVariant(true)}>我暂时不会</button></div>}
      </div>)}
      {feedback && <p role="status">{feedback}</p>}
      {state.completed && <p>这是本次纠错的完成记录，后续仍可通过复习检查保持情况。</p>}
    </>}
  </section>
}
