import type { FormalLearningFileRef, FormalLearningTask } from './formal-runtime'

export type ProjectMode = 'learning' | 'experiment' | 'practice'

export type ProjectBrief = { deliverables: string[]; constraints: string[]; success_criteria: string[] }

export type ProjectCheckpointProposal = {
  id?: number
  key: string
  title: string
  objective: string
  prerequisites: string[]
  success_criteria: string[]
  estimated_minutes: number
}

export type ProjectRoadmapProposal = {
  schema_version: 'vnext.project-roadmap-proposal.v1' | 'vnext.project-roadmap-revision-proposal.v1'
  operation: 'create' | 'revise'
  project_id: number
  project_theme: string
  rationale: string
  checkpoints: ProjectCheckpointProposal[]
  expected_revision?: number
  confirmation_required: true
}

export type ProjectLearningFileProposal = {
  schema_version: 'vnext.project-file-proposal.v1' | 'vnext.learning-file-proposal.v2'
  project_id?: number
  checkpoint_id?: number
  learning_task_id: number
  checkpoint_title: string
  file_kinds: Array<'lecture' | 'practice'>
  source_strategy: 'project_sources_first' | 'task_sources_first'
  confirmation_required: true
  mastery_unchanged: true
}

export type FormalProjectCheckpoint = {
  id: number
  key: string
  title: string
  objective: string
  order: number
  prerequisites: number[]
  learning_status: string
  learning_contract: Record<string, unknown>
  editable: boolean
  session_id: number
  learning_task?: FormalLearningTask | null
}

export type FormalProjectWorkspace = {
  schema_version: 'vnext.project.v1'
  project: {
    id: number
    name: string
    objective: string
    expected_outcome: string
    user_level: string
    project_mode?: ProjectMode
    project_brief?: ProjectBrief
    created_at?: string | null
  }
  project_tutor: { session_id: number; title: string; mode: 'learning_plan' }
  roadmap: { id?: number | null; revision: number; checkpoints: FormalProjectCheckpoint[] }
  sources: Array<{
    id: number
    type: 'file' | 'url' | 'github'
    name: string
    url: string
    role: string
    status: string
    error: string
    chunk_count: number
    mastery_inference: false
    active_version?: Record<string, unknown> | null
  }>
  knowledge_baseline?: Record<string, any> | null
  files: { lectures: FormalLearningFileRef[]; practices: FormalLearningFileRef[] }
  free_sessions: Array<{ session_id: number; title: string }>
  boundaries: Record<string, boolean>
}

export type AgentProjectContext = {
  schema_version: 'vnext.project.v1'
  project: FormalProjectWorkspace['project']
  checkpoint_id?: number | null
  project_workflow?: Record<string, unknown>
  roadmap: { id?: number | null; revision: number; checkpoints: Array<Record<string, unknown>> }
  learning_tasks: FormalLearningTask[]
  sources: FormalProjectWorkspace['sources']
  learning_files: FormalProjectWorkspace['files']
  source_excerpts: Array<Record<string, unknown>>
  domain_knowledge_packet?: Record<string, unknown> | null
  learning_file_previews: Array<Record<string, unknown>>
  five_kernel_context: unknown
  tool_policy: Record<string, unknown>
}
