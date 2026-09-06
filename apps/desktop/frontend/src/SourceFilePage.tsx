import { lazy, Suspense, useEffect, useState } from 'react'
import { loadSourcePaper, recordLearningFileAccess } from './formal-runtime'

const MarkdownContent = lazy(() => import('./MarkdownContent'))

type Props = {
  sourceId: number
  embedded?: boolean
  conversationId?: string
  sheetId?: string
  onAttach?: (file: { kind: 'source'; ref: string; title: string; projectId?: number }) => void
  onFollowUp?: () => void
  initialPosition?: number
  onPositionChange?: (position: number) => void
}

const CODE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go',
  h: 'c', hpp: 'cpp', html: 'html', java: 'java', js: 'javascript',
  json: 'json', jsx: 'jsx', kt: 'kotlin', md: 'markdown', php: 'php',
  py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', sql: 'sql', swift: 'swift',
  toml: 'toml', ts: 'typescript', tsx: 'tsx', xml: 'xml', yaml: 'yaml', yml: 'yaml',
}

function sourceUnit(formatId = ''): string {
  if (formatId === 'pdf') return '页'
  if (formatId === 'pptx') return '幻灯片'
  if (formatId === 'xlsx') return '工作表'
  if (formatId === 'ipynb') return '单元'
  if (formatId === 'source_code' || formatId === 'configuration') return '代码段'
  return '片段'
}

function codeLanguage(filename: string): string {
  return CODE_LANGUAGE_BY_EXTENSION[filename.split('.').pop()?.toLowerCase() || ''] || 'text'
}

function sectionMarkdown(
  formatId: string,
  filename: string,
  section: { title: string; content: string } | undefined,
): string {
  if (!section) return '资料尚未形成可阅读片段。'
  if (formatId === 'source_code' || formatId === 'configuration') {
    return `## ${section.title}\n\n\`\`\`${codeLanguage(filename)}\n${section.content}\n\`\`\``
  }
  return `## ${section.title}\n\n${section.content}`
}

export default function SourceFilePage({ sourceId, embedded, conversationId, sheetId, onAttach, onFollowUp, initialPosition = 0, onPositionChange }: Props) {
  const [file, setFile] = useState<Awaited<ReturnType<typeof loadSourcePaper>>>()
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setFile(undefined)
    setActive(0)
    setError('')
    void loadSourcePaper(sourceId).then(result => {
      if (!alive) return
      setFile(result)
      setActive(Math.max(0, Math.min(initialPosition, result.sections.length - 1)))
      void recordLearningFileAccess('source', String(sourceId), 'opened', {
        conversation_id: conversationId,
        sheet_id: sheetId,
      }).catch(() => undefined)
    }).catch(failure => alive && setError(failure instanceof Error ? failure.message : '资料读取失败'))
    return () => { alive = false }
  }, [sourceId, conversationId, sheetId])
  if (error) return <div className="formal-inline-error">{error}</div>
  if (!file) return <div className="page-loading">正在打开资料…</div>
  const section = file.sections[active]
  const formatId = file.format?.format_id || ''
  const formatLabel = file.format?.format_label || (file.type === 'url' ? '网页' : '资料')
  const unit = sourceUnit(formatId)
  return (
    <section className={`source-file-workbench${embedded ? ' learning-file-embedded' : ''}`}>
      <header className="learning-file-workbench-heading">
        <div><span className="source-format-label">{formatLabel}</span><h1>{file.name}</h1>{!embedded && file.url && <code>{file.url}</code>}</div>
        <div>
          {onFollowUp && <button type="button" className="learning-file-subtle-action" onMouseDown={event => event.preventDefault()} onClick={onFollowUp}>选中追问</button>}
          {onAttach && !embedded && <button type="button" onClick={() => onAttach({ kind: 'source', ref: String(file.id), title: file.name, projectId: file.project_id })}>放到对话纸张</button>}
        </div>
      </header>
      {file.sections.length > 1 && <nav className="source-paper-navigation" aria-label={`资料${unit}`}>
        <button type="button" disabled={active === 0} onClick={() => { const next = Math.max(0, active - 1); setActive(next); onPositionChange?.(next) }} aria-label={`上一${unit}`}>←</button>
        <label>
          <span>{active + 1} / {file.sections.length}</span>
          <select value={active} onChange={event => { const next = Number(event.target.value); setActive(next); onPositionChange?.(next) }} aria-label={`选择${unit}`}>
            {file.sections.map((item, index) => <option value={index} key={item.chunk_id}>第 {index + 1} {unit} · {item.title}</option>)}
          </select>
        </label>
        <button type="button" disabled={active >= file.sections.length - 1} onClick={() => { const next = Math.min(file.sections.length - 1, active + 1); setActive(next); onPositionChange?.(next) }} aria-label={`下一${unit}`}>→</button>
      </nav>}
      <article className="source-paper-content">
        <Suspense fallback={<div className="page-loading">渲染资料…</div>}>
          <MarkdownContent content={sectionMarkdown(formatId, file.name, section)} />
        </Suspense>
      </article>
      {file.content_truncated && <footer>内容较长，本页显示已建立索引的前部片段。</footer>}
    </section>
  )
}
