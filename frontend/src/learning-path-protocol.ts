/**
 * LearnFlow-owned, product-neutral learning-path protocol.
 *
 * Compatibility v1 course graph and personal learner overlay. Typed source
 * graph, semantic bindings and shared graph extensions use the adjacent v2
 * contract; role package gaps must not be silently converted to personal nodes.
 * Learner state, confirmation and persistence remain owned by LearnFlow.
 */
export const LEARNING_PATH_PROTOCOL_VERSION = 'learnflow-learning-path/v1' as const

export type PathNodeOrigin = 'official' | 'personal'
export type PathEdgeKind = 'hard_prerequisite' | 'soft_prerequisite' | 'co_learning'
export type PathAudience = 'vocational' | 'undergraduate' | 'graduate' | 'self_directed'
export type PathStage = 'foundation' | 'core' | 'domain' | 'advanced' | 'research'

export type LearningPathSource = {
  id: string
  title: string
  institution: string
  url: string
  kind: 'framework' | 'university' | 'vocational' | 'emerging'
}

export type LearningPathNode = {
  id: string
  title: string
  summary: string
  aliases: string[]
  domains: string[]
  audiences: PathAudience[]
  stage: PathStage
  order: number
  origin: PathNodeOrigin
  sourceRefs: string[]
  sourceProposalId?: string
}

export type LearningPathEdge = {
  id: string
  from: string
  to: string
  kind: PathEdgeKind
  rationale: string
  origin: PathNodeOrigin
}

export type PersonalPathNodeEvidence = {
  url: string
  title?: string
  snippet?: string
  source?: string
  quality?: 'official' | 'academic' | 'community' | 'repository'
  role?: 'standard' | 'reference' | 'textbook' | 'course' | 'definition' | 'research' | 'example' | 'discussion'
}

export type PersonalPathNodeEvidenceAssessment = {
  url: string
  title: string
  source: string
  quality: NonNullable<PersonalPathNodeEvidence['quality']>
  relevance: number
  matchedTerms: string[]
}

export type PersonalPathNodeEvidenceReport = {
  valid: boolean
  accepted: PersonalPathNodeEvidenceAssessment[]
  rejected: Array<{ url: string; reason: 'invalid_url' | 'insufficient_metadata' | 'off_topic' | 'weak_source' }>
  policyId: 'vnext-personal-path-evidence-v1'
}

export type PersonalPathNodeProposal = {
  id: string
  policyId: 'vnext-personal-path-node-proposer-v3'
  generatedFromSnapshotId: string
  title: string
  summary: string
  aliases: string[]
  domains: string[]
  stage: PathStage
  order: number
  sourceUrls: string[]
  sourceEvidence: PersonalPathNodeEvidenceAssessment[]
  connections: Array<{ nodeId: string; kind: PathEdgeKind; rationale: string }>
  requiresLearnerConfirmation: true
  masteryUnchanged: true
}

export type LearningPathGraphContract = {
  protocolVersion: typeof LEARNING_PATH_PROTOCOL_VERSION
  nodes: LearningPathNode[]
  edges: LearningPathEdge[]
}
