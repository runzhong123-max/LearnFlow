import type { TutorToolRun } from './tooling.ts'

const PLUGIN_ID = /^[a-z][a-z0-9_]{1,23}$/

type PluginTraceMessage = {
  toolRuns?: readonly TutorToolRun[]
}

type PluginTraceConversation = {
  messages?: readonly PluginTraceMessage[]
  sheets?: readonly { messages?: readonly PluginTraceMessage[] }[]
}

function validPluginId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_ID.test(value)
}

function pluginIdFromRun(run: TutorToolRun) {
  if (validPluginId(run.plugin?.pluginId)) return run.plugin.pluginId
  if (run.kind !== 'plugin' || typeof run.toolName !== 'string') return undefined
  const separator = run.toolName.indexOf('__')
  const candidate = separator > 0 ? run.toolName.slice(0, separator) : ''
  return validPluginId(candidate) ? candidate : undefined
}

export function normalizePluginIds(values: readonly unknown[] = []) {
  return [...new Set(values.filter(validPluginId))].slice(0, 16)
}

export function lockedConversationPluginIds(conversation: PluginTraceConversation) {
  const messages = [
    ...(conversation.messages || []),
    ...(conversation.sheets || []).flatMap(sheet => sheet.messages || []),
  ]
  return normalizePluginIds(messages.flatMap(message => (
    message.toolRuns || []
  ).flatMap(run => pluginIdFromRun(run) || [])))
}

export function stickyConversationPluginIds(
  selectedPluginIds: readonly unknown[] = [],
  lockedPluginIds: readonly unknown[] = [],
) {
  return normalizePluginIds([...selectedPluginIds, ...lockedPluginIds])
}

export function activeConversationPluginIds(conversation: PluginTraceConversation & { pluginIds?: readonly unknown[] }) {
  return stickyConversationPluginIds(conversation.pluginIds, lockedConversationPluginIds(conversation))
}
