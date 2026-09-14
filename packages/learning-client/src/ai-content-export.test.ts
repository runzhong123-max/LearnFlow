import assert from 'node:assert/strict'
import test from 'node:test'
import { AI_CONTENT_NOTICE, svgWithAiNotice } from './ai-content-export.ts'

test('export reserves a visible footer without covering or executing the original SVG', () => {
  const original = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 640 480"><text x="10" y="490">bottom</text><script>alert(1)</script></svg>'
  const result = svgWithAiNotice(original)
  assert.match(result, /viewBox="0 0 640 512"/)
  assert.match(result, /y="501"/)
  assert.ok(result.includes(AI_CONTENT_NOTICE))
  const embedded = result.match(/href="data:image\/svg\+xml;charset=utf-8,([^"]+)"/)?.[1]
  assert.equal(decodeURIComponent(embedded!), original)
  assert.ok(!result.includes('<script>'))
})
test('export rejects missing and invalid dimensions instead of clipping the notice', () => {
  for (const svg of ['<svg/>', '<svg viewBox="0 0 -2 30"/>', '<svg viewBox="0 0 NaN 30"/>']) assert.throws(() => svgWithAiNotice(svg))
  assert.match(svgWithAiNotice("<svg viewBox='0,0,40,40'/>"), /viewBox="0 0 320 72"/)
})
