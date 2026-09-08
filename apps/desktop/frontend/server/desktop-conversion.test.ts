import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { conversionTicketFromUrl, importActionId, validateConversionPreview } from '../src/desktop-conversion.ts'
const ticket = 'a'.repeat(43)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function preview() {
  const file = { path: 'data/input.csv', content: 'name\n工单\n', sha256: hash('name\n工单\n') }
  return { schema_version: 'learnflow.work-task-conversion.v1', id: 3, learner_id: 7, root_hash: 'b'.repeat(64), candidate: { candidate_id: 'first', root_hash: 'c'.repeat(64), title: '导入实验', summary: '观察重复数据', project_mode: 'experiment' }, starter_files: [file], starter_manifest_hash: hash(JSON.stringify([{ path: file.path, sha256: file.sha256, size: Buffer.byteLength(file.content) }])), expires_at: new Date(Date.now() + 900_000).toISOString(), consumed: false }
}
test('only accepts a single opaque conversion ticket without redirects', () => {
  assert.equal(conversionTicketFromUrl(`learnflow://conversion?ticket=${ticket}`), ticket)
  for (const url of [`https://conversion?ticket=${ticket}`, `learnflow://conversion?ticket=${ticket}&ticket=${ticket}`, `learnflow://user@conversion?ticket=${ticket}`, `learnflow://conversion?ticket=${ticket}#fragment`, `learnflow://conversion?ticket=${ticket}&redirect=https://example`, 'learnflow://conversion?ticket=short']) assert.equal(conversionTicketFromUrl(url), undefined)
})
test('login resume revalidates learner and uses stable account-scoped secret-free request ID', async () => {
  const data = preview()
  assert.equal((await validateConversionPreview(data, 7)).learner_id, 7)
  await assert.rejects(validateConversionPreview(data, 8), /账号/)
  const first = await importActionId(ticket, 7)
  assert.equal(first, await importActionId(ticket, 7))
  assert.notEqual(first, await importActionId(ticket, 8))
  assert.ok(!first.includes(ticket))
})
test('preview rejects tampering, unsupported contracts, and expired unconsumed tickets', async () => {
  const data = preview(); data.starter_files[0].content += 'tampered'
  await assert.rejects(validateConversionPreview(data, 7), /校验失败/)
  await assert.rejects(validateConversionPreview({ ...preview(), starter_manifest_hash: 'd'.repeat(64) }, 7), /清单已变化/)
  await assert.rejects(validateConversionPreview({ ...preview(), schema_version: 'v99' }, 7), /更新版本/)
  await assert.rejects(validateConversionPreview({ ...preview(), expires_at: '2000-01-01T00:00:00Z' }, 7), /已过期/)
})
