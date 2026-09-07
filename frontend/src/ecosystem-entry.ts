import { checkedPackageRef, type RolePackageRef } from './ecosystem-client.ts'

const fields = ['packageId', 'packageVersion', 'snapshotId', 'rootHash', 'nodeId'] as const
export type EcosystemEntry = { packageRef: RolePackageRef; nodeId?: string }

/** Navigation only: package ownership and integrity are still checked by the gateway. */
export function readEcosystemEntry(search: string): EcosystemEntry | undefined {
  const params = new URLSearchParams(search)
  if (!fields.some(field => params.has(field))) return undefined
  if (fields.some(field => params.getAll(field).length > 1)) throw new Error('岗位包链接含重复参数，请从 Role Atlas 重新打开。')
  const packageRef = checkedPackageRef({ packageId: params.get('packageId') || '', packageVersion: params.get('packageVersion') || '', snapshotId: params.get('snapshotId') || '', rootHash: params.get('rootHash') || '' })
  if (packageRef.packageId.length > 256 || packageRef.packageVersion.length > 128 || packageRef.snapshotId.length > 256) throw new Error('岗位包链接超出长度限制。')
  const nodeId = params.get('nodeId')
  if (nodeId !== null && (!nodeId.trim() || nodeId.length > 256)) throw new Error('岗位节点链接无效，请重新选择节点。')
  return { packageRef, ...(nodeId ? { nodeId } : {}) }
}

/** Keep pinned navigation when the workspace router normalizes its active tab URL. */
export function ecosystemEntryPath(search: string): string {
  const params = new URLSearchParams(search), retained = new URLSearchParams()
  for (const field of fields) for (const value of params.getAll(field)) retained.append(field, value)
  return `/ecosystem${retained.size ? `?${retained}` : ''}`
}

export function exactEntryNodeId(entry: EcosystemEntry, nodes: Array<{ id: string }>): string {
  if (entry.nodeId && !nodes.some(node => node.id === entry.nodeId)) throw new Error('指定节点不在这个固定岗位包版本中；未切换到其他节点。')
  return entry.nodeId || nodes[0]?.id || ''
}
