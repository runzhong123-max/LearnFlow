/** Explicit live acceptance. Public sources only; no application database writes. */
import { readFile, writeFile } from "node:fs/promises";
import { createModelInvoker } from "../lib/agent/model";
import { createColdStartSkill } from "../lib/build/graph";
import { deriveLearningSupport } from "../lib/research/learning-support";
import { deriveTaskDefinitions } from "../lib/research/task-definition";
import { refreshRolePackageManifest } from "../lib/packages/role-package-manifest";
import { buildResearchAgent } from "../lib/iteration/research-agent";
import { researchOptionsSchema } from "../lib/research/protocol";
import { fetchReadablePage } from "../lib/search/web-research";
import type { ColdStartRequest, SourceInput } from "../lib/build/types";
import { PROVIDERS } from "../lib/providers";

const output = process.env.RESEARCH_TEST_REPORT || "/tmp/role-coldstart-delivery.json";
const sourceFile = process.env.RESEARCH_TEST_SOURCES;
let sources: SourceInput[];
if (sourceFile) sources = JSON.parse(await readFile(sourceFile, "utf8"));
else {
  const pages = [
    { title: "私有云运维工程师岗位职责", url: "https://www.jobui.com/gangwei/siyouyunyunweigongchengshi/duty/", content: "" },
    { title: "云计算工程师岗位职责", url: "https://www.jobui.com/gangwei/yunjisuangongchengshi/duty/", content: "" },
  ];
  sources = await Promise.all(pages.map(async page => {
    const result = await fetchReadablePage(page, AbortSignal.timeout(30000), true);
    if (result.content.length < 200) console.log(`Public source unreadable: ${page.url}; research must find usable material.`);
    return { title: page.title, kind: "public_document" as const, url: page.url, content: result.content, sourceTier: "secondary" as const };
  }));
  await writeFile(`${output}.sources.json`, JSON.stringify(sources, null, 2));
}
if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required");
const raw = createModelInvoker({ provider: "deepseek", model: PROVIDERS.deepseek.defaultModel, apiKey: process.env.DEEPSEEK_API_KEY, thinking: false });
let calls = 0, inputTokens = 0, outputTokens = 0;
const model = Object.assign(raw.bind(null), { chat: async (request: Parameters<NonNullable<typeof raw.chat>>[0]) => {
  const result = await raw.chat!(request);
  inputTokens += result.usage.inputTokens; outputTokens += result.usage.outputTokens;
  console.log(JSON.stringify({ call: ++calls, stage: String(request.messages[0]?.content).slice(0, 45), finish: result.finishReason, inputTokens, outputTokens }));
  return result;
} });
const request: ColdStartRequest = { runId: `delivery-check-${Date.now()}`, projectId: "isolated-public-delivery-check", roleTitle: "云计算工程师", roleDescription: "面向计算机专业群高职学生，初级云平台实施与运维方向，按既定方案部署配置、监控排障和交付文档；不承担核心平台研发、架构决策、职业标准编制。", market: "中国大陆", audience: ["高职学生", "教师"], snapshotAsOf: new Date().toISOString().slice(0, 10), sources, research: researchOptionsSchema.parse({ depth: process.env.RESEARCH_TEST_DEPTH || "high", ...(process.env.RESEARCH_TEST_REVISIONS ? { budget: { revisions: Number(process.env.RESEARCH_TEST_REVISIONS) } } : {}) }) };
const started = Date.now();
const agent = buildResearchAgent({ model, depth: request.research!.depth, budget: request.research!.budget, yieldForSynthesis: true });
const graph = createColdStartSkill(model, { emitEvents: false, ...(!sourceFile && process.env.GLM_API_KEY ? { searchConfig: { provider: "glm" as const, apiKey: process.env.GLM_API_KEY, engine: "search_pro" as const } } : {}) });
let result: import("../lib/build/types").ColdStartBuildResult | undefined;
if (process.env.RESEARCH_TEST_RESULT) {
  result = JSON.parse(await readFile(process.env.RESEARCH_TEST_RESULT, "utf8"));
  if (!result) throw new Error("Missing replay result");
  let previousGaps = Number.POSITIVE_INFINITY;
  const signal = AbortSignal.timeout(15 * 60_000);
  for (let round = 0; round < request.research!.budget.stagnantRounds; round += 1) {
    await deriveLearningSupport(agent.model, result, signal, agent.reviewModel);
    await deriveTaskDefinitions(agent.model, result, signal, agent.reviewModel);
    await writeFile(output, JSON.stringify(result, null, 2));
    const gaps = result.deliveryReadiness!.blockers.length;
    console.log(JSON.stringify({ contentRound: round + 1, ready: result.deliveryReadiness!.ready, blockers: result.deliveryReadiness!.blockers }));
    if (result.deliveryReadiness!.ready || gaps >= previousGaps) break;
    previousGaps = gaps;
  }
  result = refreshRolePackageManifest(result, { status: result.deliveryReadiness?.ready ? "ready" : "candidate" });
} else for await (const state of await graph.stream({ request }, { streamMode: "values", recursionLimit: 10_000, signal: AbortSignal.timeout(25 * 60_000) })) {
  if (state.result) { result = state.result; await writeFile(output, JSON.stringify(result, null, 2)); }
}
if (!result) throw new Error("No cold-start result");
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ acceptance: process.env.RESEARCH_TEST_RESULT ? "content_replay" : "full_cold_start", output, elapsedMs: Date.now() - started, calls, inputTokens, outputTokens, nodes: result.semantic.nodes.map(node => ({ type: node.type, label: node.label })), readiness: result.deliveryReadiness, failures: result.build?.workItems.filter(item => item.status === "failed").map(item => ({ lane: item.lane, error: item.error })) }, null, 2));
if (!result.deliveryReadiness?.ready) process.exitCode = 1;
