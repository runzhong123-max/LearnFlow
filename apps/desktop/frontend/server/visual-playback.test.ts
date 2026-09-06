import assert from 'node:assert/strict'
import test from 'node:test'
import type { VisualStep } from '../src/tooling.ts'
import { initialVisualPlaybackState, reduceVisualPlayback } from '../src/visual-playback.ts'

const steps: VisualStep[] = [
  { title: '初始', text: '', svg: '<svg></svg>' },
  {
    title: '预测', text: '', svg: '<svg></svg>',
    prediction: {
      id: 'gate_next', prompt: '下一步是什么？',
      choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      correctChoiceId: 'b', explanation: '先完成微任务。',
    },
  },
  { title: '揭晓', text: '', svg: '<svg></svg>' },
]

test('prediction gates block next, End, slider and automatic playback until answered', () => {
  let state = initialVisualPlaybackState()
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 2, steps })
  assert.equal(state.index, 1)
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 2, steps })
  assert.equal(state.index, 1)
  state = reduceVisualPlayback(state, { type: 'TOGGLE', steps })
  assert.equal(state.playing, false)
  state = { ...state, playing: true }
  state = reduceVisualPlayback(state, { type: 'TICK', steps })
  assert.deepEqual({ index: state.index, playing: state.playing }, { index: 1, playing: false })

  state = reduceVisualPlayback(state, { type: 'ANSWER', gateId: 'gate_next', choiceId: 'a', steps })
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 2, steps })
  assert.equal(state.index, 2)
})

test('replay resets both position and resolved prediction gates', () => {
  let state = initialVisualPlaybackState()
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 1, steps })
  state = reduceVisualPlayback(state, { type: 'ANSWER', gateId: 'gate_next', choiceId: 'b', steps })
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 2, steps })
  state = reduceVisualPlayback(state, { type: 'TOGGLE', steps })
  assert.deepEqual(state, { index: 0, playing: true, answers: {} })
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 2, steps })
  assert.equal(state.index, 1)
})

test('prototype property gate IDs and forged answers cannot bypass a prediction', () => {
  const hostile: VisualStep[] = [
    {
      title: '预测', text: '', svg: '<svg></svg>',
      prediction: {
        id: 'constructor', prompt: '继续吗？',
        choices: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }],
        correctChoiceId: 'yes', explanation: '说明。',
      },
    },
    { title: '揭晓', text: '', svg: '<svg></svg>' },
  ]
  let state = initialVisualPlaybackState()
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 1, steps: hostile })
  assert.equal(state.index, 0)
  state = reduceVisualPlayback(state, { type: 'ANSWER', gateId: 'constructor', choiceId: 'forged', steps: hostile })
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 1, steps: hostile })
  assert.equal(state.index, 0)
  state = reduceVisualPlayback(state, { type: 'ANSWER', gateId: 'constructor', choiceId: 'yes', steps: hostile })
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 1, steps: hostile })
  assert.equal(state.index, 1)
})

test('explicit replay clears resolved prediction gates for reduced-motion users too', () => {
  let state = initialVisualPlaybackState()
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 1, steps })
  state = reduceVisualPlayback(state, { type: 'ANSWER', gateId: 'gate_next', choiceId: 'b', steps })
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 2, steps })
  state = reduceVisualPlayback(state, { type: 'RESET' })
  assert.deepEqual(state, initialVisualPlaybackState())
  state = reduceVisualPlayback(state, { type: 'MOVE', target: 2, steps })
  assert.equal(state.index, 1)
})
