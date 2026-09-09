import assert from 'node:assert/strict'
import test from 'node:test'
import { ecosystemEntryPath, exactEntryNodeId, readEcosystemEntry } from '../src/ecosystem-entry.ts'

const ref = { packageId: 'role:private/name', packageVersion: '1.0.0-candidate.test', snapshotId: 'snapshot:role@2026-09-07:abc', rootHash: 'a'.repeat(64) }
const params = () => new URLSearchParams({ ...ref, nodeId: 'skill:SQL+查询' })

test('exact package and node survive workspace URL normalization without carrying credentials', () => {
  const query = params(); query.set('token', 'must-not-persist'); query.set('owner', 'another-learner')
  const path = ecosystemEntryPath(`?${query}`)
  assert.ok(path.startsWith('/ecosystem?'))
  assert.equal(path.includes('token'), false); assert.equal(path.includes('owner'), false)
  assert.deepEqual(readEcosystemEntry(path.slice(path.indexOf('?'))), { packageRef: ref, nodeId: 'skill:SQL+查询' })
})

test('partial or duplicated immutable identity is rejected rather than searching a replacement', () => {
  assert.equal(readEcosystemEntry('?q=软件实施'), undefined)
  for (const key of Object.keys(ref)) { const q = params(); q.delete(key); assert.throws(() => readEcosystemEntry(`?${q}`)) }
  const duplicate = params(); duplicate.append('rootHash', 'b'.repeat(64))
  assert.throws(() => readEcosystemEntry(`?${duplicate}`), /重复参数/)
  assert.throws(() => readEcosystemEntry('?nodeId=skill:one'))
})

test('missing pinned node never opens another node of the package', () => {
  const entry = readEcosystemEntry(`?${params()}`)!
  assert.equal(exactEntryNodeId(entry, [{ id: 'role:root' }, { id: entry.nodeId! }]), entry.nodeId)
  assert.throws(() => exactEntryNodeId(entry, [{ id: 'role:root' }]), /指定节点不在/)
  assert.equal(exactEntryNodeId({ packageRef: ref }, [{ id: 'role:root' }]), 'role:root')
})
