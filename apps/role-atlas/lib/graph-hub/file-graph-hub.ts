import { classifyHubEntry } from "../hub/taxonomy";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import type {
  GraphHubCatalog,
  GraphHubCatalogEntry,
  GraphHubDocument,
  GraphHubKind,
  GraphHubPolicy,
  GraphHubSearchResult,
  GraphHubSubmission,
} from "./types";

const POLICY_FILE = "graph-hub-policy.json";
const CATALOG_FILE = "catalog.json";
const SUBJECT = /^[0-9A-Za-z][0-9A-Za-z._:@/-]{2,159}$/u;
const ID = /^[0-9A-Za-z][0-9A-Za-z._:@/-]{1,179}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,79}$/u;

function assertSubject(value: string) {
  if (!SUBJECT.test(value)) throw new Error("INVALID_GRAPH_HUB_SUBJECT");
}

function validateDocument(value: unknown): GraphHubDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GRAPH_DOCUMENT_INVALID");
  const document = value as GraphHubDocument;
  if (document.protocol !== "graph-hub-document.v1" || !ID.test(document.graphId || "") || !VERSION.test(document.version || "")) {
    throw new Error("GRAPH_DOCUMENT_IDENTITY_INVALID");
  }
  if (!["learning_path", "role_semantic", "role_process", "knowledge", "custom"].includes(document.graphType)) {
    throw new Error("GRAPH_DOCUMENT_TYPE_INVALID");
  }
  if (!document.title?.trim() || document.title.length > 180 || document.summary.length > 1_500) throw new Error("GRAPH_DOCUMENT_METADATA_INVALID");
  if (!Array.isArray(document.keywords) || document.keywords.length > 40 || document.keywords.some((item) => !item || item.length > 80)) {
    throw new Error("GRAPH_DOCUMENT_KEYWORDS_INVALID");
  }
  if (!Array.isArray(document.nodes) || document.nodes.length > 2_000 || !Array.isArray(document.edges) || document.edges.length > 8_000) {
    throw new Error("GRAPH_DOCUMENT_SIZE_INVALID");
  }
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    if (!ID.test(node.id || "") || !node.label?.trim() || node.label.length > 180 || !node.type?.trim() || nodeIds.has(node.id)) {
      throw new Error("GRAPH_DOCUMENT_NODE_INVALID");
    }
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (!ID.test(edge.id || "") || edgeIds.has(edge.id) || !nodeIds.has(edge.source) || !nodeIds.has(edge.target) || !edge.type?.trim()) {
      throw new Error("GRAPH_DOCUMENT_EDGE_INVALID");
    }
    edgeIds.add(edge.id);
  }
  return document;
}

async function writeExclusive(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

async function writeAtomic(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

async function readPolicy(root: string) {
  const policy = JSON.parse(await readFile(join(root, POLICY_FILE), "utf8")) as GraphHubPolicy;
  if (policy.protocol !== "graph-hub-policy.v1") throw new Error("GRAPH_HUB_POLICY_UNSUPPORTED");
  return policy;
}

async function readSubmissions(root: string) {
  const directory = join(root, "submissions");
  let files: string[] = [];
  try { files = (await readdir(directory)).filter((item) => item.endsWith(".json")).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as GraphHubSubmission));
}

async function entryFor(root: string, submission: GraphHubSubmission, audienceSubjectId?: string): Promise<GraphHubCatalogEntry | undefined> {
  const publicEntry = submission.kind === "official" || submission.reviewStatus === "approved";
  const ownerEntry = audienceSubjectId === submission.ownerSubjectId;
  if (!publicEntry && !ownerEntry) return undefined;
  const document = validateDocument(JSON.parse(await readFile(join(root, submission.objectPath), "utf8")));
  return {
    categories: classifyHubEntry({ title: submission.title, summary: submission.summary }),
    graphId: submission.graphId,
    graphVersion: submission.graphVersion,
    graphType: submission.graphType,
    title: submission.title,
    summary: submission.summary,
    keywords: submission.keywords,
    ownerSubjectId: submission.ownerSubjectId,
    maintainerName: submission.maintainerName,
    kind: submission.kind,
    review: submission.kind === "official" ? "official"
      : submission.reviewStatus === "approved" ? "approved"
        : submission.reviewStatus === "pending" ? "pending_owner" : "rejected_owner",
    access: publicEntry ? "public" : "owner",
    objectHash: submission.objectHash,
    objectPath: submission.objectPath,
    submittedAt: submission.submittedAt,
    reviewedAt: submission.reviewedAt,
    nodeIndex: document.nodes.slice(0, 500),
  };
}

async function catalogHash(catalog: Omit<GraphHubCatalog, "rootHash">) {
  return sha256Hex(canonicalStringify({ ...catalog, generatedAt: "", rootHash: "" }));
}

async function buildCatalog(root: string, audienceSubjectId?: string) {
  const entries = (await Promise.all((await readSubmissions(root)).map((item) => entryFor(root, item, audienceSubjectId))))
    .filter((item): item is GraphHubCatalogEntry => Boolean(item))
    .sort((left, right) => `${left.graphId}@${left.graphVersion}`.localeCompare(`${right.graphId}@${right.graphVersion}`));
  const core: Omit<GraphHubCatalog, "rootHash"> = {
    protocol: "graph-hub-catalog.v1",
    generatedAt: new Date().toISOString(),
    ...(audienceSubjectId ? { audienceSubjectId } : {}),
    entries,
  };
  return { ...core, rootHash: await catalogHash(core) } satisfies GraphHubCatalog;
}

export async function initializeGraphHub(input: { hubRoot: string; policy: GraphHubPolicy }) {
  const root = resolve(input.hubRoot);
  if (input.policy.protocol !== "graph-hub-policy.v1") throw new Error("GRAPH_HUB_POLICY_UNSUPPORTED");
  input.policy.officialMaintainerSubjects.forEach(assertSubject);
  input.policy.reviewerSubjects.forEach(assertSubject);
  await mkdir(join(root, "objects", "sha256"), { recursive: true });
  await mkdir(join(root, "submissions"), { recursive: true });
  try { await access(join(root, POLICY_FILE), constants.F_OK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeExclusive(join(root, POLICY_FILE), `${canonicalStringify(input.policy)}\n`);
  }
  const catalog = await buildCatalog(root);
  await writeAtomic(join(root, CATALOG_FILE), `${canonicalStringify(catalog)}\n`);
  return { protocol: "graph-hub-init.v1" as const, hubRoot: root };
}

export async function submitGraphToHub(input: {
  hubRoot: string;
  graphFile: string;
  ownerSubjectId: string;
  maintainerName: string;
  kind: GraphHubKind;
}) {
  assertSubject(input.ownerSubjectId);
  const root = resolve(input.hubRoot);
  const policy = await readPolicy(root);
  if (input.kind === "official" && !policy.officialMaintainerSubjects.includes(input.ownerSubjectId)) {
    throw new Error("GRAPH_HUB_OFFICIAL_MAINTAINER_REQUIRED");
  }
  const raw = await readFile(resolve(input.graphFile), "utf8");
  const document = validateDocument(JSON.parse(raw));
  const objectHash = await sha256Hex(canonicalStringify(document));
  const objectPath = `objects/sha256/${objectHash}.graph.json`;
  const objectFile = join(root, objectPath);
  const canonical = `${canonicalStringify(document)}\n`;
  try { await writeExclusive(objectFile, canonical); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(objectFile, "utf8") !== canonical) throw new Error("GRAPH_HUB_HASH_COLLISION");
  }
  const submissionId = `graph-submission-${(await sha256Hex(`${input.ownerSubjectId}\0${document.graphId}\0${document.version}\0${objectHash}`)).slice(0, 24)}`;
  const now = new Date().toISOString();
  const submission: GraphHubSubmission = {
    protocol: "graph-hub-submission.v1",
    submissionId,
    graphId: document.graphId,
    graphVersion: document.version,
    graphType: document.graphType,
    title: document.title,
    summary: document.summary,
    keywords: document.keywords,
    ownerSubjectId: input.ownerSubjectId,
    maintainerName: input.maintainerName.slice(0, 160),
    kind: input.kind,
    reviewStatus: input.kind === "official" ? "approved" : "pending",
    objectHash,
    objectPath,
    submittedAt: now,
    ...(input.kind === "official" ? { reviewedAt: now, reviewerSubjectId: input.ownerSubjectId, reviewNotes: "official maintainer submission" } : {}),
  };
  const file = join(root, "submissions", `${submissionId}.json`);
  try { await writeExclusive(file, `${canonicalStringify(submission)}\n`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(file, "utf8")) as GraphHubSubmission;
    if (existing.objectHash !== objectHash || existing.ownerSubjectId !== input.ownerSubjectId || existing.kind !== input.kind) {
      throw new Error("GRAPH_HUB_SUBMISSION_CONFLICT");
    }
    return existing;
  }
  const catalog = await buildCatalog(root);
  await writeAtomic(join(root, CATALOG_FILE), `${canonicalStringify(catalog)}\n`);
  return submission;
}

export async function reviewGraphHubSubmission(input: {
  hubRoot: string;
  submissionId: string;
  reviewerSubjectId: string;
  decision: "approve" | "reject";
  notes?: string;
}) {
  assertSubject(input.reviewerSubjectId);
  if (!/^graph-submission-[0-9a-f]{24}$/u.test(input.submissionId)) throw new Error("GRAPH_HUB_SUBMISSION_ID_INVALID");
  const root = resolve(input.hubRoot);
  const policy = await readPolicy(root);
  if (!policy.reviewerSubjects.includes(input.reviewerSubjectId)) throw new Error("GRAPH_HUB_REVIEWER_REQUIRED");
  const file = join(root, "submissions", `${input.submissionId}.json`);
  const submission = JSON.parse(await readFile(file, "utf8")) as GraphHubSubmission;
  if (submission.kind !== "personal" || submission.reviewStatus !== "pending") throw new Error("GRAPH_HUB_SUBMISSION_NOT_REVIEWABLE");
  if (submission.ownerSubjectId === input.reviewerSubjectId) throw new Error("GRAPH_HUB_SELF_REVIEW_FORBIDDEN");
  const reviewed: GraphHubSubmission = {
    ...submission,
    reviewStatus: input.decision === "approve" ? "approved" : "rejected",
    reviewerSubjectId: input.reviewerSubjectId,
    reviewedAt: new Date().toISOString(),
    reviewNotes: input.notes?.slice(0, 2_000) || "",
  };
  await writeAtomic(file, `${canonicalStringify(reviewed)}\n`);
  const catalog = await buildCatalog(root);
  await writeAtomic(join(root, CATALOG_FILE), `${canonicalStringify(catalog)}\n`);
  return reviewed;
}

export async function exportGraphHubView(input: { hubRoot: string; outputFile: string; actorSubjectId?: string }) {
  if (input.actorSubjectId) assertSubject(input.actorSubjectId);
  const catalog = await buildCatalog(resolve(input.hubRoot), input.actorSubjectId);
  await writeAtomic(resolve(input.outputFile), `${canonicalStringify(catalog)}\n`);
  return catalog;
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9+#\u3400-\u9fff]+/gu, "");
}

function terms(value: string) {
  const normalized = normalize(value);
  const result = new Set((value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9+#._-]*/gu) || []).map(normalize));
  for (const run of normalized.match(/[\u3400-\u9fff]+/gu) || []) {
    result.add(run);
    for (const char of run) result.add(char);
    for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2));
  }
  return [...result].filter(Boolean);
}

function textScore(queryTerms: string[], text: string) {
  const target = normalize(text);
  return queryTerms.reduce((sum, term) => sum + (target === term ? 12 : target.includes(term) ? Math.min(8, 2 + term.length) : 0), 0);
}

export function searchGraphHubCatalog(catalog: GraphHubCatalog, input: { query: string; actorSubjectId?: string; limit?: number; category?: string }): GraphHubSearchResult[] {
  if (catalog.audienceSubjectId && catalog.audienceSubjectId !== input.actorSubjectId) throw new Error("GRAPH_HUB_AUDIENCE_MISMATCH");
  const queryTerms = terms(input.query).slice(0, 40);

  return catalog.entries.flatMap((entry) => {
    if (entry.access === "owner" && entry.ownerSubjectId !== input.actorSubjectId) return [];
    const categories = classifyHubEntry({ title: entry.title, summary: entry.summary, categories: entry.categories });
    if (input.category && !categories.includes(input.category)) return [];
    const metadataScore = textScore(queryTerms, [entry.title, entry.summary, ...entry.keywords, ...categories].join(" "));
    const matchedNodes = entry.nodeIndex.map((node) => ({
      ...node,
      score: textScore(queryTerms, [node.label, node.summary || "", ...(node.aliases || []), ...(node.tags || [])].join(" ")),
    })).filter((node) => node.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, 6);
    const score = metadataScore * 2 + matchedNodes.reduce((sum, node) => sum + node.score, 0);
    if (queryTerms.length && score <= 0) return [];
    const searchable = normalize([entry.title, entry.summary, ...entry.keywords, ...categories, ...matchedNodes.map((node) => node.label)].join(" "));
    return [{ entry: { ...entry, categories }, score, matchedTerms: queryTerms.filter((term) => searchable.includes(term)).slice(0, 12), matchedNodes }];
  }).sort((left, right) => right.score - left.score || left.entry.graphId.localeCompare(right.entry.graphId)).slice(0, Math.min(20, Math.max(1, input.limit || 8)));
}

export async function searchGraphHubFile(input: { catalogFile: string; query: string; actorSubjectId?: string; limit?: number; category?: string }) {
  const catalog = JSON.parse(await readFile(resolve(input.catalogFile), "utf8")) as GraphHubCatalog;
  if (catalog.protocol !== "graph-hub-catalog.v1") throw new Error("GRAPH_HUB_CATALOG_UNSUPPORTED");
  const { rootHash, ...core } = catalog;
  const expected = await catalogHash(core);
  if (expected !== rootHash) throw new Error("GRAPH_HUB_CATALOG_HASH_MISMATCH");
  return searchGraphHubCatalog(catalog, input);
}
