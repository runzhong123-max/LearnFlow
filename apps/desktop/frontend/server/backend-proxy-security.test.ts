import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBackendProxyHeaders } from './backend-proxy-security.ts'

test('formal backend proxy preserves the browser authentication protocol', () => {
  const headers = buildBackendProxyHeaders({
    cookie: 'learnflow_session=session-token',
    authorization: 'Bearer desktop-token',
    origin: 'http://127.0.0.1:4174',
    referer: 'http://127.0.0.1:4174/chat/1',
    'sec-fetch-site': 'same-origin',
    'x-csrf-token': 'csrf-token',
    'x-learnflow-desktop-token': 'desktop-bridge',
    'x-forwarded-for': '203.0.113.8',
    connection: 'keep-alive',
  }, {
    bodyPresent: true,
    multipart: false,
    contentType: 'application/json',
  })

  assert.deepEqual(headers, {
    'Content-Type': 'application/json',
    Cookie: 'learnflow_session=session-token',
    Authorization: 'Bearer desktop-token',
    Origin: 'http://127.0.0.1:4174',
    Referer: 'http://127.0.0.1:4174/chat/1',
    'Sec-Fetch-Site': 'same-origin',
    'X-CSRF-Token': 'csrf-token',
    'X-LearnFlow-Desktop-Token': 'desktop-bridge',
  })
  assert.equal('X-Forwarded-For' in headers, false)
  assert.equal('Connection' in headers, false)
})

test('formal backend proxy keeps multipart content type and omits empty headers', () => {
  assert.deepEqual(buildBackendProxyHeaders({
    cookie: '',
    origin: undefined,
  }, {
    bodyPresent: true,
    multipart: true,
    contentType: 'multipart/form-data; boundary=learnflow',
  }), {
    'Content-Type': 'multipart/form-data; boundary=learnflow',
  })
})
