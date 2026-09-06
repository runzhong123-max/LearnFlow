export const VISUAL_STORYBOARD_VERSION = 'learnflow.visual-storyboard.v2' as const

export type StoryboardScalar = string | number | boolean | null

export type StoryboardEntity = {
  id: string
  label: string
  kind: 'item' | 'actor' | 'state' | 'value' | 'operator' | 'result'
  detail?: string
}

export type StoryboardRelation = {
  id: string
  from: string
  to: string
  label?: string
  kind: 'flow' | 'link' | 'membership' | 'comparison' | 'message'
}

export type StoryboardGroup = {
  id: string
  label: string
  layout: 'row' | 'column' | 'cluster'
}

export type StoryboardOperation =
  | { op: 'create_entity' | 'remove_entity'; targetId: string }
  | { op: 'connect' | 'disconnect'; relationId: string }
  | { op: 'set_property'; targetId: string; key: string; value: StoryboardScalar }
  | { op: 'set_group_members'; groupId: string; memberIds: string[] }
  | { op: 'reorder'; groupId: string; itemIds: string[] }
  | { op: 'focus'; targetIds: string[] }

export type StoryboardAssertion =
  | { type: 'visible'; targetId: string; equals: boolean }
  | { type: 'property'; targetId: string; key: string; equals: StoryboardScalar }
  | { type: 'group_members'; groupId: string; equals: string[] }
  | { type: 'order'; groupId: string; equals: string[] }

export type VisualStoryboardContext = {
  version: typeof VISUAL_STORYBOARD_VERSION
  id: string
  title: string
  learningGoal: string
  explanation: string
  entities: StoryboardEntity[]
  relations: StoryboardRelation[]
  groups: StoryboardGroup[]
  initial: {
    visibleIds: string[]
    groupMembers: Record<string, string[]>
    orders?: Record<string, string[]>
    properties?: Record<string, Record<string, StoryboardScalar>>
    focusIds?: string[]
    /** Optional Agent-authored full-state text canvas. */
    asciiCanvas?: string
    /** Explicit proof that a visible semantic object is represented in the canvas. */
    asciiAnchors?: Record<string, string>
    /** Tool appended a generic state ledger because the designed scene omitted persistent objects. */
    asciiSupplemented?: boolean
  }
  frames: Array<{
    id: string
    title: string
    narration: string
    operations: StoryboardOperation[]
    assertions: StoryboardAssertion[]
    /**
     * Agent-authored full-state text canvas after this frame's operations.
     * The Tool validates it against the replayed semantic state instead of
     * interpreting drawing commands or choosing a topic-specific layout.
     */
    asciiCanvas?: string
    asciiAnchors?: Record<string, string>
    asciiSupplemented?: boolean
  }>
  invariants: string[]
  misconceptions: string[]
  claimBoundary: string
  presentation: {
    preferredDirection: 'horizontal' | 'vertical' | 'auto'
    pacing: 'step' | 'continuous'
    preserveIdentity: true
    showGroupSummary: boolean
    asciiWidth?: number
    asciiHeight?: number
  }
  provenance: {
    source: 'authored_eval' | 'visual_teaching_skill'
    caseId?: string
  }
}
