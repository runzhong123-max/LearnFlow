import { useEffect, useRef, useState } from 'react'
import {
  ensureFormalIdentity,
  loadPracticeFile,
  loadFormalRemediationCase,
  remediationCaseId,
  remediationRetryContext,
  remediationViewState,
  type FormalRemediationCase,
  recordLearningFileAccess,
  submitFormalConceptAnswer,
  submitFormalExercise,
} from './formal-runtime'
import { getRuntimeClientState } from './runtime-client.ts'
import { browserFileProgressStorage, completePracticeSubmission, learningFileProgressKey, notifyLearningFileProgress, practiceSubmissionContext, preparePracticeSubmission, readFileProgress, saveFileProgress } from './learning-file-progress.ts'
import RemediationPanel from './RemediationPanel'
import CodePaperWorkbench, { type CodePaperSourceFile } from './CodePaperWorkbench'

type Props = {
  practiceRef: string
  embedded?: boolean
  inline?: boolean
  conversationId?: string
  sheetId?: string
  onAttach?: (file: { kind: 'practice'; ref: string; title: string }) => void
  onFollowUp?: () => void
  onOpenPaper?: () => void
  onProgress?: () => Promise<void>
  onRemediate?: () => void
}

export default function PracticeFilePage({ practiceRef, embedded, inline, conversationId, sheetId, onAttach, onFollowUp, onOpenPaper, onProgress, onRemediate }: Props) {
  const [file, setFile] = useState<Awaited<ReturnType<typeof loadPracticeFile>>>()
  const [answers, setAnswers] = useState<Record<number, number[]>>({})
  const [responses, setResponses] = useState<Record<number, string>>({})
  const [reflections, setReflections] = useState<Record<number, { blocker: string; helpfulFormat: string }>>({})
  const [results, setResults] = useState<Record<number, Awaited<ReturnType<typeof submitFormalConceptAnswer>>>>({})
  const [codeResult, setCodeResult] = useState<Awaited<ReturnType<typeof submitFormalExercise>>>()
  const [busy, setBusy] = useState('')
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [progressError, setProgressError] = useState('')
  const [identity, setIdentity] = useState('')
  const [codeHelp, setCodeHelp] = useState('')
  const [cases, setCases] = useState<Record<number, FormalRemediationCase>>({})
  const [caseBindings, setCaseBindings] = useState<Record<string, number>>({})
  const [retryCases, setRetryCases] = useState<Record<string, number>>({})
  const [codeRevision, setCodeRevision] = useState(0)
  const actionInFlight = useRef(false)
  const successfulItems = useRef(new Set<string>())
  const viewedHints = useRef(false)
  useEffect(() => {
    let alive = true
    setFile(undefined)
    setLoadError('')
    setActionError('')
    setAnswers({})
    setResponses({})
    setReflections({})
    setResults({})
    setCodeResult(undefined)
    setBusy('')
    setProgressError('')
    setCodeHelp('')
    setCases({})
    setCaseBindings({})
    setRetryCases({})
    setCodeRevision(0)
    successfulItems.current.clear()
    viewedHints.current = false
    void Promise.all([loadPracticeFile(practiceRef), ensureFormalIdentity()]).then(([result, account]) => {
      if (!alive) return
      setIdentity(`${getRuntimeClientState().kind}:${account.id}:${account.learner_id}`)
      setFile(result)
      if (!inline) void recordLearningFileAccess('practice', practiceRef, 'opened', { conversation_id: conversationId, sheet_id: sheetId }).catch(() => undefined)
    }).catch(failure => alive && setLoadError(failure instanceof Error ? failure.message : '练习读取失败'))
    return () => { alive = false }
  }, [practiceRef, conversationId, sheetId, inline])
  if (loadError) return <div className="formal-inline-error" role="alert">{loadError}</div>
  if (!file) return <div className="page-loading">正在打开正式练习…</div>
  const itemKey = (kind: string, id: number) => learningFileProgressKey(identity, kind, id)
  const hasLocalSubmission = (kind: string, id: number) => successfulItems.current.has(`${kind}:${id}`)
    || readFileProgress(browserFileProgressStorage(), itemKey(kind, id)) === 'submitted'
  const rememberSubmission = (kind: string, id: number) => {
    successfulItems.current.add(`${kind}:${id}`)
    saveFileProgress(browserFileProgressStorage(), itemKey(kind, id), 'submitted')
  }
  const syncProgress = async () => {
    setProgressError('')
    try { await notifyLearningFileProgress(onProgress, conversationId) }
    catch { setProgressError('作答已保存，学习进度暂未更新。') }
  }
  const reviewAction = onRemediate
    ? <button type="button" onClick={onRemediate}>查看复习安排</button>
    : <a href="/review">查看复习安排</a>
  const acceptCase = (remediation: FormalRemediationCase) => {
    setCases(previous => ({ ...previous, [remediation.id]: remediation }))
    setCaseBindings(previous => ({ ...previous, [`${remediation.item_type}:${remediation.item_id}`]: remediation.id }))
    const key = `${itemKey('remediation', remediation.id)}:help`
    const context = remediationRetryContext(remediation, {}, readFileProgress(browserFileProgressStorage(), key) || '')
    saveFileProgress(browserFileProgressStorage(), key, context.assistance_level)
  }
  const retryContext = (caseId: number | undefined, kind: string, id: number, context: ReturnType<typeof practiceSubmissionContext>) => {
    if (!caseId) return context
    const remediation = cases[caseId]
    if (!remediation || retryCases[`${kind}:${id}`] !== caseId || !remediationViewState(remediation).canRetry) {
      throw new Error('请先按纠错进度选择“重做原题”')
    }
    return remediationRetryContext(remediation, context,
      readFileProgress(browserFileProgressStorage(), `${itemKey('remediation', caseId)}:help`) || '')
  }
  const recoverSubmission = async (caseId?: number) => {
    try {
      if (caseId) acceptCase(await loadFormalRemediationCase(caseId))
      setFile(await loadPracticeFile(practiceRef))
      await syncProgress()
    } catch { /* Keep the pending request identity until the response can be recovered. */ }
  }
  const submitQuestion = async (questionId: number) => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(`question:${questionId}`)
    setActionError('')
    try {
      const question = file.questions?.find(item => item.id === questionId)
      const structured = ['single', 'multi', 'judge', 'ordered_blocks'].includes(question?.q_type || '')
        ? { answer_indexes: answers[questionId] || [] }
        : {
            response: question?.q_type === 'numeric'
              ? Number(responses[questionId])
              : question?.q_type === 'trace_table'
                ? JSON.parse(responses[questionId] || '[]')
                : responses[questionId] || '',
          }
      const reflection = reflections[questionId] || { blocker: '', helpfulFormat: '' }
      const submission = {
        ...structured,
        blocker_concept_key: reflection.blocker.trim(),
        helpful_format: reflection.helpfulFormat,
        support_effective: Boolean(reflection.helpfulFormat),
      }
      const requestKey = `${itemKey('concept', questionId)}:request`
      const caseId = remediationCaseId(results[questionId], question) || caseBindings[`concept:${questionId}`]
      const context = await preparePracticeSubmission(browserFileProgressStorage(), requestKey, { ...submission, remediation_case_id: caseId },
        retryContext(caseId, 'concept', questionId, practiceSubmissionContext(question, hasLocalSubmission('concept', questionId), reflection.helpfulFormat)))
      const result = await submitFormalConceptAnswer(file.checkpoint_id, questionId, submission, context)
      completePracticeSubmission(browserFileProgressStorage(), requestKey, context)
      rememberSubmission('concept', questionId)
      setResults(previous => ({ ...previous, [questionId]: result }))
      setRetryCases(previous => { const next = { ...previous }; delete next[`concept:${questionId}`]; return next })
      if (result.remediation) acceptCase(result.remediation)
      if (result.remediation?.status === 'variant_ready') {
        setAnswers(previous => ({ ...previous, [questionId]: [] }))
        setResponses(previous => ({ ...previous, [questionId]: '' }))
      }
      await syncProgress()
    }
    catch (failure) {
      setActionError(failure instanceof Error ? failure.message : '提交结果暂未确认，请重新读取进度后继续')
      await recoverSubmission(remediationCaseId(results[questionId], file.questions?.find(item => item.id === questionId)) || caseBindings[`concept:${questionId}`])
    }
    finally { actionInFlight.current = false; setBusy('') }
  }
  const submitCode = async (code: string) => {
    if (!file.id || actionInFlight.current) return
    actionInFlight.current = true
    setBusy('code')
    setActionError('')
    try {
      const requestKey = `${itemKey('exercise', file.id)}:request`
      const hintViewed = viewedHints.current || readFileProgress(browserFileProgressStorage(), `${itemKey('exercise', file.id)}:hint`) === 'viewed'
      const caseId = remediationCaseId(codeResult, file) || caseBindings[`exercise:${file.id}`]
      const context = await preparePracticeSubmission(browserFileProgressStorage(), requestKey, { code, codeHelp, remediation_case_id: caseId },
        retryContext(caseId, 'exercise', file.id, practiceSubmissionContext(file, hasLocalSubmission('exercise', file.id), codeHelp, hintViewed)))
      const result = await submitFormalExercise(file.id, code, context)
      completePracticeSubmission(browserFileProgressStorage(), requestKey, context)
      rememberSubmission('exercise', file.id)
      setCodeResult(result)
      setRetryCases(previous => { const next = { ...previous }; delete next[`exercise:${file.id}`]; return next })
      if (result.remediation) acceptCase(result.remediation)
      await syncProgress()
    }
    catch (failure) {
      setActionError(failure instanceof Error ? failure.message : '代码评估结果暂未确认')
      await recoverSubmission(remediationCaseId(codeResult, file) || caseBindings[`exercise:${file.id}`])
    }
    finally { actionInFlight.current = false; setBusy('') }
  }
  const codePractice = file as typeof file & {
    files?: CodePaperSourceFile[]
    entrypoint?: string
    requirements?: string[]
  }
  const codeCaseId = remediationCaseId(codeResult, file) || caseBindings[`exercise:${file.id}`]
  const codeRetrying = Boolean(codeCaseId && retryCases[`exercise:${file.id}`] === codeCaseId)
  const codeRetryReady = Boolean(codeCaseId && codeRetrying && remediationViewState(cases[codeCaseId]).canRetry)
  return (
    <section className={`practice-file-workbench${embedded ? ' learning-file-embedded' : ''}${inline ? ' learning-file-inline' : ''}`}>
      <header className={inline ? 'learning-file-inline-heading' : 'learning-file-workbench-heading'}>
        <div><span>{inline ? `练习 · ${file.questions?.length || 1} 题` : '练习'}</span><h1>{file.title}</h1>{!embedded && !inline && <code>{file.logical_filename}</code>}</div>
        <div>
          {onFollowUp && <button type="button" className="learning-file-subtle-action" onMouseDown={event => event.preventDefault()} onClick={onFollowUp}>选中追问</button>}
          {onAttach && !embedded && <button type="button" onClick={() => onAttach({ kind: 'practice', ref: file.ref, title: file.title })}>放到对话纸张</button>}
        </div>
      </header>
      {progressError && <div className="formal-inline-error" role="alert">{progressError} <button type="button" onClick={() => void syncProgress()}>重新同步</button></div>}
      {file.practice_kind !== 'exercise' ? <>
        {actionError && <div className="formal-inline-error" role="alert">{actionError}</div>}
        {!file.questions?.length && <p>这份练习暂时没有可作答的题目，请返回对话准备练习。</p>}
        <div className="practice-question-list">{(file.questions || []).map((question, index) => {
        const selected = answers[question.id] || []
        const result = results[question.id]
        const selectionType = ['single', 'multi', 'judge'].includes(question.q_type)
        const hasResponse = question.q_type === 'ordered_blocks'
          ? selected.length === question.options.length
          : selectionType ? selected.length > 0 : Boolean((responses[question.id] || '').trim())
        const reflection = reflections[question.id] || { blocker: '', helpfulFormat: '' }
        const repeated = practiceSubmissionContext(question, hasLocalSubmission('concept', question.id)).attempt_role === 'retry'
        const caseId = remediationCaseId(result, question) || caseBindings[`concept:${question.id}`]
        const retrying = Boolean(caseId && retryCases[`concept:${question.id}`] === caseId)
        const canAnswer = !caseId || retrying && remediationViewState(cases[caseId]).canRetry
        const locked = Boolean(result) || Boolean(busy) || !canAnswer
        return <article key={question.id}>
          {inline && onOpenPaper && <button type="button" className="practice-question-paper-open" title="在新纸张打开整份练习" aria-label="在新纸张打开整份练习" onClick={onOpenPaper}>↗</button>}
          <span>第 {index + 1} 题 · {question.difficulty === 'easy' ? '基础' : question.difficulty === 'hard' ? '挑战' : '进阶'}{question.target_skill ? ` · ${question.target_skill}` : ''}</span>
          {repeated && !result && <p className="learning-evidence-notice">{question.latest_passed === true ? '上次作答已通过。' : '你已做过这道题。'}再次作答会记录为原题重做。{caseId ? '下方保留了这道题的纠错进度。' : ''}</p>}
          <h2>{question.question}</h2>
          {question.code && <pre className="practice-question-code"><code>{question.code}</code></pre>}
          {question.q_type === 'ordered_blocks' ? <div className="practice-order-builder">
            <p>依次点击步骤，组成完整执行顺序。</p>
            <ol aria-label="已排列步骤">
              {selected.map(optionIndex => <li key={optionIndex}><button type="button" disabled={locked} onClick={() => setAnswers(previous => ({ ...previous, [question.id]: selected.filter(item => item !== optionIndex) }))}><i>{selected.indexOf(optionIndex) + 1}</i><span>{question.options[optionIndex]}</span><b aria-hidden="true">×</b></button></li>)}
            </ol>
            <div className="practice-order-pool" aria-label="待排列步骤">
              {question.options.map((option, optionIndex) => selected.includes(optionIndex) ? null : <button key={optionIndex} type="button" disabled={locked} onClick={() => setAnswers(previous => ({ ...previous, [question.id]: [...selected, optionIndex] }))}><i>{String.fromCharCode(65 + optionIndex)}</i><span>{option}</span></button>)}
            </div>
          </div> : selectionType ? <div className="practice-options">{question.options.map((option, optionIndex) => <label key={optionIndex} className={selected.includes(optionIndex) ? 'selected' : ''}><input type={question.q_type === 'multi' ? 'checkbox' : 'radio'} name={`q-${question.id}`} checked={selected.includes(optionIndex)} disabled={locked} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: question.q_type === 'multi' ? (selected.includes(optionIndex) ? selected.filter(item => item !== optionIndex) : [...selected, optionIndex]) : [optionIndex] }))} /><i>{String.fromCharCode(65 + optionIndex)}</i><span>{option}</span></label>)}</div> : <textarea className="practice-structured-response" value={responses[question.id] || ''} onChange={event => setResponses(previous => ({ ...previous, [question.id]: event.target.value }))} disabled={locked} placeholder={question.q_type === 'trace_table' ? '输入二维 JSON 数组，例如 [["i","sum"],["1","1"]]' : question.q_type === 'numeric' ? '输入数值' : '输入确定答案'} />}
          {question.q_type === 'ordered_blocks' && !result && canAnswer && selected.length > 0 && <button type="button" className="practice-reset-order" onClick={() => setAnswers(previous => ({ ...previous, [question.id]: [] }))}>重置顺序</button>}
          {!result && canAnswer && <details className="practice-reflection"><summary>补充这次作答的卡点或有效帮助（可选）</summary><div><label>哪一个前置概念卡住了你？<input value={reflection.blocker} onChange={event => setReflections(previous => ({ ...previous, [question.id]: { ...reflection, blocker: event.target.value } }))} placeholder="例如：矩阵乘法的形状" /></label><label>哪种帮助这次确实有效？<select value={reflection.helpfulFormat} onChange={event => setReflections(previous => ({ ...previous, [question.id]: { ...reflection, helpfulFormat: event.target.value } }))}><option value="">没有使用帮助</option><option value="visual">图解</option><option value="worked_example">完整示例</option><option value="code_example">代码例子</option><option value="step_by_step">逐步提示</option><option value="analogy">类比</option></select></label></div></details>}
          {!result && canAnswer && <button type="button" disabled={!hasResponse || Boolean(busy)} onClick={() => void submitQuestion(question.id)}>{busy === `question:${question.id}` ? '正在判定…' : repeated ? '提交原题重做' : '提交作答'}</button>}
          {result && <p className={result.correct ? 'practice-correct' : 'practice-wrong'} role="status">{result.correct ? '回答正确。可以继续下一题，稍后再用变式确认。' : '这次还没有通过。已保留作答，进入纠错后可以查看讲解并继续重做。'}</p>}
          {caseId && <RemediationPanel key={`${identity}:${caseId}`} caseId={caseId} itemType="concept" itemId={question.id} identity={identity}
            revision={result?.attempt_id} retrying={retrying} disabled={Boolean(busy)} onCaseChange={acceptCase} onProgress={syncProgress}
            onShowExplanation={() => setRetryCases(previous => { const next = { ...previous }; delete next[`concept:${question.id}`]; return next })}
            onRetry={remediation => {
              acceptCase(remediation)
              setRetryCases(previous => ({ ...previous, [`concept:${question.id}`]: remediation.id }))
              setResults(previous => { const next = { ...previous }; delete next[question.id]; return next })
              setAnswers(previous => ({ ...previous, [question.id]: [] }))
              setResponses(previous => ({ ...previous, [question.id]: '' }))
            }} />}
          {result && !result.correct && !caseId && <p>这次未返回可用的纠错记录，可返回对话继续处理。{reviewAction}</p>}
        </article>
      })}</div></> : <>
      <label className="practice-reflection">这次作答使用的帮助
        <select value={codeHelp} disabled={Boolean(busy)} onChange={event => setCodeHelp(event.target.value)}>
          <option value="">没有使用额外帮助</option><option value="visual">图解或提示</option><option value="step_by_step">逐步指导</option><option value="worked_example">完整示例或参考代码</option>
        </select>
      </label>
      {(Number(file.attempt_count || 0) > 0 || Boolean(file.id && hasLocalSubmission('exercise', file.id))) && <p className="learning-evidence-notice">再次提交这份代码会记录为原题重做。</p>}
      <fieldset disabled={Boolean(codeCaseId && !codeRetryReady)}><CodePaperWorkbench
        key={`${file.ref}:${codeRevision}`}
        description={file.description}
        starterCode={file.starter_code}
        files={codePractice.files}
        entrypoint={codePractice.entrypoint}
        requirements={codePractice.requirements}
        hints={file.hints}
        busy={busy === 'code'}
        error={actionError}
        result={codeResult}
        inline={inline}
        onOpenPaper={onOpenPaper}
        onHintViewed={() => {
          viewedHints.current = true
          if (file.id) saveFileProgress(browserFileProgressStorage(), `${itemKey('exercise', file.id)}:hint`, 'viewed')
        }}
        onSubmitCode={submitCode}
      />
      </fieldset>
      {codeCaseId && file.id && <RemediationPanel key={`${identity}:${codeCaseId}`} caseId={codeCaseId} itemType="exercise" itemId={file.id} identity={identity}
        revision={codeResult?.attempt_id} retrying={codeRetrying} disabled={Boolean(busy)} onCaseChange={acceptCase} onProgress={syncProgress}
        onShowExplanation={() => setRetryCases(previous => { const next = { ...previous }; delete next[`exercise:${file.id}`]; return next })}
        onRetry={remediation => {
          acceptCase(remediation)
          setRetryCases(previous => ({ ...previous, [`exercise:${file.id}`]: remediation.id }))
          setCodeResult(undefined)
          setCodeRevision(previous => previous + 1)
        }} />}
      {codeResult && !codeResult.passed && !codeCaseId && <p>这次未返回可用的纠错记录，可返回对话继续处理。{reviewAction}</p>}
      </>}
    </section>
  )
}
