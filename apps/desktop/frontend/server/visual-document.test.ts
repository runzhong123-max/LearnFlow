import assert from 'node:assert/strict'
import test from 'node:test'
import {maintainedDocumentUrl} from '../../../../packages/learning-client/src/visuals/maintained-document.ts'
const path = '/api/visuals/document/course-security-c1-s1/1.0.0?digest=' + 'a'.repeat(64)
test('desktop documents use the credential-free local library, never the cloud account proxy', () => {
  assert.equal(maintainedDocumentUrl(path, 'http://127.0.0.1:8011/api'), 'http://127.0.0.1:8011' + path)
  assert.equal(maintainedDocumentUrl(path, 'http://localhost:8011/api/'), 'http://localhost:8011' + path)
  for (const base of ['https://remote.example/api', 'http://user:secret@127.0.0.1:8011/api', 'http://127.0.0.1:8011/cloud/api', 'http://127.0.0.1:8011/api?token=secret']) assert.equal(maintainedDocumentUrl(path, base), undefined)
})
test('only digest-pinned public document paths can become iframe navigation', () => {
  assert.equal(maintainedDocumentUrl(path), path)
  for (const input of [null, {}, 'https://remote.example/evil', '/api/visuals/workspace', path+'&token=secret', path.replace('course-security-c1-s1', '..%2fsecret'), path.replace('course-security-c1-s1', '..'), path.replace('a'.repeat(64),'bad')]) assert.equal(maintainedDocumentUrl(input), undefined)
})
