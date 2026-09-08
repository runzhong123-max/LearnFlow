import assert from 'node:assert/strict'
import test from 'node:test'
import { safeReturnTo, loginDestination, returnToFromSearch } from '../src/site-auth.ts'
test('central login preserves trusted page and query without open redirects', () => {
  const target = 'https://roles.learnflow.club/projects/12?tab=graph&focus=a#node'
  assert.equal(new URL(loginDestination(target)).searchParams.get('return_to'), target)
  for (const value of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)', 'https://learnflow.club.evil.example/', 'https://user@learnflow.club/', 'https://learn.learnflow.club/login', 'https://learnflow.club:8443/']) {
    assert.equal(safeReturnTo(value), 'https://learnflow.club/')
  }
})

test('proxy return URI preserves query parameters', () => {
  const target = 'https://graphs.learnflow.club/hub?q=a&view=grid'
  assert.equal(safeReturnTo(returnToFromSearch('?return_to=' + target)), target)
  assert.equal(safeReturnTo(returnToFromSearch('?return_to=' + encodeURIComponent(target))), target)
})
