/** Immutable content selectors. A selector is a routing hint, never an access grant. */
export type RolePackageRef = { packageId: string; packageVersion: string; snapshotId: string; rootHash: string }
export const referenceKeys = ['packageId', 'packageVersion', 'snapshotId', 'rootHash'] as const
export function checkedRolePackageRef(value: unknown): RolePackageRef {
  const ref = value as RolePackageRef | undefined
  if (!ref || !referenceKeys.every(key => typeof ref[key] === 'string' && ref[key].trim() && ref[key].length <= 256)
    || !/^[a-f0-9]{64}$/.test(ref.rootHash)) throw new Error('role_package_reference_incomplete:请重新选择带完整版本与内容哈希的岗位包')
  return Object.fromEntries(referenceKeys.map(key => [key, ref[key]])) as RolePackageRef
}
export function sameRolePackageRef(a: RolePackageRef, b: RolePackageRef) { return referenceKeys.every(key => a[key] === b[key]) }
export type RolePackageHost = { resolve(reference: RolePackageRef): Promise<unknown> }

export type RolePackageSelection = RolePackageRef | { unresolved: true }

type Message = { toolRuns?: Array<{ status?: string; plugin?: { pluginId: string; toolId?: string; result: { payload?: unknown } } }> }
export function latestRolePackageReference(messages: Message[]): RolePackageSelection | undefined {
  let selected: RolePackageSelection | undefined
  for (const message of messages) for (const run of message.toolRuns || []) {
    if (run.status === 'failed' || run.plugin?.pluginId !== 'role_capability_graph'
      || run.plugin.toolId !== 'reference_role_package') continue
    const payload = run.plugin.result.payload as { requiredSelector?: unknown; descriptor?: unknown; reference?: unknown } | undefined
    try {
      // Older launch messages omitted rootHash in requiredSelector; descriptor kept it.
      selected = checkedRolePackageRef({ ...(payload?.reference as object), ...(payload?.descriptor as object), ...(payload?.requiredSelector as object) })
    } catch { selected = { unresolved: true } }
  }
  return selected
}
export function inheritRolePackageReference<T extends Record<string, unknown>>(toolId: string, args: T, selected?: RolePackageSelection): T {
  if (!selected || ['reference_role_package', 'list_role_packages', 'search_graph_hub', 'compare_role_packages'].includes(toolId)) return args
  if ('unresolved' in selected) throw new Error('role_package_reference_incomplete:历史引用缺少固定版本身份，请重新选择岗位包')
  if (referenceKeys.some(key => args[key] !== undefined && args[key] !== selected[key])) {
    throw new Error('role_package_reference_conflict:当前对话已固定另一版本；切换前请明确引用目标岗位包')
  }
  return { ...selected, ...args }
}
export function rolePackageToolArguments<T extends Record<string, unknown>>(pluginId: string, toolId: string, args: T, selected?: RolePackageSelection): T {
  return pluginId === 'role_capability_graph' ? inheritRolePackageReference(toolId, args, selected) : args
}
