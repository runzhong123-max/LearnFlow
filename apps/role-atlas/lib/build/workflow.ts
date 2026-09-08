import { stableHash } from "./compiler";
import { COLD_START_WORKFLOW_VERSION } from "./workflow-version";
export { COLD_START_WORKFLOW_VERSION } from "./workflow-version";
import type {
  BuildWorkItemSummary,
  ConceptMention,
  EvidenceRole,
  SourceAsset,
  SourceQualification,
  SourceSegment,
} from "./types";
import type { SemanticDraft } from "./model";

/**
 * Only evidence roles that can describe current work are allowed onto the
 * task-barrier critical path. Technology, education and future-signal sources
 * remain in the evidence layer and are consumed by their dedicated lanes.
 */
export const SOURCE_ATOM_EVIDENCE_ROLES: ReadonlySet<EvidenceRole> = new Set([
  "role_boundary",
  "official_standard",
  "job_market",
  "work_practice",
  "workspace_observation",
]);

export type SourceShard = {
  id: string;
  sourceId: string;
  segmentIds: string[];
  segments: SourceSegment[];
  estimatedTokens: number;
  qualification: SourceQualification;
};

export type TaskGroup = {
  id: string;
  tasks: SemanticDraft["nodes"];
  evidenceSegmentIds: string[];
};

export function normalizeConcept(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Conservative multilingual estimate used for scheduling, not billing. */
export function estimateTokens(value: string) {
  let weighted = 0;
  for (const character of value) weighted += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character) ? 1 : 0.32;
  return Math.max(1, Math.ceil(weighted));
}

function sourceText(asset: SourceAsset, segments: SourceSegment[]) {
  return `${asset.title}\n${segments.filter((segment) => segment.sourceId === asset.id).map((segment) => segment.text).join("\n").slice(0, 12_000)}`;
}

function sourceHost(asset: SourceAsset) {
  try { return asset.locator ? new URL(asset.locator).hostname.toLocaleLowerCase() : asset.domain?.toLocaleLowerCase() || ""; }
  catch { return asset.domain?.toLocaleLowerCase() || ""; }
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

export function qualifySource(asset: SourceAsset, segments: SourceSegment[]): SourceQualification {
  if (asset.kind === "user_brief") return { status: "accepted", evidenceRoles: ["role_boundary"], reasons: ["用户明确提供的研究边界"] };
  if (asset.kind === "workspace_observation") {
    return { status: "accepted", evidenceRoles: ["workspace_observation", "work_practice"], reasons: ["经授权的真实工作区观察"] };
  }

  const text = sourceText(asset, segments);
  const host = sourceHost(asset);
  const categories = new Set(asset.searchCategories || []);
  const roles: EvidenceRole[] = [];
  const reasons: string[] = [];
  const contextual = asset.sourceTier === "contextual" || /(zhihu|csdn|bilibili|nowcoder|juejin)\./i.test(host);
  const noisy = /(报名|招生|加微信|付费课程|限时优惠|领取资料|面经|简历模板|零基础速成|保姆级教程)/u.test(text);
  const officialHost = /(^|\.)gov\.cn$|(^|\.)moe\.gov\.cn$/i.test(host);
  const standardText = /(国家|行业|职业|专业教学|课程)标准|职业分类|规范|产业政策/u.test(text);
  const jobText = /岗位职责|任职要求|职位描述|工作职责|招聘职位/u.test(text);
  const practiceText = /项目复盘|工作流程|典型任务|交付物|上线|发布|验收|故障|运维|研发流程|事故复盘/u.test(text);
  const learningText = /学习路径|课程|培训|教程|面试|求职|应聘|招生/u.test(text);
  const technicalPrimaryHost = /(^|\.)(docs|developer|developers|learn)\./i.test(host) || /github\.com$|arxiv\.org$|doi\.org$/i.test(host);
  const technicalText = /技术文档|架构|接口|API|SDK|框架|模型|算法|工程实践|reference|documentation/iu.test(text);

  if (categories.has("official_standard")) {
    if ((officialHost || asset.sourceTier === "authoritative" || asset.sourceTier === "primary") && standardText) roles.push("official_standard");
    else reasons.push("未满足正式标准来源条件，不能作为官方标准使用");
  }
  if (categories.has("job_market") && jobText) roles.push("job_market");
  if (categories.has("work_practice")) {
    if (practiceText && !(learningText && !/项目复盘|工作流程|交付物|故障|事故复盘/u.test(text))) roles.push("work_practice");
    else reasons.push("缺少真实工作触发、行动或交付结果，不能作为工作实践使用");
  }
  if (categories.has("technology")) {
    if ((technicalPrimaryHost || asset.sourceTier === "primary" || asset.sourceTier === "authoritative") && technicalText) roles.push("technology_primary");
    else reasons.push("不是可确认的一手技术资料，只能作为上下文参考");
  }
  if (categories.has("education") && /课程|实训|教学|学习成果|技能评价|人才培养/u.test(text)) roles.push("education");
  if (categories.has("future_signal") && /趋势|变化|影响|演进|未来|增长|替代|自动化/u.test(text)) roles.push("future_signal");
  if (!categories.size && jobText) roles.push("job_market");
  if (!categories.size && practiceText && !learningText) roles.push("work_practice");
  if (asset.kind === "private_document" && practiceText) roles.push("work_practice");

  const evidenceRoles = unique(roles);
  if (noisy && contextual && evidenceRoles.length === 0) {
    return { status: "quarantined", evidenceRoles: [], reasons: [...reasons, "营销、求职或教程噪声较强，已从事实抽取上下文隔离"] };
  }
  if (evidenceRoles.length === 0) {
    return { status: "limited", evidenceRoles: [], reasons: reasons.length ? reasons : ["来源与岗位相关，但尚未验证其可承担的证据角色"] };
  }
  return {
    status: contextual || reasons.length > 0 ? "limited" : "accepted",
    evidenceRoles,
    reasons: reasons.length ? reasons : ["来源内容与证据角色一致"],
  };
}

export function qualifySources(assets: SourceAsset[], segments: SourceSegment[]) {
  return assets.map((asset) => ({ ...asset, qualification: qualifySource(asset, segments) }));
}

export function createSourceShards(input: {
  assets: SourceAsset[];
  segments: SourceSegment[];
  targetTokens?: number;
  hardTokenLimit?: number;
  allowedEvidenceRoles?: ReadonlySet<EvidenceRole>;
}) {
  const targetTokens = Math.max(600, input.targetTokens || 1_200);
  const hardTokenLimit = Math.max(targetTokens, input.hardTokenLimit || 2_200);
  const allowedEvidenceRoles = input.allowedEvidenceRoles || SOURCE_ATOM_EVIDENCE_ROLES;
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]));
  const shards: SourceShard[] = [];
  for (const [sourceId, sourceSegments] of Map.groupBy(input.segments, (segment) => segment.sourceId)) {
    const asset = assets.get(sourceId);
    if (!asset || asset.qualification?.status === "quarantined") continue;
    const qualification = asset.qualification || qualifySource(asset, input.segments);
    if (!qualification.evidenceRoles.some((role) => allowedEvidenceRoles.has(role))) continue;
    let bucket: SourceSegment[] = [];
    let tokens = 0;
    const flush = () => {
      if (!bucket.length) return;
      const segmentIds = bucket.map((segment) => segment.id);
      shards.push({
        id: `shard:${stableHash(`${sourceId}:${segmentIds.join(":")}`)}`,
        sourceId,
        segmentIds,
        segments: bucket,
        estimatedTokens: tokens,
        qualification,
      });
      bucket = [];
      tokens = 0;
    };
    for (const segment of [...sourceSegments].sort((left, right) => left.ordinal - right.ordinal)) {
      const segmentTokens = estimateTokens(segment.text);
      if (bucket.length && (tokens + segmentTokens > hardTokenLimit || tokens >= targetTokens)) flush();
      bucket.push(segment);
      tokens += segmentTokens;
      if (tokens >= hardTokenLimit) flush();
    }
    flush();
  }
  return shards;
}

function roleAnchor(roleTitle: string) {
  const stripped = roleTitle
    .replace(/(?:高级|资深|初级|助理)?(?:工程师|开发者|程序员|架构师|设计师|分析师|管理员|运维员|操作员|专员|顾问|经理|负责人)$/u, "")
    .replace(/\b(?:senior|junior|lead|principal|staff)?\s*(?:engineer|developer|architect|analyst|administrator|operator|specialist|consultant|manager)\b$/iu, "");
  const normalized = normalizeConcept(stripped);
  return normalized.length >= 2 ? normalized : normalizeConcept(roleTitle);
}

/**
 * A low-scoring adjacent-role JD is useful evidence, but it must not occupy
 * the task-barrier critical path. Keep it in SourceAsset/SourceSegment and
 * defer it to later comparison or research views.
 */
export function selectKernelSourceShards(input: {
  shards: SourceShard[];
  assets: SourceAsset[];
  roleTitle: string;
  maxPublicShards?: number;
}) {
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]));
  const fullRole = normalizeConcept(input.roleTitle);
  const anchor = roleAnchor(input.roleTitle);
  const shortAnchor = anchor.length >= 4 ? anchor.slice(0, 4) : anchor;
  const eligible: SourceShard[] = [];
  const deferred: SourceShard[] = [];
  for (const shard of input.shards) {
    const asset = assets.get(shard.sourceId);
    if (asset?.kind === "user_brief") {
      deferred.push(shard);
      continue;
    }
    const roles = new Set(shard.qualification.evidenceRoles);
    const marketOrPracticeOnly = (roles.has("job_market") || roles.has("work_practice"))
      && !roles.has("official_standard")
      && !roles.has("workspace_observation");
    if (!asset || !marketOrPracticeOnly || asset.kind === "private_document") {
      eligible.push(shard);
      continue;
    }
    const text = normalizeConcept(`${asset.title}\n${shard.segments.map((segment) => segment.text).join("\n").slice(0, 8_000)}`);
    const explicitlyAligned = text.includes(fullRole)
      || anchor.length >= 2 && text.includes(anchor)
      || shortAnchor.length >= 2 && text.includes(shortAnchor);
    const highRetrievalAlignment = (asset.retrievalScore || 0) >= 0.78;
    const authoritative = asset.sourceTier === "authoritative" || asset.sourceTier === "primary";
    (explicitlyAligned || highRetrievalAlignment || authoritative ? eligible : deferred).push(shard);
  }

  const privileged = eligible.filter((shard) => {
    const asset = assets.get(shard.sourceId);
    return asset?.kind === "private_document" || asset?.kind === "workspace_observation";
  });
  const publicGroups = Map.groupBy(eligible.filter((shard) => !privileged.includes(shard)), (shard) => shard.sourceId);
  const sourceScore = (shards: SourceShard[]) => {
    const asset = assets.get(shards[0].sourceId);
    const roles = new Set(shards[0].qualification.evidenceRoles);
    return (asset?.sourceTier === "authoritative" ? 40 : asset?.sourceTier === "primary" ? 32 : 0)
      + (shards[0].qualification.status === "accepted" ? 14 : 0)
      + (roles.has("official_standard") ? 30 : roles.has("job_market") ? 24 : roles.has("work_practice") ? 20 : 8)
      + (asset?.retrievalScore || 0) * 20;
  };
  const rankedGroups = [...publicGroups.values()].sort((left, right) => sourceScore(right) - sourceScore(left));
  const publicLimit = Math.max(1, Math.min(input.maxPublicShards || 4, 8));
  const publicSelected: SourceShard[] = [];
  let round = 0;
  while (publicSelected.length < publicLimit) {
    let added = false;
    for (const group of rankedGroups) {
      const shard = group[round];
      if (!shard) continue;
      publicSelected.push(shard);
      added = true;
      if (publicSelected.length >= publicLimit) break;
    }
    if (!added) break;
    round += 1;
  }
  const selectedIds = new Set([...privileged, ...publicSelected].map((shard) => shard.id));
  deferred.push(...eligible.filter((shard) => !selectedIds.has(shard.id)));
  const selected = [...privileged, ...publicSelected];
  if (!selected.length) {
    const brief = input.shards.find((shard) => assets.get(shard.sourceId)?.kind === "user_brief");
    if (brief) {
      const index = deferred.findIndex((shard) => shard.id === brief.id);
      if (index >= 0) deferred.splice(index, 1);
      selected.push(brief);
    }
  }
  return { selected, deferred };
}

export function createWorkItem(input: {
  runId: string;
  stage: string;
  lane: string;
  inputRefs: string[];
  priority: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  cachePayload: string;
}): BuildWorkItemSummary {
  return {
    id: `work:${stableHash(`${input.runId}:${input.stage}:${input.lane}:${input.inputRefs.join(":")}`)}`,
    stage: input.stage,
    lane: input.lane,
    inputRefs: input.inputRefs,
    status: "queued",
    attempt: 0,
    priority: input.priority,
    estimatedInputTokens: input.estimatedInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    outputRefs: [],
    cacheKey: `cache:${stableHash(`cold-start-${COLD_START_WORKFLOW_VERSION}:${input.stage}:${input.cachePayload}`)}`,
  };
}

function bigrams(value: string) {
  const normalized = normalizeConcept(value);
  if (normalized.length < 2) return normalized ? [normalized] : [];
  return Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2));
}

function similarity(left: string, right: string) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let shared = 0;
  for (const token of a) {
    const index = remaining.indexOf(token);
    if (index < 0) continue;
    shared += 1;
    remaining.splice(index, 1);
  }
  return 2 * shared / (a.length + b.length);
}

/** Greedy task grouping keeps 2-4 related tasks in one derived-model call. */
export function groupTasks(tasks: SemanticDraft["nodes"], maxPerGroup = 4): TaskGroup[] {
  const remaining = tasks.filter((task) => task.type === "task");
  const groups: TaskGroup[] = [];
  while (remaining.length) {
    const seed = remaining.shift()!;
    const candidates = remaining.map((task, index) => ({
      task,
      index,
      score: similarity(`${seed.label}${seed.summary}`, `${task.label}${task.summary}`)
        + (seed.evidenceSegmentIds.some((id) => task.evidenceSegmentIds.includes(id)) ? 0.35 : 0),
    })).sort((left, right) => right.score - left.score);
    const selected = [seed];
    for (const candidate of candidates) {
      if (selected.length >= maxPerGroup || candidate.score < 0.18 && selected.length >= 2) continue;
      selected.push(candidate.task);
    }
    const selectedIds = new Set(selected.map((task) => task.tempId));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (selectedIds.has(remaining[index].tempId)) remaining.splice(index, 1);
    }
    groups.push({
      id: `task-group:${stableHash(selected.map((task) => task.tempId).sort().join(":"))}`,
      tasks: selected,
      evidenceSegmentIds: unique(selected.flatMap((task) => task.evidenceSegmentIds)),
    });
  }
  return groups;
}

export function mentionsForSegments(mentions: ConceptMention[], segmentIds: string[]) {
  const allowed = new Set(segmentIds);
  return mentions.filter((mention) => allowed.has(mention.sourceSegmentId));
}

export function selectSegmentsForTaskGroup(input: {
  group: TaskGroup;
  segments: SourceSegment[];
  mentions: ConceptMention[];
  assets?: SourceAsset[];
  purpose?: "knowledge" | "process";
  maxTokens?: number;
}) {
  const direct = new Set(input.group.evidenceSegmentIds);
  const terms = new Set(input.group.tasks.flatMap((task) => bigrams(`${task.label}${task.summary}`)));
  const assetMap = new Map((input.assets || []).map((asset) => [asset.id, asset]));
  const allowedRoles = input.purpose === "process"
    ? new Set<EvidenceRole>(["role_boundary", "official_standard", "job_market", "work_practice", "workspace_observation"])
    : new Set<EvidenceRole>(["role_boundary", "official_standard", "job_market", "work_practice", "workspace_observation", "technology_primary", "education"]);
  const scored = input.segments.flatMap((segment, ordinal) => {
    const asset = assetMap.get(segment.sourceId);
    if (asset && !direct.has(segment.id) && !asset.qualification?.evidenceRoles.some((role) => allowedRoles.has(role))) return [];
    const normalized = normalizeConcept(segment.text);
    const overlap = [...terms].filter((term) => normalized.includes(term)).length;
    const mentionKinds = mentionsForSegments(input.mentions, [segment.id]).map((mention) => mention.kind);
    const usefulMention = mentionKinds.some((kind) => kind === "knowledge_skill" || kind === "work_event" || kind === "deliverable") ? 6 : 0;
    return [{ segment, ordinal, score: (direct.has(segment.id) ? 100 : 0) + usefulMention + overlap }];
  }).sort((left, right) => right.score - left.score || left.ordinal - right.ordinal);
  const maxTokens = Math.max(2_000, input.maxTokens || 7_500);
  const selected: SourceSegment[] = [];
  let tokens = 0;
  for (const candidate of scored) {
    const size = estimateTokens(candidate.segment.text);
    if (selected.length && tokens + size > maxTokens) continue;
    selected.push(candidate.segment);
    tokens += size;
    if (tokens >= maxTokens || selected.length >= 10) break;
  }
  return selected;
}

export function taskGroupNeedsKnowledgeResearch(group: TaskGroup, mentions: ConceptMention[], assets: SourceAsset[], segments: SourceSegment[]) {
  const primarySourceIds = new Set(assets.filter((asset) => asset.qualification?.evidenceRoles.includes("technology_primary")).map((asset) => asset.id));
  if (!primarySourceIds.size) return true;
  const terms = new Set(group.tasks.flatMap((task) => bigrams(`${task.label}${task.summary}`)));
  const relatedPrimary = segments.some((segment) => {
    if (!primarySourceIds.has(segment.sourceId)) return false;
    const normalized = normalizeConcept(segment.text);
    return [...terms].filter((term) => normalized.includes(term)).length >= 2;
  });
  if (relatedPrimary) return false;
  const direct = new Set(group.evidenceSegmentIds);
  return !mentions.some((mention) => mention.kind === "knowledge_skill" && direct.has(mention.sourceSegmentId));
}
