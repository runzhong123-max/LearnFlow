/** Merge a delayed disk refresh against the latest editor state, preserving new drafts. */
export function mergeWorkspaceRefresh<T extends { path: string; content: string | null; sha256: string; draft: string; conflict?: boolean }>(
  current: T[], disk: Array<Omit<T, 'draft' | 'conflict'> | undefined>,
): T[] {
  const latest = new Map(disk.filter(item => !!item).map(item => [item.path, item]))
  return current.map(file => {
    const saved = latest.get(file.path)
    if (!saved) return { ...file, conflict: true }
    if (file.draft !== file.content) return { ...file, conflict: file.conflict || saved.sha256 !== file.sha256 }
    return { ...saved, draft: saved.content || '' } as T
  })
}
