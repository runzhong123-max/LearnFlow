export type ToolCapabilitySummary = {
  id: string
  label: string
  purpose: string
  glyph: string
  status: string
  source: 'core' | 'plugin'
}

export type InstalledPluginCapability = {
  pluginId: string
  name?: string
  description?: string
  icon?: string
}

export const CORE_TOOL_CAPABILITIES: readonly ToolCapabilitySummary[] = Object.freeze([
  {
    id: 'learning-context',
    label: '学习状态与工作区',
    purpose: '理解当前任务、项目、复习证据和有作用域的学习状态。',
    glyph: '态',
    status: '自动按需',
    source: 'core',
  },
  {
    id: 'sources-and-files',
    label: '资料与学习文件',
    purpose: '读取对话或项目资料、当前纸张，以及答案安全的讲义和练习。',
    glyph: '文',
    status: '有资料时',
    source: 'core',
  },
  {
    id: 'paths-and-projects',
    label: '路线与项目规划',
    purpose: '定位学习路径、检查项目关卡，并形成需要确认的路线或文件提案。',
    glyph: '路',
    status: '规划与项目态',
    source: 'core',
  },
  {
    id: 'web-research',
    label: '联网研究与视频',
    purpose: '搜索并核验网页或学习视频证据，用来源支撑时效性和研究型回答。',
    glyph: '研',
    status: '需要外部证据时',
    source: 'core',
  },
  {
    id: 'practice-and-assessment',
    label: '练习与质量检查',
    purpose: '设计评估蓝图、生成练习与变式，并检查题目质量。',
    glyph: '练',
    status: '带领学习时',
    source: 'core',
  },
  {
    id: 'visual-explanation',
    label: '图解与动画',
    purpose: '把已形成的教学讲解转换为可检查的静态图解或分步动画。',
    glyph: '视',
    status: '明确请求时',
    source: 'core',
  },
] satisfies ToolCapabilitySummary[])

export function visibleToolCapabilities(
  activePluginIds: readonly string[],
  installedPlugins: readonly InstalledPluginCapability[],
): ToolCapabilitySummary[] {
  const active = new Set(activePluginIds)
  const pluginCapabilities = installedPlugins
    .filter(plugin => active.has(plugin.pluginId))
    .map(plugin => ({
      id: `plugin:${plugin.pluginId}`,
      label: plugin.name || plugin.pluginId,
      purpose: plugin.description || '为当前对话提供已声明的插件功能。',
      glyph: plugin.icon || '插',
      status: '插件已启用',
      source: 'plugin' as const,
    }))
  return [...CORE_TOOL_CAPABILITIES.map(item => ({ ...item })), ...pluginCapabilities]
}
