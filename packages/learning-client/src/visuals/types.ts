/** VisualSpec 0.1.0 authoring contract; host schema is the acceptance authority. */
export type VisualParameter = { id: string; label: string; type: 'number' | 'integer'; min: number; max: number; step: number; default: number; unit: string; on_change: 'reset_run' }
export type VisualElement = { id: string; kind: 'axis'|'curve'|'point'|'region'|'array'|'matrix'|'graph'|'code'|'text'|'metric'; label: string; inputs: Record<string, {source: string}>; values?: Record<string, any> }
export type VisualView = { id: string; title: string; renderer: 'auto'|'svg'|'plot'|'canvas'; elements: VisualElement[] }
export type VisualSpec = {
  spec_version: '0.1.0'; id: string; title: string; domains: string[];
  teaching: { goal: string; misconceptions: string[]; assumptions: string[]; checkpoints: Array<{id: string; at_step: number; prompt: string; rubric_ref: string}> };
  parameters: VisualParameter[]; data: Record<string, any>;
  model: {id: string; version: string; inputs: Record<string, {source: string}>; seed: number; max_steps: number};
  layout: {kind: 'stack'|'columns'|'grid'; view_order: string[]}; views: VisualView[];
  playback: {initial_step: number; autoplay: false; transition: {kind: 'cut'|'interpolate'; duration_ms: number; easing: string}; reduced_motion: 'cut'};
  interactions: Array<{id: string; kind: 'slider'|'stepper'|'prediction'; parameter_id?: string; checkpoint_id?: string; target?: string; allow_back?: boolean}>;
  annotations: Array<{id: string; target_id: string; text: string}>;
  validation: {requested_checks: Array<{id: string; version: string}>};
  accessibility: {summary: string; keyboard: true; text_alternative: true}; fallback: {kind: string; text: string};
}
export type VisualFrame = {step: number; state: Record<string, any>; views: VisualView[]; snapshot_ref: string}
export type VisualBundle = {
  runtime_version: string; spec_revision: string; run_id: string; owner_scope: string;
  spec: VisualSpec; params: Record<string, number>; frames: VisualFrame[];
  verification: {status: 'pass'; checker: string; version: string; scope: string; assumptions: string[]; steps_checked: number; input_digest: string};
  termination: 'complete'|'budget_exhausted';
}
export type VisualTransport = (action: 'compile'|'inspect'|'predict', payload: Record<string, unknown>) => Promise<any>
export type PresentationObject = {id: string; bounds: [number, number, number, number]; overlap: 'plot'|'none'}
export type PresentationPlan = {version: '1'; viewId: string; width: number; height: number; objects: PresentationObject[]; transition: 'cut'}
export type RenderDiagnostic = {code: 'VIEWPORT_OVERFLOW'|'TEXT_TOO_DENSE'; object_id: string; semantic_mutation_allowed: false}
