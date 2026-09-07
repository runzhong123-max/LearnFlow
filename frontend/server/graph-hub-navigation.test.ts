import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('restoring an ecosystem tab keeps the interactive mounting page and opens Hub separately', () => {
  const source = readFileSync(new URL('../src/EcosystemPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /export default function EcosystemPage\(/)
  assert.doesNotMatch(source, /window\.location\s*=|window\.location\.(assign|replace)\s*\(/)
  assert.match(source, /预览此节点与学习路径的挂载/)
  assert.match(source, /应用已预览的源图变更/)
  assert.match(source, /<a href="https:\/\/graphs\.learnflow\.club\/hub" target="_blank" rel="noopener noreferrer"/)
})
