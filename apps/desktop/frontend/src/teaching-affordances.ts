import { teachingAffordances as validate } from '../../../../packages/learning-client/src/teaching/affordances.ts'

export function teachingAffordances(raw: unknown, content: string) {
  return validate(raw, content)
}
