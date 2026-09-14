/** Entry design is a content plan. Files exist only after the scoped file API succeeds. */
export type CheckpointPreset = {
  kind: 'knowledge' | 'overview' | 'setup' | 'implementation' | 'workflow' | 'deployment' | 'review'
  lecture_focus: string; practice_focus: string; workflow_step: string
  required_files: Array<{ path: string; purpose: string }>
}
export type CheckpointEntryPreset = CheckpointPreset & {
  schema_version: 'learnflow.checkpoint-entry.v1'; configured: boolean
  overview_outline?: string; lecture_title: string; practice_title: string; file_kinds: Array<'lecture' | 'practice'>
  help_surface: 'code_paper'; desktop_guidance: boolean; needs_file_plan: boolean
}
export const CHECKPOINT_PLANNING_GUIDANCE = '学习型按知识先备循序递进，每关设计讲义与一份习题。实验型围绕最终交付按组件/接口拆出多个实现关卡；环境准备、部署、复核可单列，每个实现关卡明确若干原子文件路径及职责。实践型第一关是综述，配总纲讲义与小练习；后续每关对应一个工作流程步骤。entry_preset 是待确认设计，不能声称文件已创建；四档帮助只在代码纸内选择。'
export const checkpointPresetSchema = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'lecture_focus', 'practice_focus', 'workflow_step', 'required_files'],
  properties: {
    kind: { type: 'string', enum: ['knowledge', 'overview', 'setup', 'implementation', 'workflow', 'deployment', 'review'] },
    lecture_focus: { type: 'string', minLength: 2, maxLength: 1200 },
    practice_focus: { type: 'string', maxLength: 800 }, workflow_step: { type: 'string', maxLength: 300 },
    required_files: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
      required: ['path', 'purpose'], properties: { path: { type: 'string', minLength: 1, maxLength: 240, description: '如 src/parser.c；相对路径，不表示文件已经存在' }, purpose: { type: 'string', minLength: 2, maxLength: 600 } } } },
  },
} as const
export function parseCheckpointPreset(value: unknown, allowUnplannedFiles = false): CheckpointPreset {
  const row = value as CheckpointPreset
  const bounded = (value: unknown, min: number, max: number) => typeof value === 'string' && value.trim().length >= min && value.length <= max
  if (!row || typeof row !== 'object' || !checkpointPresetSchema.properties.kind.enum.includes(row.kind)
      || !bounded(row.lecture_focus, 2, 1200) || !bounded(row.practice_focus ?? '', 0, 800)
      || !bounded(row.workflow_step ?? '', 0, 300) || !Array.isArray(row.required_files) || row.required_files.length > 8)
    throw new Error('关卡预设无效：请提供类型、讲义重点、练习目标和待完成文件。')
  const paths = new Set<string>()
  for (const file of row.required_files) {
    if (!bounded(file?.path, 1, 240) || !bounded(file?.purpose, 2, 600) || file.path !== file.path.trim()
      || /[\\:\x00-\x1f]/.test(file.path) || file.path.split('/').some(p => ['', '.', '..', '.learnflow', '.git', '.env'].includes(p) || p.startsWith('.env.'))
      || paths.has(file.path.toLowerCase())) throw new Error('待完成文件需要唯一、安全的相对路径和具体职责。')
    paths.add(file.path.toLowerCase())
  }
  if (row.kind === 'implementation' && !row.required_files.length && !allowUnplannedFiles) throw new Error('实现关卡必须明确待完成的原子文件。')
  if (['knowledge', 'overview'].includes(row.kind) && !row.practice_focus?.trim()) throw new Error('知识与综述关卡必须有习题或小练习目标。')
  if (row.kind === 'workflow' && !row.workflow_step?.trim()) throw new Error('实践关卡必须对应明确的工作流程步骤。')
  return { kind: row.kind, lecture_focus: row.lecture_focus, practice_focus: row.practice_focus || '', workflow_step: row.workflow_step || '',
    required_files: row.required_files.map(file => ({ path: file.path, purpose: file.purpose })) }
}
