import type { TutorMode, TutorContextMessage } from './tutor.ts'
import type { TutorToolRun } from './tooling.ts'

export type TutorTurnMessage = {
  role: 'assistant' | 'user' | 'system'
  content: string
  tutorMode?: TutorMode
  toolRuns?: TutorToolRun[]
  reasoningContent?: string
  hiddenFromTranscript?: boolean
}

export function recoverableTutorTurn(messages: TutorTurnMessage[], pending: boolean) {
  if (pending) return undefined
  const latest = messages[messages.length - 1]
  return latest?.role === 'user' && !latest.hiddenFromTranscript && latest.content.trim() ? latest : undefined
}

export function hasVisibleStudentMessage(messages: TutorTurnMessage[]) {
  return messages.some(message => message.role === 'user' && !message.hiddenFromTranscript)
}

export function buildTutorContextMessages(
  messages: TutorTurnMessage[],
  content: string,
  replayInterruptedTurn = false,
): TutorContextMessage[] {
  const existing = messages
    .filter((message): message is TutorTurnMessage & { role: 'assistant' | 'user' } => (
      message.role !== 'system' && !message.hiddenFromTranscript
    ))
    .map(message => ({
      role: message.role,
      content: message.content,
      ...(message.toolRuns ? { toolRuns: message.toolRuns } : {}),
      ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    }))
  return replayInterruptedTurn ? existing : [...existing, { role: 'user', content }]
}
