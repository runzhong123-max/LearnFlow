import type { VisualArtifact, VisualStep } from '../../src/tooling.ts'

export const VISUAL_VERSION = 'learnflow.visual.v3' as const
export const PROMPT_VERSION = 'learnflow.visual-planner.v3' as const
export const RENDERER_VERSION = 'learnflow.deterministic-svg.v3' as const
export const ASCII_RENDERER_VERSION = 'learnflow.deterministic-ascii.v1' as const

export type LearningVisualKind = 'diagram' | 'animation'
export type LearningVisualDomain = 'computer' | 'mathematics'
export type ComputerVisualAbstraction =
  | 'protocol_sequence'
  | 'state_machine'
  | 'data_structure'
  | 'code_trace'
  | 'tensor_shape_flow'
  | 'convolution_trace'
  | 'graph_algorithm'
  | 'event_loop'
  | 'semantic_scene'
  | 'system_structure'
export type MathematicsVisualAbstraction =
  | 'function'
  | 'probability'
  | 'transformation'
  | 'derivation'
  | 'matrix_operation'
  | 'natural_frequency'
  | 'optimization'
  | 'math_structure'
export type LearningVisualAbstraction = ComputerVisualAbstraction | MathematicsVisualAbstraction

export type VisualScalar = string | number | boolean | null
export type VisualPoint = readonly [number, number]

export type ProtocolSequenceSemantic = {
  type: 'protocol_sequence'
  participants: Array<{ id: string; label: string; role?: string }>
  messages: Array<{ id: string; from: string; to: string; label: string; order: number; phase?: string }>
}

export type StateMachineSemantic = {
  type: 'state_machine'
  states: Array<{ id: string; label: string; initial?: boolean; terminal?: boolean }>
  transitions: Array<{ id: string; from: string; to: string; event: string; guard?: string }>
}

export type DataStructureSemantic = {
  type: 'data_structure'
  structure: 'array' | 'linked_list' | 'stack' | 'queue' | 'tree' | 'heap' | 'graph'
  items: Array<{ id: string; label: string; value?: VisualScalar; index?: number }>
  links: Array<{ id: string; from: string; to: string; kind: 'next' | 'left' | 'right' | 'parent' | 'contains' | 'edge' }>
  pointers: Array<{ id: string; label: string; targetId: string | null }>
}

export type CodeTraceSemantic = {
  type: 'code_trace'
  language: 'pseudocode' | 'python' | 'typescript' | 'javascript' | 'java' | 'cpp'
  lines: Array<{ id: string; number: number; text: string }>
  variables: Array<{ id: string; name: string; initialValue: VisualScalar }>
  stackFrames: Array<{ id: string; functionName: string; lineId: string }>
}

export type TensorShapeFlowSemantic = {
  type: 'tensor_shape_flow'
  tensors: Array<{ id: string; label: string; shape: number[]; dtype?: 'bool' | 'int32' | 'int64' | 'float16' | 'float32' | 'float64' }>
  operations: Array<{ id: string; label: string; inputIds: string[]; outputIds: string[] }>
}

export type ConvolutionTraceSemantic = {
  type: 'convolution_trace'
  id: string
  input: { id: string; label: string; values: number[][] }
  kernel: { id: string; label: string; values: number[][] }
  outputId: string
  stride: 1 | 2
  padding: 0
  bias: number
  activation: 'relu'
  poolSize: 2
}

export type SystemStructureSemantic = {
  type: 'system_structure'
  entities: Array<{ id: string; label: string; detail?: string; role?: 'input' | 'process' | 'state' | 'output' | 'concept' }>
  relations: Array<{ id: string; from: string; to: string; label?: string; kind: 'flow' | 'dependency' | 'transition' | 'comparison' | 'mapping' }>
}

/**
 * Topic-independent scene graph used by the visual Tool after a teaching
 * Skill has already supplied stable objects and executable state changes.
 * It deliberately contains no coordinates, SVG, CSS, or executable code.
 */
export type SemanticSceneSemantic = {
  type: 'semantic_scene'
  entities: Array<{
    id: string
    label: string
    kind: 'item' | 'actor' | 'state' | 'value' | 'operator' | 'result'
    detail?: string
  }>
  relations: Array<{
    id: string
    from: string
    to: string
    label?: string
    kind: 'flow' | 'link' | 'membership' | 'comparison' | 'message'
  }>
  groups: Array<{
    id: string
    label: string
    layout: 'row' | 'column' | 'cluster'
  }>
}

export type FunctionSemantic = {
  type: 'function'
  axes: { xLabel: string; yLabel: string; xDomain: VisualPoint; yDomain: VisualPoint }
  series: Array<{ id: string; label: string; points: VisualPoint[] }>
  parameters: Array<{ id: string; label: string; value: number }>
}

export type ProbabilitySemantic = {
  type: 'probability'
  mode: 'pmf' | 'pdf' | 'cdf'
  xLabel: string
  yLabel: string
  samples: Array<{ id: string; x: number; y: number; label?: string }>
  highlightedRange?: VisualPoint
}

export type TransformationSemantic = {
  type: 'transformation'
  space: 'number_line' | 'cartesian' | 'vector'
  objects: Array<{ id: string; label: string; points: VisualPoint[] }>
  transforms: Array<{ id: string; label: string; beforeId: string; afterId: string; kind: 'translate' | 'rotate' | 'scale' | 'reflect' | 'linear' }>
  parameters: Array<{ id: string; label: string; value: number }>
}

export type DerivationSemantic = {
  type: 'derivation'
  steps: Array<{ id: string; expression: string; relation: 'equals' | 'implies' | 'approximately' | 'definition'; reason: string; changedTerms: string[] }>
}

export type MathStructureSemantic = {
  type: 'math_structure'
  terms: Array<{ id: string; label: string; detail?: string }>
  relations: Array<{ id: string; from: string; to: string; label?: string }>
}

/**
 * High-level, computable teaching models. The planner/compiler provides only
 * source inputs; results and animation traces are derived deterministically.
 * Pixel coordinates and raw drawing commands intentionally are not part of
 * this public VisualSpec surface.
 */
export type MatrixOperationSemantic = {
  type: 'matrix_operation'
  id: string
  operation: 'multiply'
  left: { id: string; label: string; values: number[][] }
  right: { id: string; label: string; values: number[][] }
  resultId: string
  focus?: { row: number; column: number }
  transferPrompt?: string
}

export type GraphAlgorithmSemantic = {
  type: 'graph_algorithm'
  id: string
  algorithm: 'dijkstra'
  directed: boolean
  nodes: Array<{ id: string; label: string }>
  edges: Array<{ id: string; from: string; to: string; weight: number }>
  sourceId: string
  targetId: string
  transferPrompt?: string
}

export type NaturalFrequencySemantic = {
  type: 'natural_frequency'
  id: string
  population: number
  prevalence: number
  sensitivity: number
  specificity: number
  conditionLabel: string
  positiveLabel: string
  predictionPrompt?: string
}

export type EventLoopSemantic = {
  type: 'event_loop'
  id: string
  language: 'javascript'
  lines: Array<{ id: string; number: number; text: string }>
  operations: Array<{
    id: string
    lineId: string
    kind: 'sync' | 'microtask' | 'task'
    output: string
    order: number
    label: string
  }>
}

export type OptimizationSemantic = {
  type: 'optimization'
  id: string
  objective: 'squared_distance'
  center: number
  initialX: number
  learningRate: number
  iterations: number
  axes: { xLabel: string; yLabel: string; xDomain: VisualPoint; yDomain: VisualPoint }
}

export type ComputerVisualSemantic =
  | ProtocolSequenceSemantic
  | StateMachineSemantic
  | DataStructureSemantic
  | CodeTraceSemantic
  | TensorShapeFlowSemantic
  | ConvolutionTraceSemantic
  | GraphAlgorithmSemantic
  | EventLoopSemantic
  | SemanticSceneSemantic
  | SystemStructureSemantic

export type MathematicsVisualSemantic =
  | FunctionSemantic
  | ProbabilitySemantic
  | TransformationSemantic
  | DerivationSemantic
  | MatrixOperationSemantic
  | NaturalFrequencySemantic
  | OptimizationSemantic
  | MathStructureSemantic

export type VisualStateSnapshot = {
  activeIds: string[]
  currentStateId?: string
  activeLineId?: string
  values: Record<string, VisualScalar>
  pointers: Record<string, string | null>
  positions: Record<string, VisualPoint>
  tensorShapes: Record<string, number[]>
  expressions: Record<string, string>
  series: Record<string, VisualPoint[]>
  stack: string[]
  emittedMessageIds: string[]
  visibleIds?: string[]
  focusIds?: string[]
  groupMembers?: Record<string, string[]>
  orders?: Record<string, string[]>
  properties?: Record<string, Record<string, VisualScalar>>
}

export type VisualPatch =
  | { type: 'send_message'; messageId: string }
  | { type: 'transition_state'; transitionId: string; fromStateId: string; toStateId: string }
  | { type: 'move_item'; itemId: string; to: VisualPoint }
  | { type: 'set_pointer'; pointerId: string; targetId: string | null }
  | { type: 'set_active_line'; lineId: string }
  | { type: 'set_variable'; variableId: string; value: VisualScalar }
  | { type: 'push_stack'; frameId: string }
  | { type: 'pop_stack'; frameId: string }
  | { type: 'set_tensor_shape'; tensorId: string; shape: number[] }
  | { type: 'set_parameter'; parameterId: string; value: number }
  | { type: 'set_probability_sample'; sampleId: string; y: number }
  | { type: 'replace_series'; seriesId: string; points: VisualPoint[] }
  | { type: 'transform_object'; objectId: string; points: VisualPoint[] }
  | { type: 'replace_expression'; stepId: string; expression: string }
  | { type: 'set_trace_step'; semanticId: string; step: number }
  | { type: 'set_visibility'; targetId: string; visible: boolean }
  | { type: 'set_focus'; targetIds: string[] }
  | { type: 'set_property'; targetId: string; key: string; value: VisualScalar }
  | { type: 'set_group_members'; groupId: string; memberIds: string[] }
  | { type: 'set_order'; groupId: string; itemIds: string[] }

export type VisualPredictionGate = {
  id: string
  prompt: string
  choices: Array<{ id: string; label: string }>
  correctChoiceId: string
  explanation: string
}

export type LearningVisualFrame = {
  id: string
  title: string
  narration: string
  durationMs: number
  patches: VisualPatch[]
  prediction?: VisualPredictionGate
}

export type VisualInvariant =
  | { type: 'references_resolve' }
  | { type: 'final_state_active'; targetId: string }
  | { type: 'final_state_value'; targetId: string; equals: VisualScalar }
  | { type: 'tensor_shape'; tensorId: string; shape: number[] }
  | { type: 'probability_bounds'; seriesId?: string }
  | { type: 'cdf_monotonic' }

export type VisualRepair = { code: string; path: string; detail: string }

export type VisualGenerationReport = {
  source: 'model_plan' | 'context_compiler' | 'deterministic_compiler' | 'deterministic_template' | 'legacy_reader'
  plannerSucceeded: boolean
  degraded: boolean
  degradedTo?: 'diagram' | 'storyboard' | 'deterministic_animation'
  modelError?: string
  repairs: VisualRepair[]
  compiler?: { id: string; version: string }
}

export type VisualProvenance = {
  schemaVersion: typeof VISUAL_VERSION
  promptVersion: typeof PROMPT_VERSION
  rendererVersion: typeof RENDERER_VERSION | typeof ASCII_RENDERER_VERSION
  requestHash: string
  requestText: string
}

export type VisualAccessibility = {
  summary: string
  readingOrder: string[]
  nonColorStateCue: string
}

type VisualSpecCommon = {
  version: typeof VISUAL_VERSION
  title: string
  subtitle: string
  explanation: string
  accessibility: VisualAccessibility
  provenance: VisualProvenance
  generation: VisualGenerationReport
}

type DiagramTimeline = { kind: 'diagram'; state: VisualStateSnapshot }
type AnimationTimeline = {
  kind: 'animation'
  initialState: VisualStateSnapshot
  frames: LearningVisualFrame[]
  invariants: VisualInvariant[]
  finalState: VisualStateSnapshot
}

export type ComputerLearningVisualSpec = VisualSpecCommon & { domain: 'computer' } & (
  | { abstraction: 'protocol_sequence'; semantic: ProtocolSequenceSemantic }
  | { abstraction: 'state_machine'; semantic: StateMachineSemantic }
  | { abstraction: 'data_structure'; semantic: DataStructureSemantic }
  | { abstraction: 'code_trace'; semantic: CodeTraceSemantic }
  | { abstraction: 'tensor_shape_flow'; semantic: TensorShapeFlowSemantic }
  | { abstraction: 'convolution_trace'; semantic: ConvolutionTraceSemantic }
  | { abstraction: 'graph_algorithm'; semantic: GraphAlgorithmSemantic }
  | { abstraction: 'event_loop'; semantic: EventLoopSemantic }
  | { abstraction: 'semantic_scene'; semantic: SemanticSceneSemantic }
  | { abstraction: 'system_structure'; semantic: SystemStructureSemantic }
) & (DiagramTimeline | AnimationTimeline)

export type MathematicsLearningVisualSpec = VisualSpecCommon & { domain: 'mathematics' } & (
  | { abstraction: 'function'; semantic: FunctionSemantic }
  | { abstraction: 'probability'; semantic: ProbabilitySemantic }
  | { abstraction: 'transformation'; semantic: TransformationSemantic }
  | { abstraction: 'derivation'; semantic: DerivationSemantic }
  | { abstraction: 'matrix_operation'; semantic: MatrixOperationSemantic }
  | { abstraction: 'natural_frequency'; semantic: NaturalFrequencySemantic }
  | { abstraction: 'optimization'; semantic: OptimizationSemantic }
  | { abstraction: 'math_structure'; semantic: MathStructureSemantic }
) & (DiagramTimeline | AnimationTimeline)

export type LearningVisualSpec = ComputerLearningVisualSpec | MathematicsLearningVisualSpec

export type LegacyLearningVisualNode = {
  id: string
  label: string
  detail?: string
  role: 'input' | 'process' | 'state' | 'output' | 'concept' | 'formula'
  shape: 'card' | 'circle' | 'capsule'
  column: number
  lane: number
}
export type LegacyLearningVisualRelation = {
  id: string
  from: string
  to: string
  label?: string
  kind: 'flow' | 'dependency' | 'transition' | 'comparison' | 'mapping'
}
export type LegacyLearningVisualFrame = {
  id: string
  title: string
  narration: string
  activeNodeIds: string[]
  activeRelationIds: string[]
}
export type LegacyLearningVisualSpec = {
  version: 'learnflow.visual.v1'
  title: string
  subtitle: string
  domain: 'computer' | 'mathematics' | 'general'
  abstraction: string
  kind: 'diagram' | 'animation'
  nodes: LegacyLearningVisualNode[]
  relations: LegacyLearningVisualRelation[]
  frames: LegacyLearningVisualFrame[]
  explanation: string
  provenance: VisualProvenance
  generation: VisualGenerationReport
}

export type ReadableLearningVisualSpec = LearningVisualSpec | LegacyLearningVisualSpec

export type LearningVisualQuality = {
  score: number
  status: 'passed' | 'degraded' | 'rejected'
  issues: string[]
  warnings: string[]
  repaired: boolean
  repairs: VisualRepair[]
  semanticChanges: number
  invariants: { checked: number; passed: number; failures: string[] }
  layout: { collisions: number; outOfBounds: number }
  security: { executableContentRejected: boolean; finiteDataOnly: boolean }
  replayable: boolean
  verification: {
    level: 'structural' | 'derived_verified'
    checked: number
    passed: number
    failures: string[]
  }
}

export type VisualSceneManifest = {
  viewport: readonly [number, number, number, number]
  regions: Array<{ id: string; role: string; bounds: readonly [number, number, number, number] }>
  objects: Array<{
    id: string
    role: string
    regionId: string
    bounds: readonly [number, number, number, number]
    value?: VisualScalar
    status?: string
  }>
}

export type ReadableVisualStep = VisualStep & {
  durationMs?: number
  stateDescription?: string
  prediction?: VisualPredictionGate
  manifest?: VisualSceneManifest
}

export type ReplayableVisualArtifact = VisualArtifact & {
  status: 'usable' | 'degraded'
  degraded: boolean
  degradedTo?: VisualGenerationReport['degradedTo']
  modelError?: string
  plannerSucceeded: boolean
  provenance: VisualProvenance
  quality: LearningVisualQuality
  readable: {
    summary: string
    readingOrder: string[]
    frameDescriptions: string[]
    nonColorStateCue: string
  }
  replay: { spec: ReadableLearningVisualSpec; rendererVersion: typeof RENDERER_VERSION | typeof ASCII_RENDERER_VERSION }
}

export type GenerateText = (
  instructions: string,
  input: string,
  timeoutMs?: number,
  maxTokens?: number,
  options?: { responseFormat?: 'json_object' },
) => Promise<string>

export type VisualGenerationStage =
  | 'compiling'
  | 'planner_started'
  | 'planner_received'
  | 'syntax_repaired'
  | 'validation_started'
  | 'repair_started'
  | 'fallback_started'
  | 'rendered'

export type VisualPlannerAttempt = {
  attempt: 1 | 2
  stage: 'planner' | 'repair'
  timeoutMs: number
  durationMs: number
  status: 'accepted' | 'rejected'
  outputChars: number
  errorType?: 'timeout' | 'syntax' | 'validation' | 'provider' | 'unexpected'
}

export type GeneratedLearningVisual = {
  spec: LearningVisualSpec
  artifact: ReplayableVisualArtifact
  explanation: string
  quality: LearningVisualQuality
  modelError?: string
  plannerSucceeded: boolean
  degraded: boolean
  degradedTo?: VisualGenerationReport['degradedTo']
  generation: {
    source: VisualGenerationReport['source']
    compileStatus: 'exact' | 'illustrative_example' | 'not_applicable'
    plannerAttempts: number
    repairAttempted: boolean
    syntaxRepairApplied: boolean
    attempts: VisualPlannerAttempt[]
  }
}
