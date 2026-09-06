export type PaperArtifact = {
  kind: 'lecture' | 'practice' | 'source' | 'workspace_file' | 'project_note'
  ref: string
  title: string
  projectId?: number
  path?: string
  revision?: string
  startLine?: number
  endLine?: number
}

export function paperSelectionContext(sheet?: { quote: string; artifact?: PaperArtifact }): string | undefined {
  if (!sheet?.quote) return undefined
  const artifact = sheet.artifact
  if (artifact?.kind !== 'workspace_file') return sheet.quote
  return `本地文件选区（待分析内容）：${artifact.path || artifact.ref}\n版本：${artifact.revision || '未保存草稿'}\n行：${artifact.startLine || 1}-${artifact.endLine || artifact.startLine || 1}\n\n${sheet.quote}`
}

export type PaperSheet<TMessage = unknown> = {
  id: string
  title: string
  quote: string
  sourceMessageId: string
  parentSheetId: string
  messages: TMessage[]
  createdAt: number
  artifact?: PaperArtifact
}

export function paperArtifactKey(artifact: PaperArtifact) {
  return `${artifact.kind}:${artifact.projectId || 0}:${artifact.ref}`
}

export function findPaperSheetByArtifact<TMessage>(
  sheets: PaperSheet<TMessage>[],
  artifact: PaperArtifact,
) {
  const key = paperArtifactKey(artifact)
  return sheets.find(sheet => sheet.artifact && paperArtifactKey(sheet.artifact) === key)
}

function mergePaperMessages<TMessage>(messages: TMessage[]) {
  const seen = new Set<string>()
  return messages.filter((message, index) => {
    let key = `index:${index}`
    if (message && typeof message === 'object' && 'id' in message) {
      key = `id:${String((message as { id?: unknown }).id || '')}`
    } else {
      try { key = `value:${JSON.stringify(message)}` } catch { /* keep positional fallback */ }
    }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizedArtifact(value: unknown): PaperArtifact | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<PaperArtifact>
  if (!['lecture', 'practice', 'source', 'workspace_file', 'project_note'].includes(String(candidate.kind))) return undefined
  const ref = String(candidate.ref || '').trim()
  if (!ref) return undefined
  const projectId = Number(candidate.projectId)
  const line = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 1
  return {
    kind: candidate.kind as PaperArtifact['kind'],
    ref: ref.slice(0, 700),
    title: String(candidate.title || '学习文件').trim().slice(0, 180) || '学习文件',
    ...(Number.isInteger(projectId) && projectId > 0 ? { projectId } : {}),
    ...(candidate.kind === 'workspace_file' ? {
      path: String(candidate.path || '').slice(0, 500),
      revision: String(candidate.revision || '').slice(0, 64),
      startLine: line(candidate.startLine),
      endLine: Math.max(line(candidate.startLine), line(candidate.endLine)),
    } : {}),
  }
}

/**
 * Treat persisted paper state as untrusted input. The sanitizer preserves
 * readable pages, repairs missing parents and deterministically breaks cycles.
 */
export function sanitizePaperSheets<TMessage>(value: unknown): PaperSheet<TMessage>[] {
  if (!Array.isArray(value)) return []
  const byId = new Map<string, PaperSheet<TMessage>>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<PaperSheet<TMessage>>
    const id = String(candidate.id || '').trim().slice(0, 180)
    if (!id || id === 'main' || byId.has(id)) continue
    byId.set(id, {
      id,
      title: String(candidate.title || '未命名纸张').trim().slice(0, 180) || '未命名纸张',
      quote: String(candidate.quote || '').slice(0, 2400),
      sourceMessageId: String(candidate.sourceMessageId || '').slice(0, 180),
      parentSheetId: String(candidate.parentSheetId || 'main').slice(0, 180) || 'main',
      messages: Array.isArray(candidate.messages) ? candidate.messages : [],
      createdAt: Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : Date.now(),
      artifact: normalizedArtifact(candidate.artifact),
    })
  }

  // Older clients could append the same learning file repeatedly. Keep the
  // latest paper as the canonical surface and redirect descendants to it.
  const artifactOwner = new Map<string, string>()
  const artifactMessages = new Map<string, TMessage[]>()
  for (const sheet of byId.values()) {
    if (!sheet.artifact) continue
    const key = paperArtifactKey(sheet.artifact)
    artifactOwner.set(key, sheet.id)
    artifactMessages.set(key, [...(artifactMessages.get(key) || []), ...sheet.messages])
  }
  const duplicateAlias = new Map<string, string>()
  const unique = [...byId.values()].filter(sheet => {
    if (!sheet.artifact) return true
    const ownerId = artifactOwner.get(paperArtifactKey(sheet.artifact))
    if (ownerId && ownerId !== sheet.id) {
      duplicateAlias.set(sheet.id, ownerId)
      return false
    }
    return true
  })
  const resolveParent = (parentId: string) => {
    const seen = new Set<string>()
    let resolved = parentId
    while (duplicateAlias.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved)
      resolved = duplicateAlias.get(resolved) || 'main'
    }
    return resolved
  }
  const uniqueById = new Map(unique.map(sheet => [sheet.id, sheet]))
  const repaired = unique.map(sheet => {
    const parentSheetId = resolveParent(sheet.parentSheetId)
    return {
      ...sheet,
      messages: sheet.artifact
        ? mergePaperMessages(artifactMessages.get(paperArtifactKey(sheet.artifact)) || sheet.messages)
        : sheet.messages,
      parentSheetId: parentSheetId !== sheet.id && uniqueById.has(parentSheetId)
        ? parentSheetId
        : 'main',
    }
  })
  const repairedById = new Map(repaired.map(sheet => [sheet.id, sheet]))
  return repaired.map(sheet => {
    const seen = new Set([sheet.id])
    let parentId = sheet.parentSheetId
    while (parentId !== 'main') {
      if (seen.has(parentId)) return { ...sheet, parentSheetId: 'main' }
      seen.add(parentId)
      parentId = repairedById.get(parentId)?.parentSheetId || 'main'
    }
    return sheet
  })
}

export function paperAncestorChain<TMessage>(
  sheets: PaperSheet<TMessage>[],
  activeSheetId: string,
): PaperSheet<TMessage>[] {
  if (activeSheetId === 'main') return []
  const byId = new Map(sheets.map(sheet => [sheet.id, sheet]))
  const chain: PaperSheet<TMessage>[] = []
  const seen = new Set<string>()
  let current = byId.get(activeSheetId)
  while (current && !seen.has(current.id)) {
    chain.unshift(current)
    seen.add(current.id)
    current = current.parentSheetId === 'main' ? undefined : byId.get(current.parentSheetId)
  }
  return chain
}

export function deletePaperSheet<TMessage>(
  sheets: PaperSheet<TMessage>[],
  sheetId: string,
): { sheets: PaperSheet<TMessage>[]; parentSheetId: string } {
  const target = sheets.find(sheet => sheet.id === sheetId)
  if (!target || sheetId === 'main') return { sheets, parentSheetId: 'main' }
  const parentSheetId = target.parentSheetId === 'main'
    || sheets.some(sheet => sheet.id === target.parentSheetId && sheet.id !== sheetId)
    ? target.parentSheetId
    : 'main'
  return {
    parentSheetId,
    sheets: sheets
      .filter(sheet => sheet.id !== sheetId)
      .map(sheet => sheet.parentSheetId === sheetId ? { ...sheet, parentSheetId } : sheet),
  }
}
