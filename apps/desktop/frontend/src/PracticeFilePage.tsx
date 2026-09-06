import { useEffect, useState } from 'react'
import {
  loadPracticeFile,
  recordLearningFileAccess,
  submitFormalConceptAnswer,
  submitFormalExercise,
} from './formal-runtime'
import CodePaperWorkbench, { type CodePaperResult, type CodePaperSourceFile } from './CodePaperWorkbench'

type Props = {
  practiceRef: string
  embedded?: boolean
  inline?: boolean
  conversationId?: string
  sheetId?: string
  onAttach?: (file: { kind: 'practice'; ref: string; title: string }) => void
  onFollowUp?: () => void
  onOpenPaper?: () => void
}

export default function PracticeFilePage({ practiceRef, embedded, inline, conversationId, sheetId, onAttach, onFollowUp, onOpenPaper }: Props) {
  const [file, setFile] = useState<Awaited<ReturnType<typeof loadPracticeFile>>>()
  const [answers, setAnswers] = useState<Record<number, number[]>>({})
  const [responses, setResponses] = useState<Record<number, string>>({})
  const [reflections, setReflections] = useState<Record<number, { blocker: string; helpfulFormat: string }>>({})
  const [results, setResults] = useState<Record<number, { correct: boolean; answer_indexes: number[]; expected_response?: unknown }>>({})
  const [codeResult, setCodeResult] = useState<CodePaperResult>()
  const [busy, setBusy] = useState('')
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
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
    void loadPracticeFile(practiceRef).then(result => {
      if (!alive) return
      setFile(result)
      if (!inline) void recordLearningFileAccess('practice', practiceRef, 'opened', { conversation_id: conversationId, sheet_id: sheetId }).catch(() => undefined)
    }).catch(failure => alive && setLoadError(failure instanceof Error ? failure.message : '练习读取失败'))
    return () => { alive = false }
  }, [practiceRef, conversationId, sheetId, inline])
  if (loadError) return <div className="formal-inline-error" role="alert">{loadError}</div>
  if (!file) return <div className="page-loading">正在打开正式练习…</div>
  const submitQuestion = async (questionId: number) => {
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
      const result = await submitFormalConceptAnswer(file.checkpoint_id, questionId, {
        ...structured,
        blocker_concept_key: reflection.blocker.trim(),
        helpful_format: reflection.helpfulFormat,
        support_effective: Boolean(reflection.helpfulFormat),
      })
      setResults(previous => ({ ...previous, [questionId]: result }))
    }
    catch (failure) { setActionError(failure instanceof Error ? failure.message : '提交失败') }
    finally { setBusy('') }
  }
  const submitCode = async (code: string) => {
    if (!file.id) return
    setBusy('code')
    setActionError('')
    setCodeResult(undefined)
    try { setCodeResult(await submitFormalExercise(file.id, code)) }
    catch (failure) { setActionError(failure instanceof Error ? failure.message : '代码评估失败') }
    finally { setBusy('') }
  }
  const codePractice = file as typeof file & {
    files?: CodePaperSourceFile[]
    entrypoint?: string
    requirements?: string[]
  }
  return (
    <section className={`practice-file-workbench${embedded ? ' learning-file-embedded' : ''}${inline ? ' learning-file-inline' : ''}`}>
      <header className={inline ? 'learning-file-inline-heading' : 'learning-file-workbench-heading'}>
        <div><span>{inline ? `练习 · ${file.questions?.length || 1} 题` : '练习'}</span><h1>{file.title}</h1>{!embedded && !inline && <code>{file.logical_filename}</code>}</div>
        <div>
          {onFollowUp && <button type="button" className="learning-file-subtle-action" onMouseDown={event => event.preventDefault()} onClick={onFollowUp}>选中追问</button>}
          {onAttach && !embedded && <button type="button" onClick={() => onAttach({ kind: 'practice', ref: file.ref, title: file.title })}>放到对话纸张</button>}
        </div>
      </header>
      {file.practice_kind !== 'exercise' ? <>
        {actionError && <div className="formal-inline-error" role="alert">{actionError}</div>}
        <div className="practice-question-list">{(file.questions || []).map((question, index) => {
        const selected = answers[question.id] || []
        const result = results[question.id]
        const selectionType = ['single', 'multi', 'judge'].includes(question.q_type)
        const hasResponse = question.q_type === 'ordered_blocks'
          ? selected.length === question.options.length
          : selectionType ? selected.length > 0 : Boolean((responses[question.id] || '').trim())
        const reflection = reflections[question.id] || { blocker: '', helpfulFormat: '' }
        return <article key={question.id}>
          {inline && onOpenPaper && <button type="button" className="practice-question-paper-open" title="在新纸张打开整份练习" aria-label="在新纸张打开整份练习" onClick={onOpenPaper}>↗</button>}
          <span>第 {index + 1} 题 · {question.difficulty === 'easy' ? '基础' : question.difficulty === 'hard' ? '挑战' : '进阶'}{question.target_skill ? ` · ${question.target_skill}` : ''}</span>
          <h2>{question.question}</h2>
          {question.code && <pre className="practice-question-code"><code>{question.code}</code></pre>}
          {question.q_type === 'ordered_blocks' ? <div className="practice-order-builder">
            <p>依次点击步骤，组成完整执行顺序。</p>
            <ol aria-label="已排列步骤">
              {selected.map(optionIndex => <li key={optionIndex}><button type="button" disabled={Boolean(result)} onClick={() => setAnswers(previous => ({ ...previous, [question.id]: selected.filter(item => item !== optionIndex) }))}><i>{selected.indexOf(optionIndex) + 1}</i><span>{question.options[optionIndex]}</span><b aria-hidden="true">×</b></button></li>)}
            </ol>
            <div className="practice-order-pool" aria-label="待排列步骤">
              {question.options.map((option, optionIndex) => selected.includes(optionIndex) ? null : <button key={optionIndex} type="button" disabled={Boolean(result)} onClick={() => setAnswers(previous => ({ ...previous, [question.id]: [...selected, optionIndex] }))}><i>{String.fromCharCode(65 + optionIndex)}</i><span>{option}</span></button>)}
            </div>
          </div> : selectionType ? <div className="practice-options">{question.options.map((option, optionIndex) => <label key={optionIndex} className={selected.includes(optionIndex) ? 'selected' : ''}><input type={question.q_type === 'multi' ? 'checkbox' : 'radio'} name={`q-${question.id}`} checked={selected.includes(optionIndex)} disabled={Boolean(result)} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: question.q_type === 'multi' ? (selected.includes(optionIndex) ? selected.filter(item => item !== optionIndex) : [...selected, optionIndex]) : [optionIndex] }))} /><i>{String.fromCharCode(65 + optionIndex)}</i><span>{option}</span></label>)}</div> : <textarea className="practice-structured-response" value={responses[question.id] || ''} onChange={event => setResponses(previous => ({ ...previous, [question.id]: event.target.value }))} disabled={Boolean(result)} placeholder={question.q_type === 'trace_table' ? '输入二维 JSON 数组，例如 [["i","sum"],["1","1"]]' : question.q_type === 'numeric' ? '输入数值' : '输入确定答案'} />}
          {question.q_type === 'ordered_blocks' && !result && selected.length > 0 && <button type="button" className="practice-reset-order" onClick={() => setAnswers(previous => ({ ...previous, [question.id]: [] }))}>重置顺序</button>}
          {!result && <details className="practice-reflection"><summary>补充这次作答的卡点或有效帮助（可选）</summary><div><label>哪一个前置概念卡住了你？<input value={reflection.blocker} onChange={event => setReflections(previous => ({ ...previous, [question.id]: { ...reflection, blocker: event.target.value } }))} placeholder="例如：矩阵乘法的形状" /></label><label>哪种帮助这次确实有效？<select value={reflection.helpfulFormat} onChange={event => setReflections(previous => ({ ...previous, [question.id]: { ...reflection, helpfulFormat: event.target.value } }))}><option value="">不记录</option><option value="visual">图解</option><option value="worked_example">完整示例</option><option value="code_example">代码例子</option><option value="step_by_step">逐步提示</option><option value="analogy">类比</option></select></label></div></details>}
          <button type="button" disabled={!hasResponse || Boolean(result) || Boolean(busy)} onClick={() => void submitQuestion(question.id)}>{busy === `question:${question.id}` ? '正在判定…' : result ? result.correct ? '回答正确' : '再想一想' : '提交作答'}</button>
          {result && <p className={result.correct ? 'practice-correct' : 'practice-wrong'}>{result.correct ? '回答正确。可以继续下一题，稍后再用变式确认。' : '这次还没有通过。具体错误已经保留，可在对话中继续纠正。'}</p>}
        </article>
      })}</div></> : <CodePaperWorkbench
        key={file.ref}
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
        onSubmitCode={submitCode}
      />}
    </section>
  )
}
