import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('restoring an ecosystem tab cannot navigate the whole application', () => {
  const source = readFileSync(new URL('../src/EcosystemPage.tsx', import.meta.url), 'utf8')
  const landing = source.split('export default function GraphHubRedirect() {')[1].split('export function EcosystemPage()')[0]
  assert.doesNotMatch(landing, /useEffect|window\.location/)
  assert.match(landing, /href="https:\/\/graphs\.learnflow\.club\/hub"/)
  assert.match(landing, /target="_blank"/)
})
