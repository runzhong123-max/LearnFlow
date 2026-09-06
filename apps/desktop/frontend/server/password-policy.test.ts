import assert from 'node:assert/strict'
import test from 'node:test'

import { PASSWORD_POLICY_MESSAGE, passwordPolicyError } from '../src/password-policy.ts'

test('password policy accepts eight characters with at least two categories', () => {
  assert.equal(passwordPolicyError('abcdefg1'), '')
  assert.equal(passwordPolicyError('ABCDEFG!'), '')
  assert.equal(passwordPolicyError('Abcdefgh'), '')
})

test('password policy rejects short or single-category passwords', () => {
  assert.equal(passwordPolicyError('Abc123!'), PASSWORD_POLICY_MESSAGE)
  assert.equal(passwordPolicyError('abcdefgh'), PASSWORD_POLICY_MESSAGE)
  assert.equal(passwordPolicyError('correct horse battery staple'), PASSWORD_POLICY_MESSAGE)
})
