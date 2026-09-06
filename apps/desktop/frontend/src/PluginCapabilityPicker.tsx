import { useRef } from 'react'
import { installedClientPlugins } from './PluginToolResultView.tsx'

export default function PluginCapabilityPicker({
  activePluginIds,
  lockedPluginIds = [],
  disabled,
  onChange,
}: {
  activePluginIds: readonly string[]
  lockedPluginIds?: readonly string[]
  disabled?: boolean
  onChange: (pluginIds: string[]) => void
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  if (!installedClientPlugins.length) return null
  const active = new Set(activePluginIds)
  const locked = new Set(lockedPluginIds)
  return (
    <details ref={detailsRef} className="plugin-capability-picker">
      <summary role="button" aria-label="选择对话插件">
        <span aria-hidden="true">▱</span>
        <strong>插件</strong>
        <small>{active.size ? `已启用 ${active.size}` : '未启用'}</small>
      </summary>
      <div className="plugin-capability-popover">
        <header><strong>本轮对话插件</strong><span>插件只为 Tutor 增加声明过的工具、Skill、对象和结果显示；启用后会作为一项整体功能出现在工具能力目录。</span></header>
        {installedClientPlugins.map(plugin => {
          const selected = active.has(plugin.pluginId)
          const isLocked = locked.has(plugin.pluginId)
          return (
            <button
              type="button"
              key={plugin.pluginId}
              className={selected ? 'selected' : ''}
              aria-pressed={selected}
              disabled={disabled || isLocked}
              title={isLocked ? '这个插件已经在当前对话中产生工具记录，因此会随对话保持启用。' : undefined}
              onClick={() => {
                onChange(selected
                  ? activePluginIds.filter(id => id !== plugin.pluginId)
                  : [...activePluginIds, plugin.pluginId])
                detailsRef.current?.removeAttribute('open')
              }}
            >
              <i aria-hidden="true">{plugin.icon || '◇'}</i>
              <span><strong>{plugin.name || plugin.pluginId}</strong><small>{plugin.description || plugin.pluginId}</small></span>
              <b>{isLocked ? '已使用 · 锁定' : selected ? '已启用' : '启用'}</b>
            </button>
          )
        })}
        <footer>选择只作用于当前对话；插件一旦参与该对话便保持启用，以保证历史工具、对象引用和后续追问可重放。插件结果不会直接写入五核或核心学习对象。</footer>
      </div>
    </details>
  )
}
