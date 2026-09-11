import { useEffect, useState } from 'react'
import { loadLearningFiles, type FormalLearningFileRef } from './formal-runtime'
import './learning-files.css'

type Props = {
  onOpen: (file: FormalLearningFileRef) => void
  onOpenTasks: () => void
}

type FileView = 'all' | 'lecture' | 'practice'

export default function LearningFilesPage({ onOpen, onOpenTasks }: Props) {
  const [lectures, setLectures] = useState<FormalLearningFileRef[]>([])
  const [practices, setPractices] = useState<FormalLearningFileRef[]>([])
  const [error, setError] = useState('')
  const [view, setView] = useState<FileView>('all')
  const [loading, setLoading] = useState(false)
  const refresh = async () => {
    setLoading(true)
    try {
      const result = await loadLearningFiles()
      setLectures(result.lectures); setPractices(result.practices); setError('')
    } catch (failure) { setError(failure instanceof Error ? failure.message : '学习文件读取失败') }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])
  const total = lectures.length + practices.length
  const sections = [
    { id: 'lecture' as const, title: '讲义', description: '阅读重点、解释和示例', files: lectures },
    { id: 'practice' as const, title: '练习', description: '概念验证与代码练习', files: practices },
  ].filter(section => view === 'all' || section.id === view)

  return (
    <section className="learning-files-page">
      <header className="file-page-heading page-hero"><div><h1>讲义与练习</h1><p>集中查看学习任务生成的阅读材料和练习。</p></div><button type="button" className="learning-files-refresh" disabled={loading} onClick={() => void refresh()}><span aria-hidden="true">↻</span>{loading ? '刷新中' : '刷新'}</button></header>
      {error && <div className="formal-inline-error" role="alert">{error}</div>}
      <div className="learning-files-overview">
        <div className="learning-files-stats" aria-label="学习文件概览">
          <span><strong>{total}</strong>全部文件</span>
          <span><strong>{lectures.length}</strong>讲义</span>
          <span><strong>{practices.length}</strong>练习</span>
        </div>
        <div className="learning-files-filters" role="group" aria-label="筛选学习文件">
          <button type="button" className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>全部</button>
          <button type="button" className={view === 'lecture' ? 'active' : ''} onClick={() => setView('lecture')}>讲义</button>
          <button type="button" className={view === 'practice' ? 'active' : ''} onClick={() => setView('practice')}>练习</button>
        </div>
      </div>
      {total === 0 && loading ? (
        <div className="learning-files-loading" role="status"><span />正在读取学习文件…</div>
      ) : total === 0 ? (
        <div className="learning-files-empty">
          <span aria-hidden="true">▤</span>
          <h2>还没有讲义或练习</h2>
          <p>先打开一个学习任务并生成配套材料，生成后会自动归档到这里。</p>
          <div><button type="button" className="learning-files-primary" onClick={onOpenTasks}>查看学习任务</button><button type="button" onClick={() => void refresh()}>重新检查</button></div>
        </div>
      ) : (
        <div className={`learning-file-columns${sections.length === 1 ? ' learning-file-columns-single' : ''}`}>
          {sections.map(section => (
            <section key={section.id} className="learning-file-section">
              <header><div><h2>{section.title}</h2><p>{section.description}</p></div><i>{section.files.length}</i></header>
              <div className="learning-file-list">
                {section.files.length === 0 && <p className="learning-file-section-empty">当前没有{section.title}。</p>}
                {section.files.map(file => <FileCard key={`${file.kind}:${file.ref}`} file={file} onOpen={onOpen} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  )
}

function FileCard({ file, onOpen }: { file: FormalLearningFileRef; onOpen: (file: FormalLearningFileRef) => void }) {
  const typeLabel = file.kind === 'lecture' ? '讲义' : file.practice_kind === 'concept_question_set' ? '概念练习' : '代码练习'
  return <button type="button" className="learning-file-card" onClick={() => onOpen(file)}><span className="learning-file-kind" aria-hidden="true">{file.kind === 'lecture' ? '讲' : '练'}</span><div><span>{typeLabel}</span><h3>{file.title}</h3>{file.question_count ? <small>{file.question_count} 道题</small> : null}</div><i aria-hidden="true">›</i></button>
}
