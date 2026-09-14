export const AI_CONTENT_NOTICE = '含 AI 生成内容，请结合来源核对。'

/** Export an already validated SVG with a separate, visible footer. */
export function svgWithAiNotice(svg: string): string {
  const box = svg.match(/<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number)
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error('图解尺寸无效，无法导出。')
  const width = Math.max(320, box[2]), height = box[3]
  // SVG remains in an image document, preserving the preview's script isolation.
  const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 32}" viewBox="0 0 ${width} ${height + 32}"><rect width="100%" height="100%" fill="white"/><image href="${source}" width="${box[2]}" height="${height}"/><text x="12" y="${height + 21}" font-family="sans-serif" font-size="12" fill="#66736b">${AI_CONTENT_NOTICE}</text></svg>`
}
