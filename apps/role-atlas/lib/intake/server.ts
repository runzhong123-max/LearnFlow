import { type AccessActor } from "@/lib/access";
import { createRecordedModelInvoker } from "@/lib/research-collection/model";
import { linkRunAttachments, rememberResearchRequester } from "@/lib/research-collection/store";
import { resolveProviderConfig, resolveSearchProviderConfig } from "@/lib/server-runtime-config";
import { workerRuntimeBindings } from "@/lib/worker-runtime-bindings";
import { researchRoleSources } from "@/lib/search/web-research";
import { generateIntakeRevision, normalizeIntakeMaterials } from "./generate";
import { suggestIntakeHubMatches } from "./hub";
import { IntakeRepository } from "./repository";
import { IntakeError, type IntakeConfirmInput, type IntakeScope, type IntakeTurnInput } from "./types";

export async function ensureIntakeSchema() {
  const { ensureAppSchema, getD1 } = await import("@/db");
  await ensureAppSchema();
  const repository = new IntakeRepository(getD1());
  await repository.ensure();
  return repository;
}
type OwnedInput = { actor: Pick<AccessActor, "subjectId">; projectId: string; conversationId: string };
function scope(input: OwnedInput): IntakeScope {
  return { projectId: input.projectId, conversationId: input.conversationId, subjectId: input.actor.subjectId };
}

export async function getIntake(input: OwnedInput) { return (await ensureIntakeSchema()).get(scope(input)); }
export async function confirmIntake(input: OwnedInput & IntakeConfirmInput) { return (await ensureIntakeSchema()).confirm(scope(input), input); }
export async function requireConfirmedIntake(input: OwnedInput & { revisionId: string; contentHash: string; runId: string }) {
  return (await ensureIntakeSchema()).requireConfirmed(scope(input), input);
}

function generationError(error: unknown) {
  if (error instanceof IntakeError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/SERVER_MODEL_NOT_CONFIGURED/u.test(message)) return new IntakeError(503, "INTAKE_MODEL_UNAVAILABLE", "模型尚未配置，输入和资料已经保留；配置后可使用同一操作重试。");
  if (/401|403|API.?KEY|authentication/iu.test(message)) return new IntakeError(503, "INTAKE_MODEL_UNAVAILABLE", "模型凭据不可用，输入和资料已经保留；请检查设置后重试。");
  if (/429|rate.?limit/iu.test(message)) return new IntakeError(503, "INTAKE_MODEL_LIMITED", "模型暂时限流，输入和资料已经保留，可稍后重试。");
  if (/abort|timeout|time limit|timed out|cancel/iu.test(message)) return new IntakeError(503, "INTAKE_INTERRUPTED", "本轮整理超时或已中断，输入和资料已经保留；请使用同一操作重试。");
  return new IntakeError(503, "INTAKE_GENERATION_FAILED", "本轮未能形成完整的岗位说明，输入和资料已经保留，可重试或收窄岗位范围。");
}

export async function turnIntake(input: OwnedInput & { request: Request; turn: IntakeTurnInput }) {
  const repository = await ensureIntakeSchema(), ownedScope = scope(input);
  const turn = { ...input.turn, ...(input.turn.sources ? { sources: normalizeIntakeMaterials(input.turn.sources) } : {}) };
  await repository.scope(ownedScope);
  await linkRunAttachments(input.projectId, `intake:${turn.operationId}`, { sources: turn.sources || [] }, true);
  const start = await repository.begin(ownedScope, turn);
  if ("completed" in start) return start.completed;
  const { claim } = start;
  try {
    await rememberResearchRequester(input.request);
    await linkRunAttachments(input.projectId, claim.revisionId, { sources: turn.sources || [] });
    const project = await repository.scope(ownedScope);
    const current = await repository.get(ownedScope);
    const bindings = workerRuntimeBindings();
    const provider = resolveProviderConfig(turn.providerConfig, bindings);
    const model = createRecordedModelInvoker(provider, { projectId: input.projectId, runId: claim.revisionId });
    let search;
    try { search = resolveSearchProviderConfig(turn.searchConfig, bindings); } catch { search = undefined; }
    const signal = AbortSignal.any([input.request.signal, AbortSignal.timeout(115_000)]);
    const searchConfig = search;
    const content = await generateIntakeRevision({
      projectId: input.projectId, revisionId: claim.revisionId, turn, previous: claim.previous, project, history: current.history, signal,
      dependencies: {
        model,
        research: searchConfig ? args => researchRoleSources({ ...args, config: searchConfig, sourceLimit: 6,
          signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) }) : undefined,
        hub: query => suggestIntakeHubMatches(query),
      },
    });
    return await repository.complete(ownedScope, claim, content);
  } catch (error) {
    const failure = generationError(error);
    await repository.fail(ownedScope, claim, failure.message).catch(() => undefined);
    throw failure;
  }
}
