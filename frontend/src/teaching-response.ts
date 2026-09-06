import policy from './generated/teaching-response-policy.json' with { type: 'json' }

/** Generated from the backend presentation contract; no learner state or routing. */
export const TEACHING_RESPONSE_VERSION = policy.version

export function teachingResponsePrompt(): string {
  return policy.prompt
}
