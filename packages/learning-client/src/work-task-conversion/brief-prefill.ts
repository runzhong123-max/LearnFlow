import type { ConversionBrief, ConversionView } from './client.ts'

/** Editable draft suggestions only; never save or infer learner mastery here. */
export function prefillBrief(view: Pick<ConversionView, 'brief' | 'original_input' | 'candidate' | 'selection' | 'generation'>) {
  const brief = { ...view.brief }
  const suggested: string[] = []
  if (view.candidate || view.selection || view.generation?.status === 'running') return { brief, suggested }
  const source = brief.task_description || view.original_input
  const labels = '工作情境|工作对象|对象|交付结果|交付物|交付|完成标准|验收标准|条件与限制|限制|已有基础'
  const entries = [...source.matchAll(new RegExp(`(?:^|[（(;；\\n])\\s*(${labels})\\s*[:：]\\s*`, 'gu'))]
  const facts = new Map<string, string>()
  entries.forEach((entry, index) => {
    const value = source.slice(entry.index! + entry[0].length, entries[index + 1]?.index ?? source.length)
      .replace(/[）)；;。\s]+$/u, '').trim()
    if (value) facts.set(entry[1], value)
  })
  const fact = (...keys: string[]) => keys.map(key => facts.get(key)).find(Boolean) || ''
  const title = brief.task_title || view.original_input.slice(0, 120)
  const defaults: ConversionBrief = {
    task_title: title,
    task_description: source,
    work_context: fact('工作情境', '工作对象', '对象') || `建议情境：围绕“${title}”开展一次可复现的工作演练，具体对象可修改。`,
    deliverable: fact('交付结果', '交付物', '交付') || `建议交付：完成“${title}”的工作产物，并附操作记录与结果说明。`,
    acceptance_criteria: [fact('完成标准', '验收标准') || '建议验收：产物覆盖任务要求，关键步骤可复现，并提供结果检查记录。'],
    constraints: fact('条件与限制', '限制') ? [fact('条件与限制', '限制')] : ['建议限制：先使用练习环境和样例材料；实际环境、时间与资源要求可另行修改。'],
    learner_level: '尚未说明相关基础；先从必要的基础说明开始，根据实际情况调整。',
  }
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const current = brief[key]
    if ((Array.isArray(current) ? current.some(item => typeof item === 'string' && item.trim()) : typeof current === 'string' && current.trim())) continue
    Object.assign(brief, { [key]: defaults[key] })
    suggested.push(key)
  }
  return { brief, suggested }
}
