import type { AssistanceMode, WorkflowMilestone } from './project-workbench-api'

export const assistanceOptions: Array<{ mode: AssistanceMode; label: string; detail: string }> = [
  { mode: 'direction', label: '给方向', detail: '抓住关键问题，自己尝试' },
  { mode: 'steps', label: '拆步骤', detail: '拆成小步，由你逐步完成' },
  { mode: 'pseudocode', label: '看伪代码', detail: '看逻辑骨架，自己写实现' },
  { mode: 'implementation', label: '协助实现', detail: '助手提出改动，你检查后写回' },
]

export function assistanceLabel(mode?: AssistanceMode) {
  return assistanceOptions.find(option => option.mode === mode)?.label || '给方向'
}

export default function StageSupport({ milestone, compact = false, onOpenFiles }: {
  milestone: WorkflowMilestone; compact?: boolean; onOpenFiles?: () => void
}) {
  if (milestone.status === 'locked') return null
  return <section className={`pw-stage-support${compact ? ' compact' : ''}`} aria-label="本阶段分工">
    <header><h2>{milestone.title}</h2></header>
    <details className="pw-division-detail"><summary>查看师生分工</summary><div className="pw-responsibilities">
      <section><h3>你来做</h3><ul>{milestone.student_tasks?.map(item => <li key={item}>{item}</li>)}</ul></section>
      <section><h3>导师可帮</h3><ul>{milestone.mentor_support?.map(item => <li key={item}>{item}</li>)}</ul></section>
    </div></details>
    {!!milestone.shared_tasks?.length && <details><summary>一起核对什么</summary><ul>{milestone.shared_tasks.map(item => <li key={item}>{item}</li>)}</ul></details>}
    {onOpenFiles && <button onClick={onOpenFiles}>打开文件，在代码纸中请教导师 →</button>}
  </section>
}
