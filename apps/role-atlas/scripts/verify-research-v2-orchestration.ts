import { readFile, writeFile } from "node:fs/promises";
import { createModelInvoker } from "../lib/agent/model";
import { buildResearchAgent } from "../lib/iteration/research-agent";
import { createIterationContract } from "../lib/iteration/planner";
import { snapshotIterationRequestSchema } from "../lib/iteration/types";
import { researchOptionsSchema } from "../lib/research/protocol";
import { reconstructBuildResult } from "../lib/packages/compiler";
import type { StaticRolePackageBundle } from "../lib/packages/types";
import { PROVIDERS } from "../lib/providers";

// Only the public static release is eligible; no private research records, conversations or database.
const directory = "packages/golden/llm-app-engineer/1.0.0";
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8"));
if (manifest.visibility !== "public") throw new Error("PUBLIC_FIXTURE_REQUIRED");
const components = Object.fromEntries(await Promise.all(Object.keys(manifest.hashes).map(async path => [path, await readFile(`${directory}/${path}`, "utf8")])));
const base = reconstructBuildResult({ manifest, components } as StaticRolePackageBundle);
const segments = base.sources.segments.filter(segment => segment.sourceId === "SRC-GOV-CLASS-2022").slice(0, 3);
const assets = base.sources.assets.filter(asset => segments.some(segment => segment.sourceId === asset.id));
if (segments.length !== 3 || assets.some(asset => asset.kind !== "public_document" || !new URL(asset.locator!).hostname.endsWith(".gov.cn"))) throw new Error("PUBLIC_GOVERNMENT_SOURCES_REQUIRED");
const proof = { visibility: manifest.visibility, packageRootHash: manifest.rootHash, sources: assets.map(asset => ({ id: asset.id, title: asset.title, locator: asset.locator })), excerpts: segments.map(segment => ({ id: segment.id, text: segment.text, excerptType: segment.excerptType })) };
const options = researchOptionsSchema.parse({ objective: "仅阅读提供的三个公开职业分类转述片段，提出并回答一个独立问题：这些转述描述了什么工作，仍不能据此确认什么？只分派一个问题。不联网，不做新的岗位研究。必须标明转述和推断，不能冒充原文直接事实。", budget: { tokens: 100000, queries: 1, tasks: 1, revisions: 1, concurrency: 1, turnsPerBatch: 4 } });
const contract = createIterationContract(snapshotIterationRequestSchema.parse({ runId: "live-public-frozen-replay", snapshotRef: { snapshotId: base.snapshot.id }, research: options }), base);
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("DEEPSEEK_NOT_CONFIGURED");
const raw = createModelInvoker({ provider: "deepseek", model: process.env.RESEARCH_TEST_DEEPSEEK_MODEL || PROVIDERS.deepseek.defaultModel, apiKey: key, thinking: false });
let checkpoints = 0;
const reviewOutputs: Array<{ finishReason: string; content: string }> = [];
const chat = raw.chat!;
raw.chat = async request => {
  const result = await chat(request);
  if (request.messages[0]?.content?.includes("独立的证据复核员")) reviewOutputs.push({ finishReason: result.finishReason, content: result.message.content || "" });
  return result;
};
const agent = buildResearchAgent({ model: raw, budget: options.budget, onCheckpoint: async () => { checkpoints++; } });
let outcome: Record<string, unknown>;
try {
  const signal = AbortSignal.timeout(150000);
  const cards = await agent.plan({ contract, sources: { assets, segments }, workItems: [], round: 1, signal });
  const results = [];
  for (const card of cards) results.push(await agent.run(card, { signal, request: { runId: contract.id, projectId: base.projectId, roleTitle: base.brief.roleTitle, roleDescription: base.brief.roleDescription, market: base.brief.market, audience: base.brief.audience, snapshotAsOf: base.snapshot.asOf, sources: [], research: options }, assets, segments }));
  const supported = results.flatMap(result => result.claims).filter(claim => claim.verification === "verified").length;
  const toolCalls = results.reduce((sum, result) => sum + result.usage.toolCalls, 0);
  outcome = { status: cards.length === 1 && supported > 0 && toolCalls > 0 && results.every(result => result.stopReason === "final") ? "passed" : "failed", tasks: cards.length, toolCalls, supportedClaims: supported, stopReasons: results.map(result => result.stopReason), findings: agent.record()?.findings, reviewedClaims: results.flatMap(result => result.claims).map(item => ({ id: item.claim.id, verification: item.verification, note: item.note })) };
} catch (error) {
  outcome = { status: "failed", error: (error instanceof Error ? error.message : "unknown_error").split(key).join("[redacted]") };
}
const report = { ...outcome, reviewOutputs, publicMaterialProof: proof, checkpoints, budget: agent.budgetLedger.snapshot(), completedAt: new Date().toISOString() };
await writeFile("/private/tmp/role-research-v2-orchestration.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (outcome.status !== "passed") process.exitCode = 1;
