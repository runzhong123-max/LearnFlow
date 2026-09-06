import { useEffect, useState, type FormEvent } from 'react'
import { createFormalProject, deleteFormalProject, listFormalProjects } from './formal-runtime'
import type { FormalProjectWorkspace, ProjectMode } from './project'
import { isDesktopRuntime } from './runtime-client'
import './project-workbench.css'

const modes: Array<{ id: ProjectMode; icon: string; title: string; detail: string }> = [
  { id: 'learning', icon: '01', title: '学一本书或一门课', detail: '带着问题读资料，用练习检验理解，再按节奏复习。' },
  { id: 'experiment', icon: '02', title: '做一个作品或实验', detail: '关联本地工程，提出假设，编写、运行并交付。' },
  { id: 'practice', icon: '03', title: '体验一个岗位任务', detail: '从版本化案例出发，在导师带领下调查、交付与复盘。' },
]

export default function ProjectsPage({ onOpen }: {
  onOpen: (project: FormalProjectWorkspace['project']) => void
}) {
  const [projects, setProjects] = useState<FormalProjectWorkspace['project'][]>([])
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [outcome, setOutcome] = useState('')
  const [mode, setMode] = useState<ProjectMode>(isDesktopRuntime() ? 'experiment' : 'learning')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = () => listFormalProjects().then(result => setProjects(result.projects)).catch(error => setError(error instanceof Error ? error.message : '项目加载失败'))
  useEffect(() => { void refresh() }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !objective.trim()) return
    setBusy(true); setError('')
    try {
      const result = await createFormalProject({ name: name.trim(), objective: objective.trim(), expectedOutcome: outcome.trim(), projectMode: mode, projectBrief: { deliverables: outcome.trim() ? [outcome.trim()] : [], constraints: [], success_criteria: [] } })
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
    } catch (error) {
      setError(error instanceof Error ? error.message : '项目删除失败')
    } finally { setBusy(false) }
  }

  return (
    <section className="projects-page">
      <header className="projects-hero">
        <div><span className="eyebrow">YOUR NEXT DISCOVERY</span>
        <h1>从好奇，走到做出来。</h1>
        <p>选一个起点。资料、真实文件、思考纸张与导师，会在同一个项目里陪你向前。</p></div>
      </header>
      <div className="project-mode-picker" role="group" aria-label="项目类型">{modes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} className={mode === item.id ? 'selected' : ''} onClick={() => setMode(item.id)}><span>{item.icon}</span><strong>{item.title}</strong><p>{item.detail}</p>{item.id === 'experiment' && <small>桌面端 · 真实本地工程</small>}</button>)}</div>
      <form className="project-create-card" onSubmit={submit}>
        <div><span>{modes.find(item => item.id === mode)?.title}</span><h2>给这段旅程一个目标</h2></div>
        <label><span>项目主题</span><input value={name} onChange={event => setName(event.target.value)} placeholder={mode === 'experiment' ? '例如：用 C 实现 SAT 求解器' : mode === 'practice' ? '例如：调查并修复工具中的一个缺陷' : '例如：理解《计算机系统》的内存章节'} /></label>
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
              <span>{project.project_mode === 'experiment' ? '实验项目' : project.project_mode === 'practice' ? '实践项目' : '学习项目'} · {String(project.id).padStart(2, '0')}</span>
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
