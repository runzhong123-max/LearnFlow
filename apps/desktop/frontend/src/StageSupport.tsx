import type { AssistanceMode, StageAssistance, WorkflowMilestone } from './project-workbench-api'

export const assistanceOptions: Array<{ mode: AssistanceMode; label: string; detail: string }> = [
  { mode: 'direction', label: '给方向', detail: '抓住关键问题，自己尝试' },
  { mode: 'steps', label: '拆步骤', detail: '拆成小步，由你逐步完成' },
  { mode: 'pseudocode', label: '看伪代码', detail: '看逻辑骨架，自己写实现' },
  { mode: 'implementation', label: '协助实现', detail: '助手提出改动，你检查后写回' },
]

export function assistanceLabel(mode?: AssistanceMode) {
  return assistanceOptions.find(option => option.mode === mode)?.label || '给方向'
}

export default function StageSupport({ milestone, busy, guidance, compact = false, onChange, onDiscuss, onOpenFiles }: {
  milestone: WorkflowMilestone; busy: boolean; guidance?: string; compact?: boolean
  onChange: (mode: AssistanceMode, current: StageAssistance) => void
  onDiscuss: () => void; onOpenFiles?: () => void
}) {
  if (milestone.status === 'locked' || (!milestone.assistance && !milestone.student_tasks?.length)) return null
  const assistance = milestone.assistance
  const selected = assistanceOptions.find(option => option.mode === assistance?.mode) || assistanceOptions[0]
  const completed = milestone.status === 'accepted'
  const responsibilities = <div className="pw-responsibilities">
    <section><h3>你来做</h3><ul>{milestone.student_tasks?.map(item => <li key={item}>{item}</li>)}</ul></section>
    <section><h3>导师可帮</h3><ul>{milestone.mentor_support?.map(item => <li key={item}>{item}</li>)}</ul></section>
  </div>
  return <section className={`pw-stage-support${compact ? ' compact' : ''}`} aria-label="本阶段分工与帮助">
    <header><div><span>本阶段 · {completed ? '已交付' : '动手前先看这里'}</span><h2>{milestone.title}</h2></div>
      {onOpenFiles && <button className="pw-primary" onClick={onOpenFiles}>开始动手 →</button>}
    </header>
    {compact ? <details className="pw-division-detail"><summary>查看师生分工</summary>{responsibilities}</details> : responsibilities}
    {!!milestone.shared_tasks?.length && <details className="pw-shared-checks"><summary>一起核对什么</summary><ul>{milestone.shared_tasks.map(item => <li key={item}>{item}</li>)}</ul></details>}
    {assistance && <><fieldset className="pw-assistance-picker" disabled={busy || completed}>
      <legend>希望导师帮到哪一步？</legend>
      <div>{assistanceOptions.map(option => <label className={option.mode === assistance?.mode ? 'selected' : ''} key={option.mode}>
        <input type="radio" name={`assistance-${milestone.checkpoint_id}`} value={option.mode} checked={option.mode === assistance?.mode}
          onChange={() => onChange(option.mode, assistance)} /><span>{option.label}</span>
      </label>)}</div>
    </fieldset>
    <div className="pw-assistance-caption" role="status"><p>{busy ? '正在保存帮助档位…' : selected.detail}<small>{assistance?.execution_mode === 'workspace_write' ? '工程助手可提议修改；运行、写回分别确认。' : '工程助手只读分析；文件由你编辑。'}</small></p><button disabled={busy} onClick={onDiscuss}>按这档请教导师</button></div></>}
    {guidance && <details className="pw-stage-guidance" open={!compact || undefined}><summary>这一档的提示</summary><p>{guidance}</p></details>}
  </section>
}
