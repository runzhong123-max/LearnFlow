import { useId, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from 'react'
// @ts-ignore -- Vite resolves CSS Modules; this project intentionally has no global CSS module declaration.
import styles from './CodePaperWorkbench.module.css'

export type CodePaperSourceFile = {
  name?: string
  content?: string | null
  read_only?: boolean
}

export type CodePaperResult = {
  passed: boolean | number
  total?: number
  stdout?: string
  stderr?: string
  results?: Array<Record<string, unknown>>
  attempt_id?: number
  [key: string]: unknown
}

type Props = {
  description?: string
  starterCode?: string
  files?: CodePaperSourceFile[]
  entrypoint?: string
  requirements?: string[]
  hints?: string[]
  busy?: boolean
  error?: string
  result?: CodePaperResult
  inline?: boolean
  onOpenPaper?: () => void
  onSubmitCode: (code: string) => void | Promise<void>
}

type WorkbenchFile = {
  id: string
  name: string
  content: string
  readOnly: boolean
  entrypoint: boolean
}

function normalizedFiles(files: CodePaperSourceFile[] | undefined, starterCode: string, entrypoint: string): WorkbenchFile[] {
  const sourceFiles = (files || []).filter(item => item && typeof item === 'object')
  if (sourceFiles.length === 0) {
    return [{
      id: 'single-file',
      name: entrypoint || 'main.py',
      content: starterCode,
      readOnly: false,
      entrypoint: Boolean(entrypoint),
    }]
  }

  return sourceFiles.map((file, index) => {
    const name = String(file.name || '').trim() || `file-${index + 1}.py`
    return {
      id: `${index}:${name}`,
      name,
      content: typeof file.content === 'string' ? file.content : (index === 0 ? starterCode : ''),
      readOnly: file.read_only === true,
      entrypoint: Boolean(entrypoint) && name === entrypoint,
    }
  })
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

function resultPassed(result: CodePaperResult): boolean {
  if (typeof result.passed === 'boolean') return result.passed
  if (typeof result.total === 'number') return result.total > 0 && result.passed >= result.total
  return result.passed > 0
}

function resultSummary(result: CodePaperResult): string {
  if (typeof result.passed === 'number' && typeof result.total === 'number') {
    return `${result.passed} / ${result.total} 项通过`
  }
  return resultPassed(result) ? '全部验证通过' : '验证未通过'
}

function executionBoundary(result: CodePaperResult): string {
  const candidate = result.execution_boundary ?? result.executionBoundary ?? result.execution_boundary_note
  return typeof candidate === 'string' ? candidate.trim() : ''
}

function fileLanguage(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase()
  const labels: Record<string, string> = {
    css: 'CSS', html: 'HTML', js: 'JavaScript', json: 'JSON', jsx: 'JSX', md: 'Markdown',
    py: 'Python', sh: 'Shell', ts: 'TypeScript', tsx: 'TSX', yaml: 'YAML', yml: 'YAML',
  }
  return labels[extension || ''] || '代码'
}

function ValidationResult({ result, stale, idPrefix }: { result: CodePaperResult; stale: boolean; idPrefix: string }) {
  const passed = resultPassed(result)
  const boundary = executionBoundary(result)
  const cases = Array.isArray(result.results) ? result.results : []
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''

  return (
    <div className={styles.resultBody} aria-live="polite">
      <div className={`${styles.verdict} ${passed ? styles.verdictPassed : styles.verdictFailed}`}>
        <span aria-hidden="true">{passed ? '✓' : '!'}</span>
        <div>
          <strong>{passed ? '验证通过' : '验证未通过'}</strong>
          <small>{resultSummary(result)}</small>
        </div>
      </div>
      {stale && <p className={styles.staleNotice}>代码已在上次提交后修改，下面仍是上次提交的结果。</p>}
      {cases.length > 0 && (
        <section className={styles.caseSection} aria-labelledby={`${idPrefix}-cases-title`}>
          <header><span id={`${idPrefix}-cases-title`}>验证项</span><small>{cases.length} 项</small></header>
          <ol className={styles.caseList}>
            {cases.map((item, index) => {
              const itemPassed = item.passed === true || item.passed === 1
              const title = displayValue(item.name || item.title || item.case || item.test) || `验证项 ${index + 1}`
              const expected = displayValue(item.expected)
              const actual = displayValue(item.actual)
              const detail = displayValue(item.detail || item.message || item.error)
              const caseStderr = displayValue(item.stderr)
              return (
                <li key={`${index}-${title}`} className={itemPassed ? styles.casePassed : styles.caseFailed}>
                  <div><span aria-hidden="true">{itemPassed ? '✓' : '×'}</span><strong>{title}</strong><small>{itemPassed ? '通过' : '未通过'}</small></div>
                  {(expected || actual) && <dl>
                    {expected && <><dt>期望</dt><dd>{expected}</dd></>}
                    {actual && <><dt>实际</dt><dd>{actual}</dd></>}
                  </dl>}
                  {(detail || caseStderr) && <pre>{detail || caseStderr}</pre>}
                </li>
              )
            })}
          </ol>
        </section>
      )}
      <div className={styles.streamGrid}>
        <section className={styles.streamSection} aria-labelledby={`${idPrefix}-stdout-title`}>
          <header><span id={`${idPrefix}-stdout-title`}>stdout</span><small>标准输出</small></header>
          {stdout ? <pre>{stdout}</pre> : <p>没有标准输出</p>}
        </section>
        <section className={`${styles.streamSection} ${styles.stderrSection}`} aria-labelledby={`${idPrefix}-stderr-title`}>
          <header><span id={`${idPrefix}-stderr-title`}>stderr</span><small>错误输出</small></header>
          {stderr ? <pre>{stderr}</pre> : <p>没有错误输出</p>}
        </section>
      </div>
      {boundary && <p className={styles.boundaryNote}><strong>执行边界</strong>{boundary}</p>}
    </div>
  )
}

export default function CodePaperWorkbench({
  description,
  starterCode = '',
  files,
  entrypoint = '',
  requirements = [],
  hints = [],
  busy = false,
  error = '',
  result,
  inline = false,
  onOpenPaper,
  onSubmitCode,
}: Props) {
  const idPrefix = `code-paper-${useId()}`
  const workbenchFiles = useMemo(
    () => normalizedFiles(files, starterCode, entrypoint.trim()),
    [entrypoint, files, starterCode],
  )
  const initialActive = Math.max(0, workbenchFiles.findIndex(file => file.entrypoint))
  const [activeIndex, setActiveIndex] = useState(initialActive)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(
    workbenchFiles.map(file => [file.id, file.content]),
  ))
  const [submittedCode, setSubmittedCode] = useState<string>()
  const gutterRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activeFile = workbenchFiles[Math.min(activeIndex, workbenchFiles.length - 1)] || workbenchFiles[0]
  const activeCode = drafts[activeFile.id] ?? activeFile.content
  const lineNumbers = useMemo(() => Array.from({ length: Math.max(1, activeCode.split('\n').length) }, (_, index) => index + 1), [activeCode])
  const isMultiFile = workbenchFiles.length > 1
  const canSubmitFileShape = !isMultiFile && !activeFile.readOnly
  const canSubmit = canSubmitFileShape && Boolean(activeCode.trim()) && !busy
  const changed = activeCode !== activeFile.content
  const staleResult = Boolean(result && submittedCode !== undefined && submittedCode !== activeCode)

  const selectFile = (index: number) => {
    setActiveIndex(index)
    requestAnimationFrame(() => tabRefs.current[index]?.focus())
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const lastIndex = workbenchFiles.length - 1
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? lastIndex
        : event.key === 'ArrowLeft'
          ? (activeIndex - 1 + workbenchFiles.length) % workbenchFiles.length
          : (activeIndex + 1) % workbenchFiles.length
    selectFile(nextIndex)
  }

  const syncGutter = (event: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop
  }

  const submit = () => {
    if (!canSubmit) return
    setSubmittedCode(activeCode)
    void onSubmitCode(activeCode)
  }

  if (inline) {
    return (
      <article className={styles.inlineCard}>
        <div className={styles.inlineIcon} aria-hidden="true"><span>01</span><span>02</span><span>03</span></div>
        <div className={styles.inlineCopy}>
          <strong>代码练习</strong>
          <p>{description || '打开代码纸，阅读任务并完成代码。'}</p>
          <small>{isMultiFile ? `${workbenchFiles.length} 个文件` : fileLanguage(activeFile.name)}{entrypoint ? ` · 入口 ${entrypoint}` : ''}</small>
        </div>
        {onOpenPaper && <button type="button" className={styles.inlineOpen} onClick={onOpenPaper} aria-label="在新纸张打开代码练习">打开代码纸 <span aria-hidden="true">↗</span></button>}
      </article>
    )
  }

  return (
    <article className={styles.workbench}>
      <header className={styles.workbenchHeader}>
        <div>
          <span className={styles.eyebrow}>CODE PAPER</span>
          <h2>编写、检查，再提交验证</h2>
          <p>{description || '完成代码后提交验证。验证结果只对应本次正式提交。'}</p>
        </div>
        <div className={styles.meta} aria-label="练习信息">
          <span>{isMultiFile ? `${workbenchFiles.length} 个文件` : fileLanguage(activeFile.name)}</span>
          {entrypoint && <span>入口 {entrypoint}</span>}
          {requirements.filter(Boolean).slice(0, 4).map((requirement, index) => <span key={`${index}-${requirement}`}>{requirement}</span>)}
        </div>
      </header>

      {hints.length > 0 && <details className={styles.hints}>
        <summary>查看提示 <span>{hints.length}</span></summary>
        <ol>{hints.map((hint, index) => <li key={`${index}-${hint}`}>{hint}</li>)}</ol>
      </details>}

      <div className={styles.paperGrid}>
        <section className={styles.editorPane} aria-label="代码编辑区">
          <div className={styles.fileTabs} role="tablist" aria-label="练习文件" onKeyDown={handleTabKeyDown}>
            {workbenchFiles.map((file, index) => {
              const isActive = index === activeIndex
              const fileChanged = (drafts[file.id] ?? file.content) !== file.content
              return (
                <button
                  key={file.id}
                  ref={element => { tabRefs.current[index] = element }}
                  id={`${idPrefix}-tab-${index}`}
                  type="button"
                  role="tab"
                  aria-label={`${file.name}${file.entrypoint ? '，入口' : ''}${file.readOnly ? '，只读' : ''}${fileChanged ? '，已修改' : ''}`}
                  aria-selected={isActive}
                  aria-controls={`${idPrefix}-panel-${index}`}
                  tabIndex={isActive ? 0 : -1}
                  className={isActive ? styles.activeTab : undefined}
                  onClick={() => setActiveIndex(index)}
                >
                  <span>{file.name}</span>
                  {file.entrypoint && <small>入口</small>}
                  {file.readOnly && <small className={styles.readOnlyLabel}>只读</small>}
                  {fileChanged && !file.readOnly && <i aria-hidden="true" title="已修改" />}
                </button>
              )
            })}
          </div>
          <div className={styles.editorToolbar}>
            <div><strong>{activeFile.name}</strong><span>{fileLanguage(activeFile.name)}</span></div>
            <div>
              {activeFile.readOnly && <span className={styles.readOnlyPill}>只读文件</span>}
              {!activeFile.readOnly && <span>{isMultiFile ? '本页草稿' : changed ? '已修改' : '未修改'}</span>}
              {!activeFile.readOnly && <button type="button" disabled={!changed} onClick={() => setDrafts(previous => ({ ...previous, [activeFile.id]: activeFile.content }))}>还原</button>}
            </div>
          </div>
          <div
            key={activeFile.id}
            id={`${idPrefix}-panel-${activeIndex}`}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-${activeIndex}`}
            className={styles.editor}
          >
            <div ref={gutterRef} className={styles.gutter} aria-hidden="true">
              {lineNumbers.map(line => <span key={line}>{line}</span>)}
            </div>
            <textarea
              value={activeCode}
              readOnly={activeFile.readOnly}
              onChange={event => setDrafts(previous => ({ ...previous, [activeFile.id]: event.target.value }))}
              onScroll={syncGutter}
              aria-label={`${activeFile.readOnly ? '查看' : '编辑'} ${activeFile.name}`}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
            />
          </div>
        </section>

        <aside className={styles.resultPane} aria-label="提交验证面板">
          <header className={styles.resultHeader}>
            <div><span>VALIDATION</span><h3>提交验证</h3></div>
            <span role="status" aria-live="polite" className={busy ? styles.runningStatus : result ? (resultPassed(result) ? styles.passedStatus : styles.failedStatus) : styles.idleStatus}>
              {busy ? '验证中' : result ? (resultPassed(result) ? '通过' : '未通过') : '待提交'}
            </span>
          </header>
          {isMultiFile && <p className={styles.submissionLimit} role="note"><strong>多文件提交暂不可用</strong>当前提交接口只接收单段代码；这里的多文件修改仅保留在本页，不会被伪装成已提交。</p>}
          {!isMultiFile && activeFile.readOnly && <p className={styles.submissionLimit} role="note"><strong>当前文件为只读</strong>服务端将该文件标记为只读，因此不能提交修改。</p>}
          {error && <p className={styles.errorNotice} role="alert">{error}</p>}
          {result ? <ValidationResult result={result} stale={staleResult} idPrefix={idPrefix} /> : (
            <div className={styles.emptyResult}>
              <span aria-hidden="true">›_</span>
              <strong>还没有验证结果</strong>
              <p>{isMultiFile ? '可切换文件阅读和整理草稿；当前接口升级前不会提交多文件内容。' : '提交后会在这里分别显示验证项、标准输出和错误输出。'}</p>
            </div>
          )}
          <footer className={styles.submitBar}>
            <div><strong>{activeFile.name}</strong><small>{activeCode.split('\n').length} 行 · {activeCode.length} 字符</small></div>
            <button type="button" disabled={!canSubmit} onClick={submit} title={isMultiFile ? '当前接口不支持多文件提交' : undefined}>
              {busy ? '正在提交验证…' : isMultiFile ? '多文件提交暂不可用' : '提交验证'}
            </button>
          </footer>
        </aside>
      </div>
    </article>
  )
}
