/** Transcript-only projection. The original message remains intact for Tutor context. */
export function conversionMessagePresentation(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = value as Record<string, any>
  if (data.schema_version !== 'learnflow.work-task-conversion.v1' || !data.brief || !data.candidate) return undefined
  const scalar = (item: unknown) => typeof item === 'string' ? item : ''
  const lines = (items: unknown) => Array.isArray(items) ? items.filter(item=>typeof item === 'string').map(item=>`- ${item}`).join('\n') : ''
  const brief = data.brief
  const candidate = data.candidate
  const parts = [
    `我想继续讨论 **${scalar(brief.task_title)}**。`, scalar(brief.task_description),
    `**工作情境**\n${scalar(brief.work_context)}`, `**期望交付**\n${scalar(brief.deliverable)}`,
    `**验收标准**\n${lines(brief.acceptance_criteria)}`,
  ]
  if (brief.constraints?.length) parts.push(`**条件与限制**\n${lines(brief.constraints)}`)
  const steps = data.selected_learning_candidate?.task?.steps || candidate.learning_candidate?.task?.steps || candidate.design?.stages || candidate.design?.proposed_phases
  if (Array.isArray(steps)) parts.push('**已经形成的方案**\n' + steps.map((step,index)=>`${index+1}. **${scalar(step.title)}**：${scalar(step.action)||scalar(step.objective)||scalar(step.target_deliverable)}`).join('\n'))
  const sources = Array.isArray(data.source_refs) ? data.source_refs : []
  if (sources.length) parts.push('**任务来源**\n' + sources.map(ref=>{
    if (ref.type === 'role_task') return `- ${scalar(ref.role_title)} · ${scalar(ref.task_ref?.label)}（岗位包 ${scalar(ref.package_ref?.packageVersion)}）`
    return `- ${scalar(ref.label)||'已附加的任务来源'}`
  }).join('\n'))
  parts.push('请结合以上方案和随附来源，继续讨论资料与学习安排。')
  return parts.filter(Boolean).join('\n\n')
}
