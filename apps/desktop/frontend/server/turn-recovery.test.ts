import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTutorContextMessages,
  hasVisibleStudentMessage,
  recoverableTutorTurn,
} from '../src/turn-recovery.ts'

test('identifies a user message orphaned by reload as recoverable', () => {
  const turn = recoverableTutorTurn([
    { role: 'assistant', content: '你好' },
    { role: 'user', content: '解释一下 CNN', tutorMode: 'simple_explain' },
  ], false)

  assert.equal(turn?.content, '解释一下 CNN')
  assert.equal(turn?.tutorMode, 'simple_explain')
})

test('does not expose recovery while a turn is pending or already finished', () => {
  assert.equal(recoverableTutorTurn([{ role: 'user', content: '解释一下 CNN' }], true), undefined)
  assert.equal(recoverableTutorTurn([
    { role: 'user', content: '解释一下 CNN' },
    { role: 'assistant', content: 'CNN 是卷积神经网络。' },
  ], false), undefined)
})

test('replaying an interrupted turn does not duplicate its user message in context', () => {
  const messages = [
    { role: 'assistant' as const, content: '你好' },
    { role: 'user' as const, content: '解释一下 CNN' },
  ]

  assert.deepEqual(buildTutorContextMessages(messages, '解释一下 CNN', true), messages)
  assert.equal(buildTutorContextMessages(messages, '继续', false).at(-1)?.content, '继续')
})

test('hidden control messages never enter later Tutor model context', () => {
  const messages = [
    { role: 'assistant' as const, content: '请选择候选任务' },
    {
      role: 'user' as const,
      content: 'internal plugin invocation payload',
      hiddenFromTranscript: true,
    },
  ]

  assert.deepEqual(buildTutorContextMessages(messages, '继续', false), [
    { role: 'assistant', content: '请选择候选任务' },
    { role: 'user', content: '继续' },
  ])
  assert.deepEqual(buildTutorContextMessages(messages, 'ignored during replay', true), [
    { role: 'assistant', content: '请选择候选任务' },
  ])
  assert.equal(hasVisibleStudentMessage(messages), false)
  assert.equal(recoverableTutorTurn(messages, false), undefined)
  assert.equal(hasVisibleStudentMessage([
    ...messages,
    { role: 'user', content: '真正的学习问题' },
  ]), true)
})
