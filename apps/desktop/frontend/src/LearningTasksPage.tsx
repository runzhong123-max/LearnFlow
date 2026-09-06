import type { FormalLearningTask, FormalLearningTaskAction, FormalRuntimeConnection } from './formal-runtime'

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
  onReturnToScene: (task: FormalLearningTask) => void
}

export default function LearningTasksPage({ connection, tasks, busyTaskId, error, onRefresh, onAction, onGenerateFiles, onOpenFiles, onReturnToScene }: Props) {
  const active = tasks.filter(task => !['completed', 'canceled'].includes(task.status))
  return (
    <section className="task-queue-page">
      <header className="task-queue-heading">
        <div><h1>学习任务</h1><p>安排待完成的学习；具体过程回到原对话继续。</p></div>
        <button type="button" onClick={onRefresh} aria-label="刷新学习任务">↻</button>
      </header>
      {connection.status !== 'connected' && <div className={`formal-runtime-strip formal-runtime-${connection.status}`}><i /> <strong>学习记录暂时离线</strong><span>{connection.detail}</span></div>}
      {error && <div className="formal-inline-error" role="alert">{error}</div>}
      <div className="task-queue-summary"><strong>{active.length}</strong><span>个待完成</span></div>
      <div className="task-queue-list">
        {tasks.length === 0 && <div className="formal-empty-copy">还没有正式学习任务。在对话中说“带我学……”或切到带领学习态即可创建。</div>}
        {tasks.map((task, index) => {
          const phases = task.plan?.phases || []
          const currentPhase = phases.find(phase => phase.id === task.current_phase_id)
            || phases.find(phase => phase.status !== 'completed')
          const completedPhases = phases.filter(phase => phase.status === 'completed').length
          return (
          <article key={task.id} className={`task-queue-card task-status-${task.status}`}>
            <span className="task-queue-order">{String(index + 1).padStart(2, '0')}</span>
            <div className="task-queue-copy">
              <span>{STATUS_LABELS[task.status]} · {task.estimated_minutes} 分钟</span>
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
