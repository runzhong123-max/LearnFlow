import assert from 'node:assert/strict'
import test from 'node:test'
import { usesLocalDesktopRuntime } from '../src/runtime-surface.ts'

test('remote platform webviews use cloud web auth, never local IPC', () => {
  assert.equal(usesLocalDesktopRuntime(true, 'https:', 'learn.example.com'), false)
  assert.equal(usesLocalDesktopRuntime(true, 'https:', 'localhost'), false)
  assert.equal(usesLocalDesktopRuntime(true, 'http:', 'untrusted.example'), false)
  assert.equal(usesLocalDesktopRuntime(false, 'http:', 'localhost'), false)
  assert.equal(usesLocalDesktopRuntime(true, 'tauri:', 'localhost'), true)
  assert.equal(usesLocalDesktopRuntime(true, 'http:', 'tauri.localhost'), true)
  assert.equal(usesLocalDesktopRuntime(true, 'https:', 'tauri.localhost'), true)
  assert.equal(usesLocalDesktopRuntime(true, 'http:', '127.0.0.1'), true)
})
