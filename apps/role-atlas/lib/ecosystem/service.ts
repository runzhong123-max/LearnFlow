import { z } from "zod/v4";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import { SnapshotRoleRuntime, CORE_ROLE_TOOL_NAMES } from "@/lib/agent/snapshot-runtime";
import { packageLearningSource, resolveRoleLearningPoints } from "@/lib/learning-path/resolution";
import { validateLearningPathGraphV2, validateGraphExtensionProposalV2, validateRoleLearningAlignmentV2, type LearningPathGraphV2, type RolePackageRef, type GraphExtensionProposalV2, type RoleLearningAlignmentV2 } from "@/lib/learning-path/contract";
import { GatewayError, packageRefSchema, type Actor, type GatewayRequest } from "./protocol";
export type LoadedPackage = { packageRef: RolePackageRef; title: string; result: ColdStartBuildResult };
export type AgentRun = { runId: string; status: "running" | "completed" | "failed"; packageRef: RolePackageRef; result?: { answer: string; citations: unknown[]; packageRef: RolePackageRef }; error?: { code: string }; agentVersion: string; workflowVersion: string };
export interface GatewayRepository {
  search(actor: Actor, input: { query: string; offset: number; limit: number }): Promise<unknown>;
  load(actor: Actor, ref: RolePackageRef): Promise<LoadedPackage>;
  getRun(actor: Actor, runId: string): Promise<AgentRun | null>;
  claimRun(actor: Actor, requestId: string, bodyHash: string, run: AgentRun): Promise<{ created: boolean; run: AgentRun }>;
  finishRun(actor: Actor, run: AgentRun): Promise<void>;
}
export type AgentRunner = (loaded: LoadedPackage, message: string, targetIds: string[], runId: string) => Promise<{ answer: string; citations: unknown[]; packageRef: RolePackageRef }>;
const targets = z.array(z.string().min(1).max(256)).max(25).default([]);
const graphInput = (input: unknown): LearningPathGraphV2 => { const valid = validateLearningPathGraphV2(input); if (!valid.valid) throw new GatewayError("PATH_CONTRACT_INVALID"); return valid.value; };
export async function dispatchGateway(request: GatewayRequest, actor: Actor, deps: { repository: GatewayRepository; runAgent: AgentRunner; keepAlive?: (execution: Promise<unknown>) => void }) {
  const repo = deps.repository;
  switch (request.operation) {
    case "catalog.search": return repo.search(actor, z.object({ query: z.string().max(300).default(""), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(30).default(20) }).strict().parse(request.payload));
    case "package.resolve": { const p = z.object({ packageRef: packageRefSchema }).strict().parse(request.payload); return repo.load(actor, p.packageRef); }
    case "role.query": {
      const p = z.object({ packageRef: packageRefSchema, tool: z.enum(CORE_ROLE_TOOL_NAMES), args: z.record(z.string(), z.unknown()).default({}) }).strict().parse(request.payload);
      const loaded = await repo.load(actor, p.packageRef);
      return new SnapshotRoleRuntime(loaded.result).execute({ name: p.tool, args: p.args }, request.requestId);
    }
    case "learning.resolve": {
      const p = z.object({ packageRef: packageRefSchema, graph: z.unknown(), namespace: z.string(), targetIds: targets }).strict().parse(request.payload);
      const namespace = `learnflow:extension:${(await sha256Hex(actor.sub)).slice(0, 20)}`;
      if (p.namespace !== namespace) throw new GatewayError("NAMESPACE_FORBIDDEN", 403);
      const loaded = await repo.load(actor, p.packageRef);
      return resolveRoleLearningPoints({ ...loaded, graph: graphInput(p.graph), namespace, targetIds: p.targetIds });
    }
    case "learning.validate_extension": {
      const p = z.object({ proposal: z.unknown(), graph: z.unknown() }).strict().parse(request.payload);
      const proposal = p.proposal as GraphExtensionProposalV2;
      const ref = packageRefSchema.parse(proposal?.packageRef);
      if (proposal.namespace !== `learnflow:extension:${(await sha256Hex(actor.sub)).slice(0, 20)}`) throw new GatewayError("NAMESPACE_FORBIDDEN", 403);
      const loaded = await repo.load(actor, ref), graph = graphInput(p.graph);
      const checked = validateGraphExtensionProposalV2(proposal, graph, packageLearningSource(loaded.result, ref));
      if (!checked.valid) throw new GatewayError("PATH_PROPOSAL_INVALID");
      return { proposal: checked.value, graph: { ...graph, sources: [...graph.sources, ...proposal.sources], nodes: [...graph.nodes, ...proposal.nodes], edges: [...graph.edges, ...proposal.edges] } };
    }
    case "learning.validate_alignment": {
      const p = z.object({ alignment: z.unknown(), graph: z.unknown() }).strict().parse(request.payload);
      const alignment = p.alignment as RoleLearningAlignmentV2, ref = packageRefSchema.parse(alignment?.packageRef);
      const loaded = await repo.load(actor, ref);
      const checked = validateRoleLearningAlignmentV2(alignment, graphInput(p.graph), packageLearningSource(loaded.result, ref));
      if (!checked.valid) throw new GatewayError("PATH_ALIGNMENT_INVALID");
      return { alignment: checked.value };
    }
    case "agent.get_run": {
      const p = z.object({ runId: z.string().regex(/^ecosystem:[a-f0-9]{40}$/) }).strict().parse(request.payload);
      const run = await repo.getRun(actor, p.runId); if (!run) throw new GatewayError("RUN_NOT_FOUND", 404);
      await repo.load(actor, run.packageRef); // revoked package visibility also revokes its answers
      return run;
    }
    case "agent.run": {
      const p = z.object({ packageRef: packageRefSchema, message: z.string().trim().min(1).max(4000), targetIds: targets }).strict().parse(request.payload);
      const loaded = await repo.load(actor, p.packageRef);
      if (p.targetIds.some(id => !loaded.result.semantic.nodes.some(n => n.id === id))) throw new GatewayError("ROLE_NODE_NOT_FOUND", 404);
      if (!deps.keepAlive) throw new GatewayError("BACKGROUND_RUNTIME_UNAVAILABLE", 503);
      const run: AgentRun = { runId: `ecosystem:${(await sha256Hex(`${actor.sub}:${request.requestId}`)).slice(0, 40)}`, status: "running", packageRef: p.packageRef, agentVersion: "role-reader/v1", workflowVersion: "grounded-role-query/v1" };
      const claimed = await repo.claimRun(actor, request.requestId, await sha256Hex(canonicalStringify(p)), run);
      if (!claimed.created) return claimed.run;
      const execute = async () => {
        try { const result = await deps.runAgent(loaded, p.message, p.targetIds, run.runId); await repo.finishRun(actor, { ...run, status: "completed", result }); }
        catch { await repo.finishRun(actor, { ...run, status: "failed", error: { code: "AGENT_EXECUTION_FAILED" } }); }
      };
      deps.keepAlive(execute());
      return run;
    }
  }
}
