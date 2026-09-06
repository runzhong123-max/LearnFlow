export const VISUAL_TEACHING_SKILL_ID = 'visual_teaching_composition' as const
export const VISUAL_TEACHING_BRIEF_VERSION = 'learnflow.visual-teaching-brief.v1' as const

export type VisualTeachingModality = 'diagram' | 'animation'

export type VisualTeachingObject = {
  id: string
  label: string
  role: string
}

export type VisualTeachingRelation = {
  from: string
  to: string
  label: string
}

export type VisualTeachingStep = {
  id: string
  title: string
  before: string
  change: string
  after: string
  why: string
}

export type VisualTeachingBrief = {
  version: typeof VISUAL_TEACHING_BRIEF_VERSION
  topic: string
  learningGoal: string
  modality: VisualTeachingModality
  modalityRationale: string
  explanation: string
  objects: VisualTeachingObject[]
  relations: VisualTeachingRelation[]
  initialState: string
  steps: VisualTeachingStep[]
  finalState: string
  invariants: string[]
  misconceptions: string[]
  claimBoundary: string
  /** Preferred v2 path: semantic-executable input consumed directly by the Tool. */
  storyboardContext?: import('./visual-storyboard.ts').VisualStoryboardContext
}

export type VisualTeachingFailure = {
  stage: 'explanation' | 'brief' | 'planner' | 'validation' | 'layout' | 'render'
  code: string
  message: string
}

export type VisualTeachingBundle = {
  skillId: typeof VISUAL_TEACHING_SKILL_ID
  briefVersion: typeof VISUAL_TEACHING_BRIEF_VERSION
  explanation: string
  visualBrief?: VisualTeachingBrief
  requestedModality: VisualTeachingModality
  selectedModality: VisualTeachingModality | 'none'
  visualStatus: 'not_attempted' | 'rendered' | 'failed' | 'degraded'
  terminalState: 'bundle_ready' | 'explanation_only'
  explanationPreserved: true
  failure?: VisualTeachingFailure
}
