import type { VisualStep } from './tooling'

export type VisualPlaybackState = {
  index: number
  playing: boolean
  answers: Record<string, string>
}

export type VisualPlaybackAction =
  | { type: 'MOVE'; target: number; steps: VisualStep[] }
  | { type: 'TICK'; steps: VisualStep[] }
  | { type: 'TOGGLE'; steps: VisualStep[] }
  | { type: 'ANSWER'; gateId: string; choiceId: string; steps: VisualStep[] }
  | { type: 'RESET' }

export function initialVisualPlaybackState(): VisualPlaybackState {
  return { index: 0, playing: false, answers: {} }
}

function hasAnswer(state: VisualPlaybackState, gateId: string) {
  return Object.prototype.hasOwnProperty.call(state.answers, gateId)
}

export function gateResolved(state: VisualPlaybackState, step: VisualStep | undefined) {
  return !step?.prediction || hasAnswer(state, step.prediction.id)
}

export function answerForGate(state: VisualPlaybackState, gateId: string | undefined) {
  return gateId && hasAnswer(state, gateId) ? state.answers[gateId] : undefined
}

export function constrainedVisualIndex(state: VisualPlaybackState, steps: VisualStep[], requested: number) {
  if (!steps.length) return 0
  const target = Math.max(0, Math.min(steps.length - 1, requested))
  if (target <= state.index) return target
  for (let index = state.index; index <= target; index += 1) {
    const prediction = steps[index]?.prediction
    if (prediction && !hasAnswer(state, prediction.id)) return index
  }
  return target
}

export function reduceVisualPlayback(state: VisualPlaybackState, action: VisualPlaybackAction): VisualPlaybackState {
  if (action.type === 'RESET') return initialVisualPlaybackState()
  if (action.type === 'ANSWER') {
    const prediction = action.steps[state.index]?.prediction
    if (prediction?.id !== action.gateId || !prediction.choices.some(choice => choice.id === action.choiceId)) {
      return { ...state, playing: false }
    }
    return { ...state, playing: false, answers: { ...state.answers, [action.gateId]: action.choiceId } }
  }
  if (!action.steps.length) return { ...state, index: 0, playing: false }
  if (action.type === 'MOVE') return { ...state, playing: false, index: constrainedVisualIndex(state, action.steps, action.target) }
  if (action.type === 'TICK') {
    if (!state.playing || !gateResolved(state, action.steps[state.index])) return { ...state, playing: false }
    const next = constrainedVisualIndex(state, action.steps, state.index + 1)
    return { ...state, index: next, playing: next < action.steps.length - 1 && gateResolved(state, action.steps[next]) }
  }
  if (!gateResolved(state, action.steps[state.index])) return { ...state, playing: false }
  if (state.playing) return { ...state, playing: false }
  if (state.index === action.steps.length - 1) return { index: 0, playing: true, answers: {} }
  return { ...state, playing: true }
}
