import assert from 'node:assert/strict'
import test from 'node:test'
import { safeReturnTo, loginDestination, returnToFromSearch, afterLoginDestination } from '../src/site-auth.ts'
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

test('conversion launch survives login without entering a query or unrelated destination', () => {
  const login = new URL(loginDestination('https://w2ltask.learnflow.club/convert#role_token=payload.signature'))
  assert.equal(login.searchParams.get('return_to'), 'https://w2ltask.learnflow.club/convert')
  assert.equal(login.hash, '#role_token=payload.signature')
  assert.equal(afterLoginDestination(login.searchParams.get('return_to'), login.hash), 'https://w2ltask.learnflow.club/convert#role_token=payload.signature')
  assert.equal(afterLoginDestination('https://evil.example', login.hash), 'https://learnflow.club/')
  assert.equal(afterLoginDestination('https://roles.learnflow.club/', login.hash), 'https://roles.learnflow.club/')
})
