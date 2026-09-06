import type { ComponentType, DragEvent } from 'react'
import { PLUGIN_OBJECT_DRAG_TYPE, type LearnFlowPluginObject, type PluginToolResult } from './plugin-api.ts'
import type { TutorToolRun } from './tooling.ts'

export type PluginToolRendererProps = {
  pluginId: string
  toolId: string
  result: PluginToolResult
  objects: readonly LearnFlowPluginObject[]
  onPrompt?: (prompt: string) => void
  onReference?: (object: LearnFlowPluginObject) => void
  onOpenLearningTask?: (taskId: number) => void
}

export function writePluginObjectDragData(dataTransfer: DataTransfer, object: LearnFlowPluginObject) {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(PLUGIN_OBJECT_DRAG_TYPE, JSON.stringify(object))
  dataTransfer.setData('text/plain', object.label)
}

export function pluginObjectDragProps(object: LearnFlowPluginObject) {
  return {
    draggable: true,
    title: `拖到输入框引用“${object.label}”`,
    onDragStart: (event: DragEvent<HTMLElement>) => writePluginObjectDragData(event.dataTransfer, object),
  }
}

export type LearnFlowPluginClientPackage = {
  pluginId: string
  name?: string
  description?: string
  icon?: string
  renderers: Record<string, ComponentType<PluginToolRendererProps>>
}

type ClientPluginModule = {
  default?: LearnFlowPluginClientPackage
  plugin?: LearnFlowPluginClientPackage
}

const clientModules = import.meta.glob('../plugins/*/client.tsx', { eager: true }) as Record<string, ClientPluginModule>
const rendererRegistry = new Map<string, ComponentType<PluginToolRendererProps>>()
const installedPlugins: Array<Pick<LearnFlowPluginClientPackage, 'pluginId' | 'name' | 'description' | 'icon'>> = []

for (const [path, loaded] of Object.entries(clientModules).sort(([left], [right]) => left.localeCompare(right))) {
  const plugin = loaded.default || loaded.plugin
  if (!plugin) throw new Error(`plugin_renderer_invalid:${path} does not export default or plugin`)
  if (!/^[a-z][a-z0-9_]{1,23}$/.test(plugin.pluginId)) throw new Error(`plugin_renderer_invalid:${path} has invalid pluginId`)
  if (installedPlugins.some(item => item.pluginId === plugin.pluginId)) throw new Error(`plugin_renderer_invalid:duplicate plugin ${plugin.pluginId}`)
  installedPlugins.push({ pluginId: plugin.pluginId, name: plugin.name, description: plugin.description, icon: plugin.icon })
  for (const [rendererId, component] of Object.entries(plugin.renderers || {})) {
    const qualifiedId = `${plugin.pluginId}:${rendererId}`
    if (rendererRegistry.has(qualifiedId)) throw new Error(`plugin_renderer_invalid:duplicate ${qualifiedId}`)
    rendererRegistry.set(qualifiedId, component)
  }
}

export const installedClientPlugins = Object.freeze(installedPlugins.map(item => Object.freeze({ ...item })))

function GenericPluginObjects({ objects, onReference }: {
  objects: readonly LearnFlowPluginObject[]
  onReference?: (object: LearnFlowPluginObject) => void
}) {
  if (!objects.length) return null
  return (
    <div className="project-tool-proposal">
      {objects.map(object => (
        <details key={`${object.objectType}:${object.objectId}`} {...pluginObjectDragProps(object)}>
          <summary><strong>{object.label}</strong> <small>{object.objectType} · {object.schemaVersion}</small></summary>
          <pre>{JSON.stringify(object.value, null, 2)}</pre>
          {onReference && <button type="button" onClick={() => onReference(object)}>引用到输入框</button>}
        </details>
      ))}
    </div>
  )
}

export default function PluginToolResultView({ run, onPrompt, onReference, onOpenLearningTask, onOpenPaper }: {
  run: TutorToolRun
  onPrompt?: (prompt: string) => void
  onReference?: (object: LearnFlowPluginObject) => void
  onOpenLearningTask?: (taskId: number) => void
  onOpenPaper?: () => void
}) {
  const plugin = run.plugin
  if (!plugin) return null
  const objects = plugin.result.objects || []
  const rendererId = plugin.result.presentation?.renderer
  const Renderer = rendererId ? rendererRegistry.get(rendererId) : undefined
  return <div className="plugin-result-shell">
      <div className="plugin-result-toolbar">
        <span>插件快照</span>
        {onOpenPaper && <button type="button" onClick={onOpenPaper} aria-label="把插件结果展开到新纸" title="展开到新纸">↗</button>}
      </div>
      {Renderer ? <Renderer
        pluginId={plugin.pluginId}
        toolId={plugin.toolId}
        result={plugin.result}
        objects={objects}
        onPrompt={onPrompt}
        onReference={onReference}
        onOpenLearningTask={onOpenLearningTask}
      /> : <div aria-label={`${run.title}插件结果`}>
        <GenericPluginObjects objects={objects} onReference={onReference} />
        {plugin.result.payload !== undefined && (
        <details>
          <summary>查看结构化结果</summary>
          <pre>{JSON.stringify(plugin.result.payload, null, 2)}</pre>
        </details>
        )}
      </div>}
    </div>
}

export function defineLearnFlowPluginClient(plugin: LearnFlowPluginClientPackage) {
  return plugin
}
