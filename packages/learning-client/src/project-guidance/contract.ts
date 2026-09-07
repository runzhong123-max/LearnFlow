export const PROJECT_GUIDANCE_VERSION = 'learnflow.project-guidance.v1' as const
export const PROJECT_GUIDANCE_PLUGIN_ID = 'learning_task_conversion' as const
export const PROJECT_GUIDANCE_RENDERER = 'project_guidance' as const
export const PROJECT_MODE_CHOICES = [
  { id: 'learning', label: '知识学习项目', description: '拆出知识与技能，沿用现有讯飞转换与学习任务流程。', availability: '网页和桌面' },
  { id: 'experiment', label: '实验项目', description: '围绕一个可验证成果，准备文件、动手实现并检查结果。', availability: '桌面执行' },
  { id: 'practice', label: '带教实践项目', description: '模拟接手工作，分阶段澄清、判断、交付和复盘。', availability: '桌面执行' },
] as const
export type ProjectGuidanceMode = typeof PROJECT_MODE_CHOICES[number]['id']
type RecordValue = Record<string, any>

/** Only explicit labels select a lane. Subject matter such as coding is not consent to an experiment. */
export function explicitProjectGuidanceMode(text: string): ProjectGuidanceMode | undefined {
  const chosen = text.match(/我选择(?:转换为)?[「“"]?(知识学习项目|实验项目|带教实践项目)/)?.[1]
  const target = chosen || text
  const matches = [
    /知识学习|学习型任务|学习任务|学习步骤/.test(target) ? 'learning' : '',
    /实验项目|实验型项目|^(?:我(?:想|要|选择)?(?:做|选)?|做|选)?实验[。！!\s]*$/.test(target) ? 'experiment' : '',
    /带教实践|带教项目|实践项目|实习式|^(?:我(?:想|要|选择)?(?:做|选)?|做|选)?(?:带教|实践|实习)[。！!\s]*$/.test(target) ? 'practice' : '',
  ].filter(Boolean)
  return matches.length === 1 ? matches[0] as ProjectGuidanceMode : undefined
}

export function projectGuidanceChoicePrompt(mode: ProjectGuidanceMode, rawInput: string) {
  return `我选择${PROJECT_MODE_CHOICES.find(item => item.id === mode)!.label}。原始工作任务：${rawInput}`
}
export function projectGuidanceConfirmationPrompt(candidateId: string, rootHash: string) {
  return `我明确确认创建这个项目方案。请调用 learning_task_conversion__confirm_project_guidance，candidateId: ${candidateId}，expectedRootHash: ${rootHash}，confirmed: true。`
}

export function projectGuidanceObjects(messages: readonly { toolRuns?: readonly any[] }[]) {
  return messages.flatMap(message => (message.toolRuns || []).flatMap(run =>
    run.status === 'completed' && run.plugin?.pluginId === PROJECT_GUIDANCE_PLUGIN_ID
      ? (run.plugin.result?.objects || []).filter((object: any) => object.objectType === 'project_guidance') : []))
}
export function projectGuidanceConfirmation(message: string, objects: readonly RecordValue[]) {
  if (!/我明确确认创建这个项目方案/.test(message)) return undefined
  const candidateId = message.match(/candidateId:\s*([A-Za-z0-9_-]{1,100})/)?.[1]
  const rootHash = message.match(/expectedRootHash:\s*([a-f0-9]{64})/)?.[1]
  const object = objects.find(item => item.pluginId === PROJECT_GUIDANCE_PLUGIN_ID
    && item.objectType === 'project_guidance' && item.value?.status === 'ready_for_confirmation'
    && item.value?.candidate_id === candidateId && item.value?.root_hash === rootHash)
  return object && candidateId && rootHash ? { candidateId, expectedRootHash: rootHash, confirmed: true } : undefined
}

export function hasProjectGuidanceConversation(messages: readonly { toolRuns?: readonly any[] }[]) {
  for (const message of [...messages].reverse()) {
    for (const run of [...(message.toolRuns || [])].reverse()) {
      if (run.status !== 'completed' || run.plugin?.pluginId !== PROJECT_GUIDANCE_PLUGIN_ID) continue
      const object = run.plugin.result?.objects?.find((item: any) =>
        item.objectType === 'project_guidance' || /^learning_task_/.test(item.objectType))
      if (object) return object.objectType === 'project_guidance'
        && (object.value?.project_mode === 'experiment' || object.value?.project_mode === 'practice')
    }
  }
  return false
}

export function projectGuidanceDirectRequest(options: {
  activePluginIds?: readonly string[]; message: string; messages: readonly { toolRuns?: readonly any[] }[];
  referencedObjects?: readonly RecordValue[]; mode?: string
}): { name: string; arguments: RecordValue } | undefined {
  if (!options.activePluginIds?.includes(PROJECT_GUIDANCE_PLUGIN_ID) || options.mode === 'guided_learning') return undefined
  const confirmation = projectGuidanceConfirmation(options.message, projectGuidanceObjects(options.messages))
  if (confirmation) return { name: `${PROJECT_GUIDANCE_PLUGIN_ID}__confirm_project_guidance`, arguments: confirmation }
  if (/learning_task_conversion__|caseId:|\bltc_|\blti_|准备单|候选.*(?:来源|审计|审阅)|(?:解释|介绍|说明).{0,12}(?:插件|学习型任务)/.test(options.message)) return undefined
  const mode = explicitProjectGuidanceMode(options.message)
  if (mode === 'learning') return undefined
  if (hasProjectGuidanceConversation(options.messages) && !/我选择/.test(options.message)) return undefined
  const references = (options.referencedObjects || []).filter(object =>
    object.value?.category === 'task' || object.value?.data?.type === 'task' || object.value?.data?.kind === 'task')
  const rawInput = (options.message.match(/原始工作任务：([\s\S]+)/)?.[1]
    || (references.length === 1 ? references[0].label : options.message)).trim()
  if (rawInput.length < 2) return undefined
  return { name: `${PROJECT_GUIDANCE_PLUGIN_ID}__prepare_project_guidance`, arguments: { rawInput, ...(mode ? { projectMode: mode } : {}) } }
}
