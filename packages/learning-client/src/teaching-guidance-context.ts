/** A bounded projection of server-authoritative, already scope-filtered guidance. */
export function compactTeachingGuidance(value: unknown, now = Date.now()) {
  let packet = value
  if (typeof packet === 'string') {
    try { packet = JSON.parse(packet.replace(/^正式五核 ContextPacket（只读、答案隔离）：\s*/, '')) } catch { return [] }
  }
  if (!packet || typeof packet !== 'object') return []
  const entries = (packet as Record<string, unknown>).teaching_guidance
  if (!Array.isArray(entries)) return []
  const seen = new Set<string>()
  return entries.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object') return false
    const entry = item as Record<string, unknown>
    if (entry.status !== 'active' || typeof entry.instruction !== 'string' || !entry.instruction.trim()) return false
    if (entry.expires_at) {
      const expiry = Date.parse(String(entry.expires_at))
      if (!Number.isFinite(expiry) || expiry <= now) return false
    }
    const signature = JSON.stringify([entry.kernel, entry.slot, entry.scope, entry.source_event_id, entry.instruction])
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  }).slice(0, 8).map(entry => Object.fromEntries([
    'instruction', 'kernel', 'slot', 'lifetime', 'scope', 'source_event_id', 'occurred_at',
    'expires_at', 'evidence_kind', 'status', 'priority', 'policy_version',
  ].filter(key => entry[key] !== undefined).map(key => [key, key === 'instruction' ? String(entry[key]).slice(0, 700) : entry[key]])))
}

export function teachingGuidancePrompt(packet: unknown) {
  const guidance = compactTeachingGuidance(packet)
  return guidance.length ? `本轮教学指导（正式五核当前有效状态；仅指导教学动作，不是掌握结论）：\n${JSON.stringify(guidance)}` : ''
}
