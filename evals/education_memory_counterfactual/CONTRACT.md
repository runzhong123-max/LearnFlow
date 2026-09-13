# Automated educational memory counterfactual study v1

This is a new isolated research harness, not a production rollout, teacher review,
student study, or official external-method reproduction. Author-generated cases
are newly frozen, not independently authored or guaranteed unseen to a model.
Old v4 results are immutable. No state-writing authority is changed.

## Responsibilities

generate.py creates case specifications; formation.py executes registered native
LearnFlow events and formal assessment APIs in disposable databases. It exports
actual event/attempt/mutation/fact/state rows and receipts. No direct KernelState,
Mutation, Fact, Module or Claim construction is permitted.

representation.py (root) normalizes supported real evidence to canonical records,
validates scope/source, applies optional read-only condition annotations and
renders either a flat sequence or five-kernel groups. Both forms contain the same
record IDs, fields, values and order within each kernel. Flat records retain their
kernel field. This studies explicit grouping, not removal of educational facts.

verifier.py independently derives observable state and admissible next steps from
actual saved native formation, not from representation.py, model prompts, kernel
heads, or production planning_guidance. It may use the public task contract below;
its scores are operational consistency, not human pedagogical quality.

reader.py makes bounded calls to one configured hosted model. It receives only
the request and rendered evidence, never expected answers, fixture instructions,
verifier code, credentials in messages, or hidden scoring records. No fallback
counts as a model answer. Raw response, finish reason, model alias, usage and input
hash are retained. A hosted model alias is not an immutable weight identifier.

## Python boundary

generate.build_cases() -> list[dict]. Case: case_id, family_id, contrast, side,
at (UTC ISO), topic (id,label), steps (native operation specs), question metadata,
and request. Development/formal membership is fixed before scored model calls.
formation.form_case(case, repo: Path) -> dict asynchronously; output includes
case_id, at, scope, receipts, events, attempts, mutations, facts, nodes, states,
and source table metadata needed to verify scope. Dates are ISO. Preserve actual
native payloads in formation artifacts, never expose full payloads to the reader.
formation must not clear credentials in the parent process: online reading runs
separately from offline formation.

Canonical record: id (string), kernel, kind, topic, occurred_at, expires_at,
source_event_id (int), source_attempt_id (int|null), source_fact_ids (list[int]),
scope, content (safe typed values only), verification. kind is assessment,
time_budget, support, priority, return_anchor, self_report, or gap. Unsupported
formation fields stay explicitly unrepresented and are counted as formation gaps.
Do not guess unknown assistance, canonical item families, or transfer evidence.

Four conditions: five_kernel_gated, flat_gated, five_kernel_source, flat_source.
Scope/ownership/source validity is enforced in all conditions. The gated factor
adds deterministic read-only eligibility annotations (current/expired, supported
versus independent, self-report versus verified); it is a separate intervention
from grouping. It never modifies facts or awards mastery. Keep canonical evidence
identical across all four; annotations are explicitly additional derived fields.
Use a common deterministic selection and record set that fits all four prompts
at each budget, counting serialized prompt input with a disclosed tokenizer.
Record max group overhead instead of trimming different facts by representation.

## Task and automatic output contract

Given current time/scope and available educational evidence, return one JSON object:

    {"latest_result":"correct|incorrect|none",
     "latest_assistance":"independent|supported|unknown",
     "assessment_event_id":123|null,
     "independent_success_supported":true|false,
     "stable_mastery_supported":false,
     "current_priority":string|null,
     "time_budget_minutes":integer|null,
     "support_active":true|false,
     "return_anchor":string|null,
     "next_step":"diagnose_error|reduce_help_then_check|independent_check|clarify_help|collect_evidence",
     "evidence_event_ids":[123]}

Use latest applicable actual graded assessment by event time and event ID. Correct
with declared assistance supports reduce_help_then_check; correct without support
supports independent_check; incorrect supports diagnose_error; missing assessment
supports collect_evidence; correct with unspecified help supports clarify_help.
These are declared operational obligations, not universal optimal teaching claims.
An original retry is not independent transfer. This corpus never establishes stable
mastery or verified transfer. An expired request must not constrain the current
session. Current priority and return anchor follow the latest explicit control. Native
superseded controls do not revive when a later request expires. They are not a model-inferred goal. Support requests require small steps while
active; use the actual independently verified time-control value, with the native
20-minute support cap where applicable. Missing fields remain unknown/null.

Citations must include the latest assessment and the latest supplied control for
each slot, including expired controls used to justify non-applicability. Without
a formal assessment, cite the latest self-report if one exists. These citation
obligations are explicitly included in the shared reader instructions.

Measure per-field correctness, whole-record consistency, unsupported independent
or stable claims, useful next-step obligation fulfillment, false abstention,
citation validity and counterfactual change/invariance. Empty output is not success.
Report selection/formation gaps separately with both end-to-end and available-
evidence denominators. Calibration is not evidence for grouping superiority.
