import { lazy, Suspense, useEffect, useState } from 'react'
import { loadLectureFile, markFormalLectureRead, recordLearningFileAccess } from './formal-runtime'

const MarkdownContent = lazy(() => import('./MarkdownContent'))

type Props = {
  lectureId: number
  embedded?: boolean
  conversationId?: string
  sheetId?: string
  onAttach?: (file: { kind: 'lecture'; ref: string; title: string }) => void
  onFollowUp?: () => void
  initialPosition?: number
  onPositionChange?: (position: number) => void
}

export default function LectureFilePage({ lectureId, embedded, conversationId, sheetId, onAttach, onFollowUp, initialPosition = 0, onPositionChange }: Props) {
  const [file, setFile] = useState<Awaited<ReturnType<typeof loadLectureFile>>>()
  const [active, setActive] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void loadLectureFile(lectureId).then(result => {
      if (!alive) return
      setFile(result)
      setActive(Math.max(0, Math.min(initialPosition, result.sections.length - 1)))
      void recordLearningFileAccess('lecture', String(lectureId), 'opened', { conversation_id: conversationId, sheet_id: sheetId }).catch(() => undefined)
    }).catch(failure => alive && setError(failure instanceof Error ? failure.message : '讲义读取失败'))
    return () => { alive = false }
  }, [lectureId, conversationId, sheetId])
  if (error) return <div className="formal-inline-error">{error}</div>
  if (!file) return <div className="page-loading">正在打开正式讲义…</div>
  return (
    <section className={`lecture-file-workbench${embedded ? ' learning-file-embedded' : ''}`}>
      <header className="learning-file-workbench-heading">
        <div><span>讲义</span><h1>{file.title}</h1>{!embedded && <code>{file.logical_filename}</code>}</div>
        <div>
          {onFollowUp && <button type="button" className="learning-file-subtle-action" onMouseDown={event => event.preventDefault()} onClick={onFollowUp}>选中追问</button>}
          {onAttach && !embedded && <button type="button" onClick={() => onAttach({ kind: 'lecture', ref: String(file.id), title: file.title })}>放到对话纸张</button>}
          <button type="button" className="learning-file-subtle-action" onClick={() => void markFormalLectureRead(file.id).then(() => setNotice('已记录这次阅读。')).catch(failure => setError(failure instanceof Error ? failure.message : '讲义阅读事件记录失败'))}>标记已读</button>
        </div>
      </header>
      {notice && <div className="learning-evidence-notice">{notice}</div>}
      <div className="lecture-file-layout">
        <nav aria-label="讲义目录">{file.sections.map((section, index) => <button type="button" className={index === active ? 'active' : ''} key={`${section.title}-${index}`} onClick={() => { setActive(index); onPositionChange?.(index) }}><i>{String(index + 1).padStart(2, '0')}</i><span>{section.title || `第 ${index + 1} 节`}</span></button>)}</nav>
        <article><Suspense fallback={<div className="page-loading">渲染讲义…</div>}><MarkdownContent content={`# ${file.sections[active]?.title || file.title}\n\n${file.sections[active]?.content || '本节暂无内容。'}`} /></Suspense></article>
      </div>
      {!embedded && <footer>阅读位置会保留，便于下次继续。</footer>}
    </section>
  )
}
