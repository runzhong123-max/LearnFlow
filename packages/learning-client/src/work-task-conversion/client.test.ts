import test from 'node:test'
import assert from 'node:assert/strict'
import { conversionClient, conversionIdFromSearch, learningDestination, safeResourceUrl } from './client.ts'

test('conversion resume and outgoing links reject untrusted paths and credentials', () => {
  assert.equal(conversionIdFromSearch('?conversion=wc_abc'), 'wc_abc')
  assert.equal(conversionIdFromSearch('?conversion=../../admin'), '')
  assert.equal(safeResourceUrl('javascript:alert(1)'), '')
  assert.equal(safeResourceUrl('https://secret@example.org/x'), '')
  assert.equal(learningDestination('/projects/5', 'https://w2ltask.learnflow.club'), 'https://learn.learnflow.club/projects/5')
  assert.throws(() => learningDestination('https://elsewhere.example/projects/5', 'https://w2ltask.learnflow.club'))
  assert.throws(() => learningDestination('/logout', 'https://w2ltask.learnflow.club'))
})
test('client preserves the exact confirmed version and returns actionable server errors', async () => {
  const body = {expected_root_hash:'a'.repeat(64), confirmed:true, client_action_id:'stable-action'}
  let observed: any
  const request = conversionClient((async (_url, init) => {
    observed = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({detail:{code:'stale',message:'候选已更新'}}), {status:409})
  }) as typeof fetch)
  await assert.rejects(request('/wc_1/generate', body), /候选已更新/)
  assert.deepEqual(observed, body)
})

import { generationRetryIdentity } from './client.ts'
test('each terminal generation failure permits another attempt without changing transport retry identity',()=>{
 const first={generation:{id:'gen_1',status:'failed'}}
 const second={generation:{id:'gen_2',status:'failed'}}
 assert.equal(generationRetryIdentity(first),generationRetryIdentity(first))
 assert.notEqual(generationRetryIdentity(first),generationRetryIdentity(second))
})
