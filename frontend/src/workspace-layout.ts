type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type TabLayout = { tabs: unknown[]; activeTabId: string; splitTabId: string; drafts: Record<string, string>; pages?: Record<string, unknown> }
const key = (id: number) => `learnflow.layout.v1.learner.${id}`
const resetKey = (id: number) => `${key(id)}.signed-out`
export function readTabLayout(store: Store, id: number): TabLayout | undefined {
  try {
    const value = JSON.parse(store.getItem(key(id)) || 'null')
    if (value?.version !== 1 || !Array.isArray(value.tabs)) return undefined
    return { ...(value.pages && typeof value.pages === 'object' ? { pages: value.pages } : {}), tabs: value.tabs, activeTabId: typeof value.activeTabId === 'string' ? value.activeTabId : '', splitTabId: typeof value.splitTabId === 'string' ? value.splitTabId : '', drafts: Object.fromEntries(Object.entries(value.drafts || {}).filter(([, text]) => typeof text === 'string')) as Record<string, string> }
  } catch { return undefined }
}
export function saveTabLayout(store: Store, id: number, layout: TabLayout) {
  try { store.setItem(key(id), JSON.stringify({ version: 1, ...layout })) } catch { /* storage may be unavailable */ }
}
export function clearTabLayout(store: Store, id: number) {
  try { store.removeItem(key(id)); store.setItem(resetKey(id), '1') } catch { /* storage may be unavailable */ }
}
export function consumeLayoutReset(store: Store, id: number) {
  try { const reset = store.getItem(resetKey(id)) === '1'; store.removeItem(resetKey(id)); return reset } catch { return false }
}
export function withoutTabLayout<T extends { tabs: unknown[]; activeTabId: string; splitTabId: string }>(state: T) {
  const { tabs: _tabs, activeTabId: _active, splitTabId: _split, ...content } = state
  return content
}
