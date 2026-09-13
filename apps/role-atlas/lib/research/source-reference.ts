/** Repair only a uniquely identifiable verbatim quote within the supplied source slice. */
export function resolveSourceSpan<T extends { segmentId: string; quote: string }>(span: T, segments: Array<{ id: string; text: string }>): T | undefined {
  if (!span.quote.trim()) return undefined;
  if (segments.some(segment => segment.id === span.segmentId && segment.text.includes(span.quote))) return span;
  const matches = segments.filter(segment => segment.text.includes(span.quote));
  return matches.length === 1 ? { ...span, segmentId: matches[0].id } : undefined;
}
