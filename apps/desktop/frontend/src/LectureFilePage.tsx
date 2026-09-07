import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ensureFormalIdentity, loadLectureFile, markFormalLectureRead, recordLearningFileAccess } from './formal-runtime'
import { getRuntimeClientState } from './runtime-client.ts'
import { browserFileProgressStorage, learningFileProgressKey, notifyLearningFileProgress, readFileProgress, restoredLecturePosition, saveFileProgress } from './learning-file-progress.ts'

const MarkdownContent = lazy(() => import('./MarkdownContent'))

type Props = {
  lectureId: number
  embedded?: boolean
  conversationId?: string
  sheetId?: string
  formalSessionId?: number
  learningTaskId?: number
  onAttach?: (file: { kind: 'lecture'; ref: string; title: string }) => void
  onFollowUp?: () => void
  onProgress?: () => Promise<void>
  onContinue?: () => void
  initialPosition?: number
  onPositionChange?: (position: number) => void
}

export default function LectureFilePage({ lectureId, embedded, conversationId, sheetId, formalSessionId, learningTaskId, onAttach, onFollowUp, onProgress, onContinue, initialPosition = 0, onPositionChange }: Props) {
  const [file, setFile] = useState<Awaited<ReturnType<typeof loadLectureFile>>>()
  const [active, setActive] = useState(0)
  const [positionKey, setPositionKey] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [progressError, setProgressError] = useState('')
  const [busy, setBusy] = useState(false)
  const [read, setRead] = useState(false)
  const actionInFlight = useRef(false)
  useEffect(() => {
    let alive = true
    setFile(undefined)
    setError('')
    setActionError('')
    setProgressError('')
    setNotice('')
    setRead(false)
    setBusy(false)
    void Promise.all([loadLectureFile(lectureId), ensureFormalIdentity()]).then(([result, account]) => {
      if (!alive) return
      const identity = `${getRuntimeClientState().kind}:${account.id}:${account.learner_id}`
      const key = learningFileProgressKey(identity, 'lecture', lectureId, result.version)
      setPositionKey(key)
      setActive(restoredLecturePosition(readFileProgress(browserFileProgressStorage(), key), result.sections.length, initialPosition))
      setFile(result)
      void recordLearningFileAccess('lecture', String(lectureId), 'opened', { conversation_id: conversationId, sheet_id: sheetId }).catch(() => undefined)
    }).catch(failure => alive && setError(failure instanceof Error ? failure.message : '讲义读取失败'))
    return () => { alive = false }
  }, [lectureId, conversationId, sheetId])
  if (error) return <div className="formal-inline-error">{error}</div>
  if (!file) return <div className="page-loading">正在打开正式讲义…</div>
  const syncProgress = async () => {
    setProgressError('')
    try { await notifyLearningFileProgress(onProgress, conversationId); return true }
    catch { setProgressError('阅读已保存，学习进度暂未更新。'); return false }
  }
  const markRead = async (continueToPractice = false) => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(true)
    setActionError('')
    try {
      if (!read) {
        await markFormalLectureRead(file.id, { session_id: formalSessionId, learning_task_id: learningTaskId })
        setRead(true)
        setNotice('已记录这次阅读。准备好后，可以用练习检查理解。')
      }
      if (await syncProgress() && continueToPractice) onContinue?.()
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : '阅读记录保存失败，请重试。')
    } finally { actionInFlight.current = false; setBusy(false) }
  }
  const selectSection = (index: number) => {
    setActive(index)
    saveFileProgress(browserFileProgressStorage(), positionKey, String(index))
    onPositionChange?.(index)
  }
  return (
    <section className={`lecture-file-workbench${embedded ? ' learning-file-embedded' : ''}`}>
      <header className="learning-file-workbench-heading">
        <div><span>讲义</span><h1>{file.title}</h1>{!embedded && <code>{file.logical_filename}</code>}</div>
        <div>
          {onFollowUp && <button type="button" className="learning-file-subtle-action" onMouseDown={event => event.preventDefault()} onClick={onFollowUp}>选中追问</button>}
          {onAttach && !embedded && <button type="button" onClick={() => onAttach({ kind: 'lecture', ref: String(file.id), title: file.title })}>放到对话纸张</button>}
          <button type="button" className="learning-file-subtle-action" disabled={busy || read} onClick={() => void markRead()}>{busy ? '正在保存…' : read ? '已记录阅读' : '标记已读'}</button>
        </div>
      </header>
      {notice && <div className="learning-evidence-notice" role="status">{notice}</div>}
      {actionError && <div className="formal-inline-error" role="alert">{actionError}</div>}
      {progressError && <div className="formal-inline-error" role="alert">{progressError} <button type="button" onClick={() => void syncProgress()}>重新同步</button></div>}
      <div className="lecture-file-layout">
        <nav aria-label="讲义目录">{file.sections.map((section, index) => <button type="button" className={index === active ? 'active' : ''} key={`${section.title}-${index}`} onClick={() => selectSection(index)}><i>{String(index + 1).padStart(2, '0')}</i><span>{section.title || `第 ${index + 1} 节`}</span></button>)}</nav>
        <article><Suspense fallback={<div className="page-loading">渲染讲义…</div>}><MarkdownContent content={`# ${file.sections[active]?.title || file.title}\n\n${file.sections[active]?.content || '本节暂无内容。'}`} /></Suspense></article>
      </div>
      {onContinue && <div className="learning-file-next-action"><button type="button" className="learning-primary-action" disabled={busy} onClick={() => void markRead(true)}>{busy ? '正在保存…' : read ? '进入配套练习' : '读完，进入练习'}</button></div>}
      {!embedded && <footer>这台设备会保留当前账号的阅读位置。</footer>}
    </section>
  )
}
