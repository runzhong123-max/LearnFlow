import { createRecordedModelInvoker } from "@/lib/research-collection/model";
import { createCoursePlanner } from "@/lib/learning-path/course-planner";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { workerRuntimeBindings } from "@/lib/worker-runtime-bindings";
import { resolveProviderConfig } from "@/lib/server-runtime-config";
import { createModelInvoker } from "@/lib/agent/model";
import { createRoleAgent } from "@/lib/agent/graph";
import { SnapshotRoleRuntime } from "@/lib/agent/snapshot-runtime";
import { ecosystemRepository } from "@/lib/ecosystem/repository";
import { dispatchGateway } from "@/lib/ecosystem/service";
import { PROTOCOL, GatewayError, readBoundedBody, requestSchema, verifyDelegation } from "@/lib/ecosystem/protocol";
export async function POST(request: Request) {
  let requestId = "invalid";
  const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const raw = await readBoundedBody(request);
    const input = requestSchema.safeParse(JSON.parse(raw));
    if (!input.success) throw new GatewayError("INVALID_REQUEST");
    requestId = input.data.requestId;
    const bindings = workerRuntimeBindings();
    const actor = await verifyDelegation(request.headers.get("X-LearnFlow-Delegation"), raw, input.data, String(bindings.ROLE_ATLAS_GATEWAY_SECRET || process.env.ROLE_ATLAS_GATEWAY_SECRET || ""));
    const context = getRequestExecutionContext();
    const data = await dispatchGateway(input.data, actor, {
      repository: ecosystemRepository,
      coursePlanner: loaded => createCoursePlanner(createRecordedModelInvoker(resolveProviderConfig(undefined, bindings), { projectId: loaded.result.projectId, runId: `course-plan:${requestId}` })),
      keepAlive: context ? promise => context.waitUntil(promise) : undefined,
      runAgent: async (loaded, message, targetIds, runId) => {
        const invoke = createModelInvoker(resolveProviderConfig(undefined, bindings));
        const agent = createRoleAgent(input => invoke({ ...input, maxCompletionTokens: 4096, totalTimeoutMs: 22_000 }), new SnapshotRoleRuntime(loaded.result));
        const output = await agent.invoke({ request: { runId, sessionId: runId, message, history: [], references: targetIds.map(targetId => ({ ...loaded.packageRef, targetId })) } }, { signal: AbortSignal.timeout(25_000) });
        return { answer: output.finalAnswer, citations: output.citations, packageRef: loaded.packageRef };
      },
    });
    return response({ protocol: PROTOCOL, requestId, ok: true, data });
  } catch (error) {
    const known = error instanceof GatewayError;
    const invalid = error instanceof SyntaxError || (error as { name?: string })?.name === "ZodError";
    return response({ protocol: PROTOCOL, requestId, ok: false, error: { code: known ? error.code : invalid ? "INVALID_REQUEST" : "GATEWAY_OPERATION_FAILED", message: known ? error.code : "请求未能完成", retryable: known && error.retryable } }, known ? error.status : invalid ? 400 : 502);
  }
}
