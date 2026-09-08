export type ConversionMode = 'learning' | 'experiment' | 'practice'
export type ConversionBrief = {
  task_title: string; task_description: string; work_context: string; deliverable: string
  acceptance_criteria: string[]; constraints: string[]; learner_level: string
  source_refs?: Record<string, unknown>[]
}
export type ConversionView = {
  id: string; revision: number; root_hash: string; state: string; original_input: string
  brief: ConversionBrief; source_refs: Record<string, unknown>[]
  messages: {role: string; content: string}[]; missing_fields: string[]; question: string
  question_budget_remaining: number; candidate?: Record<string, any> | null
  selection?: {selected_step_ids?: string[] | null; project_id?: number | null; action?: string} | null
  generation?: {id?: string; status: string; error_code?: string; error_message?: string} | null
  design_recipes?: Record<string, any>[]
}
export const conversionModes: {id: ConversionMode; name: string; description: string; destination: string}[] = [
  {id:'learning', name:'学习型', description:'理解完成工作所需的知识与技能', destination:'LearnFlow 学习空间'},
  {id:'experiment', name:'实验型', description:'先预测，再动手验证一个关键问题', destination:'桌面实验工作台'},
  {id:'practice', name:'实践型', description:'跟随工作节奏，完成接手、交付与复盘', destination:'桌面带教项目'},
]
export function lineItems(value: string) { return value.split('\n').map(item => item.trim()).filter(Boolean) }
export function conversionIdFromSearch(search: string) {
  const id = new URLSearchParams(search).get('conversion') || ''
  return /^[A-Za-z0-9_-]{1,120}$/.test(id) ? id : ''
}
export function safeResourceUrl(value: unknown) {
  try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '' } catch { return '' }
}
export function learningDestination(path: string, currentOrigin: string) {
  const base = currentOrigin === 'https://w2ltask.learnflow.club' ? 'https://learn.learnflow.club' : currentOrigin
  const url = new URL(path, base)
  if (url.origin !== base || !/^\/(projects|chat|tasks)(\/|\?|$)/.test(url.pathname)) throw new Error('项目接续地址无效，请刷新后重试。')
  return url.href
}
export function conversionClient(fetcher: typeof fetch) {
  return async function request<T = ConversionView>(path = '', body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetcher(`/api/work-task-conversions${path}`, {
      method: body ? 'POST' : 'GET', headers: body ? {'Content-Type':'application/json'} : {},
      ...(body ? {body:JSON.stringify(body)} : {}), signal,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = data.detail || data
      throw new Error(typeof detail === 'string' ? detail : detail.message || detail.error_message || `请求未完成（${response.status}），请刷新方案后重试。`)
    }
    return data as T
  }
}

export function generationRetryIdentity(view: Pick<ConversionView, 'generation'>) {
  return view.generation?.status === 'failed' ? view.generation.id || 'failed' : 'initial'
}
