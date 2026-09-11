import { useEffect, useState, type FormEvent } from 'react'
import { createFormalProject, deleteFormalProject, listFormalProjects } from './formal-runtime'
import type { FormalProjectWorkspace } from './project'

export default function ProjectsPage({ onOpen, onProjectsChanged }: {
  onOpen: (project: FormalProjectWorkspace['project']) => void
  onProjectsChanged?: () => void
}) {
  const [projects, setProjects] = useState<FormalProjectWorkspace['project'][]>([])
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [outcome, setOutcome] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = () => listFormalProjects().then(result => setProjects(result.projects)).catch(error => setError(error instanceof Error ? error.message : '项目加载失败'))
  useEffect(() => { void refresh() }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !objective.trim()) return
    setBusy(true); setError('')
    try {
      const result = await createFormalProject({ name: name.trim(), objective: objective.trim(), expectedOutcome: outcome.trim() })
      setProjects(previous => [result.project, ...previous])
      setName(''); setObjective(''); setOutcome('')
      onOpen(result.project)
    } catch (error) {
      setError(error instanceof Error ? error.message : '项目创建失败')
    } finally { setBusy(false) }
  }

  const remove = async (project: FormalProjectWorkspace['project']) => {
    if (!confirm(`删除项目“${project.name}”？\n\n项目会从工作区移除；历史学习证据不会被反向删除。`)) return
    setBusy(true); setError('')
    try {
      await deleteFormalProject(project.id)
      setProjects(previous => previous.filter(item => item.id !== project.id))
      onProjectsChanged?.()
    } catch (error) {
      setError(error instanceof Error ? error.message : '项目删除失败')
    } finally { setBusy(false) }
  }

  return (
    <section className="projects-page">
      <header className="projects-hero">
        <span className="eyebrow">APPRENTICESHIP PROJECTS</span>
        <h1>学习项目</h1>
        <p>项目是一段以真实产物为目标的学徒旅程。项目 Tutor 先规划；确认后才生成关卡、对话与学习任务。</p>
      </header>
      <form className="project-create-card" onSubmit={submit}>
        <div><span>NEW PROJECT</span><h2>先固定主题、目标与产物</h2></div>
        <label><span>项目主题</span><input value={name} onChange={event => setName(event.target.value)} placeholder="例如：实现一个可评测的 RAG Agent" /></label>
        <label><span>学习目标</span><textarea value={objective} onChange={event => setObjective(event.target.value)} placeholder="希望真正理解和能独立完成什么？" /></label>
        <label><span>预期产物</span><input value={outcome} onChange={event => setOutcome(event.target.value)} placeholder="例如：可运行仓库、实验报告、演示视频" /></label>
        <button type="submit" disabled={busy || !name.trim() || !objective.trim()}>{busy ? '正在建立项目…' : '建立项目工作台'}</button>
        {error && <p className="project-error">{error}</p>}
      </form>
      <div className="project-library">
        <header><span>MY PROJECTS</span><strong>{projects.length} 个项目</strong></header>
        {projects.length ? projects.map(project => (
          <article className="project-library-card" key={project.id}>
            <button type="button" className="project-card-open" onClick={() => onOpen(project)}>
              <span>PROJECT {String(project.id).padStart(2, '0')}</span>
              <strong>{project.name}</strong>
              <p>{project.objective}</p>
              <small>{project.expected_outcome ? `目标产物：${project.expected_outcome}` : '尚未描述目标产物'} <i>进入 ›</i></small>
            </button>
            <button type="button" className="project-card-delete" disabled={busy} onClick={() => void remove(project)}>删除项目</button>
          </article>
        )) : <div className="project-empty">还没有项目。上面的三项信息足够先建立一个空工作台。</div>}
      </div>
    </section>
  )
}
