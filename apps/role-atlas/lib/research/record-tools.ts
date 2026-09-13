import { z } from "zod";
import type { ResearchTool } from "@/lib/agent/research-loop";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { claimSchema } from "@/lib/iteration/evidence-review";
import type { ResearchFinding, ResearchRun } from "./protocol";
import { stableHash } from "@/lib/build/compiler";
import type { ResearchSourceStore } from "./source-store";

const findingInput = z.object({ claim: claimSchema, axis: z.enum(["temporal", "relational"]), consequence: z.string().min(1).max(2000), nextQuestion: z.string().max(2000).optional() });
export function researchRecordTools(input: { run: ResearchRun; store: ResearchSourceStore; graph?: ColdStartBuildResult; save: () => Promise<void> }): ResearchTool[] {
  return [
    { name: "read_graph", description: "按对象 ID 或关键词读取局部图谱、任务定义、关系、过程与证据引用。只读调查不会扩大改动权限。", args: { id: "对象 ID", query: "名称或摘要关键词", offset: "结果位置", relationOffset: "关系位置，使用 nextRelationOffset 续读" }, run: async args => {
      const graph = input.graph;
      if (!graph) return { summary: "冷启动尚无已生成图谱", data: { missing: true } };
      const objects = [...graph.semantic.nodes, ...graph.process.nodes, ...graph.process.scenarios];
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const matched = objects.filter(object => args.id ? object.id === args.id : JSON.stringify(object).includes(String(args.query || "")));
      const page = matched.slice(offset, offset + 6), ids = new Set(page.map(object => object.id));
      const relations = [...graph.semantic.edges, ...graph.process.edges].filter(edge => ids.has(edge.source) || ids.has(edge.target));
      const relationOffset = Math.max(0, Math.floor(Number(args.relationOffset) || 0));
      return { summary: "局部图谱；对象与关系均可按返回位置继续读取", data: { objects: page, relations: relations.slice(relationOffset, relationOffset + 40), relationsTruncated: relationOffset + 40 < relations.length, nextRelationOffset: relationOffset + 40 < relations.length ? relationOffset + 40 : null, bridges: graph.process.bridges.filter(bridge => ids.has(bridge.semanticNodeId) || ids.has(bridge.processNodeId)), nextOffset: offset + 6 < matched.length ? offset + 6 : null } };
    } },
    { name: "read_research_record", description: "分页读取研究发现、冲突、缺口及改动理由；旧记录不是新的授权。", args: { offset: "记录起始位置", taskId: "可选：读取一个完整研究任务" }, run: async args => {
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      return { summary: "研究记录", data: { task: args.taskId ? input.run.agenda.tasks.find(task => task.id === args.taskId) : undefined, findings: input.run.findings.slice(offset, offset + 8), gaps: input.run.agenda.gaps.slice(offset, offset + 8), changeSets: input.run.changeSets.map(change => ({ id: change.id, status: change.status, motivation: change.motivation })), nextOffset: offset + 8 < Math.max(input.run.findings.length, input.run.agenda.gaps.length) ? offset + 8 : null } };
    } },
    { name: "submit_finding", description: "保存有依据的候选发现、冲突或缺失概念。返回引用校验结果；保存不代表已复核或已采用。", args: {}, parameters: z.toJSONSchema(findingInput) as Record<string, unknown>, validate: value => findingInput.parse(value), run: async args => {
      const parsed = findingInput.parse(args);
      const invalid = parsed.claim.evidenceSpans.filter(span => !input.store.verify(span.segmentId, span.quote));
      if (invalid.length) throw new Error(`原文引用不符：${invalid.map(span => span.segmentId).join(", ")}`);
      const id = `finding:${stableHash(JSON.stringify(parsed))}`;
      const finding: ResearchFinding = { ...parsed, id, review: "undetermined", adoption: "candidate" };
      if (!input.run.findings.some(item => item.id === id)) input.run.findings.push(finding);
      await input.save();
      return { summary: "已保存候选发现，尚未经语义复核和采用", data: { findingId: id, review: finding.review, adoption: finding.adoption } };
    } },
  ];
}
