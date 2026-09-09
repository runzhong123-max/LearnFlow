import { useRef, useState, type MouseEvent } from 'react'
import { isDesktopRuntime } from './runtime-client'
import './project-task-entry.css'

const packagesUrl = 'https://roles.learnflow.club/registry'
const conversionUrl = 'https://w2ltask.learnflow.club/'

export default function ProjectTaskEntry({ expanded }: { expanded: boolean }) {
  const opening = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const open = async (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    if (!isDesktopRuntime()) return
    event.preventDefault()
    if (opening.current) return
    opening.current = true
    setBusy(true)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_external_url', { url })
    } catch {
      setError(`浏览器未能打开，请重试，或在浏览器访问 ${url}`)
    } finally {
      opening.current = false
      setBusy(false)
    }
  }

  return <section className={`project-task-entry${expanded ? ' expanded' : ''}`} aria-labelledby="project-task-entry-title">
    <div className="project-task-entry-copy">
      <h2 id="project-task-entry-title">从已有岗位任务开始</h2>
      <p>在“我的岗位包”中打开典型任务卡片，把真实工作转成学习方案。</p>
      {expanded && <ol aria-label="岗位任务到项目的步骤">
        <li>选岗位与任务</li><li>转为学习任务</li><li>确认方案，回到桌面实践</li>
      </ol>}
    </div>
    <div className="project-task-entry-actions">
      <a className="project-task-entry-primary" href={packagesUrl} target="_blank" rel="noopener noreferrer" aria-disabled={busy} onClick={event => { void open(event, packagesUrl) }}>从我的岗位包选任务 <span aria-hidden="true">↗</span></a>
      <a href={conversionUrl} target="_blank" rel="noopener noreferrer" aria-disabled={busy} onClick={event => { void open(event, conversionUrl) }}>已有任务，直接转换 <span aria-hidden="true">↗</span></a>
      <small>在浏览器打开 · 请使用桌面同一账号</small>
    </div>
    {error && <p role="alert" className="project-task-entry-error">{error}</p>}
  </section>
}
