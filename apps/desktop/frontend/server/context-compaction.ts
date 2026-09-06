export function structurallyCompact(value: unknown, depth = 0, tight = false): unknown {
  if (typeof value === 'string') {
    const max = tight ? 320 : 1600
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= (tight ? 4 : 7)) return { omitted: true, reason: 'depth_budget' }
  if (Array.isArray(value)) {
    const max = tight ? 8 : 24
    const items = value.slice(0, max).map(item => structurallyCompact(item, depth + 1, tight))
    return value.length > max ? [...items, { omittedItems: value.length - max }] : items
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const max = tight ? 24 : 60
  const result = Object.fromEntries(entries.slice(0, max).map(([key, item]) => [
    key,
    structurallyCompact(item, depth + 1, tight),
  ]))
  if (entries.length > max) result.__omittedFields = entries.length - max
  return result
}
