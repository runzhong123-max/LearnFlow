import { useState } from 'react'
import type { FormalLearningTask, FormalLearningTaskAction, FormalRuntimeConnection } from './formal-runtime'
import './learning-tasks.css'

const STATUS_LABELS: Record<FormalLearningTask['status'], string> = {
  proposed: '待确认', queued: '待开始', active: '进行中', paused: '已暂停', completed: '已完成', canceled: '已取消',
}

type Props = {
  connection: FormalRuntimeConnection
  tasks: FormalLearningTask[]
  busyTaskId?: number
  error: string
  onRefresh: () => void
  onAction: (task: FormalLearningTask, action: FormalLearningTaskAction) => void
  onGenerateFiles: (task: FormalLearningTask) => void
  onOpenFiles: () => void
  onStartLearning: () => void
  onReturnToScene: (task: FormalLearningTask) => void
}

type TaskFilter = 'pending' | 'all' | 'completed'

export default function LearningTasksPage({ connection, tasks, busyTaskId, error, onRefresh, onAction, onGenerateFiles, onOpenFiles, onStartLearning, onReturnToScene }: Props) {
  const [filter, setFilter] = useState<TaskFilter>('pending')
  const active = tasks.filter(task => !['completed', 'canceled'].includes(task.status))
  const completed = tasks.filter(task => task.status === 'completed')
  const inProgress = tasks.filter(task => task.status === 'active')
  const visibleTasks = filter === 'all'
    ? tasks
    : filter === 'completed'
      ? completed
      : active

  return (
    <section className="task-queue-page">
      <header className="task-queue-heading">
        <div><h1>学习任务</h1><p>查看当前安排、继续学习，或整理已经完成的任务。</p></div>
        <button type="button" className="task-refresh-button" onClick={onRefresh}><span aria-hidden="true">↻</span>刷新</button>
      </header>
      {connection.status !== 'connected' && <div className={`formal-runtime-strip formal-runtime-${connection.status}`}><i /> <strong>学习记录暂时离线</strong><span>{connection.detail}</span></div>}
      {error && <div className="formal-inline-error" role="alert">{error}</div>}
      <div className="task-queue-overview">
        <div className="task-queue-stats" aria-label="学习任务概览">
          <article><strong>{active.length}</strong><span>待完成</span></article>
          <article><strong>{inProgress.length}</strong><span>进行中</span></article>
          <article><strong>{completed.length}</strong><span>已完成</span></article>
        </div>
        <div className="task-queue-filters" role="group" aria-label="筛选学习任务">
          <button type="button" className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>待完成</button>
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
          <button type="button" className={filter === 'completed' ? 'active' : ''} onClick={() => setFilter('completed')}>已完成</button>
        </div>
      </div>
      <div className="task-queue-list">
        {visibleTasks.length === 0 && (
          <div className="task-queue-empty">
            <span aria-hidden="true">✓</span>
            <h2>{tasks.length === 0 ? '还没有学习任务' : filter === 'completed' ? '还没有完成的任务' : '当前没有待完成任务'}</h2>
            <p>{tasks.length === 0 ? '从一段对话开始，说出你想学什么，LearnFlow 会把目标整理成可继续的学习任务。' : '切换到“全部”查看其他任务，或开始一项新的学习。'}</p>
            <div>
              <button type="button" className="task-empty-primary" onClick={onStartLearning}>去对话开始学习</button>
              {tasks.length > 0 && <button type="button" onClick={() => setFilter('all')}>查看全部任务</button>}
            </div>
          </div>
        )}
        {visibleTasks.map((task, index) => {
          const phases = task.plan?.phases || []
          const currentPhase = phases.find(phase => phase.id === task.current_phase_id)
            || phases.find(phase => phase.status !== 'completed')
          const completedPhases = phases.filter(phase => phase.status === 'completed').length
          return (
          <article key={task.id} className={`task-queue-card task-status-${task.status}`}>
            <span className="task-queue-order">{String(index + 1).padStart(2, '0')}</span>
            <div className="task-queue-copy">
              <span className="task-queue-meta"><b>{STATUS_LABELS[task.status]}</b><i>{task.estimated_minutes} 分钟</i></span>
              <h2>{task.title}</h2><p>{task.objective}</p>
              {phases.length > 0 && <div className="task-phase-progress" aria-label={`已完成 ${completedPhases} / ${phases.length} 个阶段`}>
                <i style={{ width: `${Math.round((completedPhases / phases.length) * 100)}%` }} />
                <b>{completedPhases}/{phases.length}</b><em>{currentPhase?.title || (task.status === 'completed' ? '流程已完成' : '等待进入')}</em>
              </div>}
              <small>{task.success_criteria?.[0] || '按任务计划完成可检查的学习动作'}</small>
            </div>
            <div className="task-queue-actions">
              <button type="button" className="task-return-primary" onClick={() => onReturnToScene(task)}>回到学习现场</button>
              {task.artifact_refs?.length > 0
                ? <button type="button" onClick={onOpenFiles}>打开讲义与练习</button>
                : ['queued', 'active', 'paused'].includes(task.status) && <button type="button" disabled={busyTaskId === task.id} onClick={() => onGenerateFiles(task)}>生成讲义与练习</button>}
              {task.available_actions.includes('start') && <button type="button" disabled={busyTaskId === task.id} onClick={() => onAction(task, 'start')}>开始</button>}
              {task.available_actions.includes('complete_phase') && <button type="button" disabled={busyTaskId === task.id} onClick={() => onAction(task, 'complete_phase')}>完成当前阶段</button>}
              {task.available_actions.includes('complete_task') && <button type="button" disabled={busyTaskId === task.id} onClick={() => onAction(task, 'complete_task')}>完成任务</button>}
              {task.available_actions.includes('pause') && <button type="button" disabled={busyTaskId === task.id} onClick={() => onAction(task, 'pause')}>暂停</button>}
              {task.available_actions.includes('resume') && <button type="button" disabled={busyTaskId === task.id} onClick={() => onAction(task, 'resume')}>恢复</button>}
              {task.available_actions.includes('cancel') && <button type="button" className="task-cancel" disabled={busyTaskId === task.id} onClick={() => onAction(task, 'cancel')}>取消</button>}
              {task.available_actions.includes('reopen') && <button type="button" disabled={busyTaskId === task.id} onClick={() => onAction(task, 'reopen')}>重新加入</button>}
            </div>
          </article>
          )
        })}
      </div>
    </section>
  )
}
