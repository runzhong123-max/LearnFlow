export const TEACHING_AFFORDANCES_VERSION = 'learnflow-teaching-affordances/v1'
export type TeachingAffordances = {
  version: string
  sourceText: string
  followUps: string[]
  highlights: { quote: string }[]
}

/** Treat persisted and model-authored metadata as untrusted, tied to exact text. */
export function teachingAffordances(raw: unknown, content: string): TeachingAffordances | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<TeachingAffordances>
  if (value.version !== TEACHING_AFFORDANCES_VERSION || value.sourceText !== content) return undefined
  const questions = Array.isArray(value.followUps) ? value.followUps : []
  const validQuestions = questions.length === 3 && questions.every(q => typeof q === 'string' && q.trim().length >= 4 && q.length <= 60 && !q.includes('\n'))
    && new Set(questions.map(q => q.trim().replace(/[？?。\s]+$/u, ''))).size === 3
  const highlights: { quote: string }[] = []
  const ranges: [number, number][] = []
  for (const item of Array.isArray(value.highlights) ? value.highlights.slice(0, 12) : []) {
    const quote = item?.quote
    if (typeof quote !== 'string' || quote.length < 2 || quote.length > 100 || /[\n`$<>\[\]]/.test(quote)) continue
    const start = content.indexOf(quote)
    if (start < 0 || content.indexOf(quote, start + 1) >= 0) continue
    const end = start + quote.length
    if (ranges.some(([a, b]) => start < b && end > a)) continue
    ranges.push([start, end])
    highlights.push({ quote })
    if (highlights.length === 3) break
  }
  return { version: TEACHING_AFFORDANCES_VERSION, sourceText: content, followUps: validQuestions ? questions.map(q => q.trim()) : [], highlights }
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: Record<string, unknown> }
const protectedNodes = new Set(['link', 'linkReference', 'image', 'imageReference', 'code', 'inlineCode', 'math', 'inlineMath', 'html'])

/** Only transform Markdown text nodes; never HTML, code, math or existing links. */
export function remarkTeachingHighlights(options: { quotes: string[] }) {
  return (tree: MarkdownNode) => {
    const remaining = new Set(options.quotes)
    const visit = (node: MarkdownNode) => {
      if (protectedNodes.has(node.type) || !node.children) return
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child] }
        const text = child.value
        const matches = [...remaining].map(quote => ({ quote, start: text.indexOf(quote) })).filter(item => item.start >= 0).sort((a, b) => a.start - b.start)
        const nodes: MarkdownNode[] = []
        let cursor = 0
        for (const { quote, start } of matches) {
          if (start < cursor) continue
          if (start > cursor) nodes.push({ type: 'text', value: text.slice(cursor, start) })
          nodes.push({ type: 'teachingHighlight', data: { hName: 'span', hProperties: { 'data-teaching-quote': quote } }, children: [{ type: 'text', value: quote }] })
          remaining.delete(quote)
          cursor = start + quote.length
        }
        if (cursor === 0) return [child]
        if (cursor < text.length) nodes.push({ type: 'text', value: text.slice(cursor) })
        return nodes
      })
    }
    visit(tree)
  }
}

export function existingQuoteSheet<T extends { sourceMessageId: string; parentSheetId: string; quote: string }>(sheets: T[], sourceMessageId: string, parentSheetId: string, quote: string): T | undefined {
  return sheets.find(sheet => sheet.sourceMessageId === sourceMessageId && sheet.parentSheetId === parentSheetId && sheet.quote === quote)
}
