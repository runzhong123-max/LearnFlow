import { createHash, createHmac } from "node:crypto";

export const MAX_LAUNCH_TOKEN_LENGTH = 8192;
export const MAX_TASK_SUMMARY_CHARACTERS = 400;

// Same canonical contract as lib/versioning/canonical.ts. The standalone cohost
// process cannot import the TypeScript application; parity is regression tested.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("NON_FINITE_NUMBER");
  return value;
}
const hash = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Verify the established static-role-package hashes and exact release identity. */
export function validateLaunchBundle(bundle, expectedRef) {
  const manifest = bundle?.manifest;
  if (!object(manifest) || !object(bundle.components) || !object(manifest.hashes)
    || !object(manifest.entrypoints) || !object(expectedRef)
    || manifest.packageProtocol !== "static-role-package"
    || !["2.0.0", "3.0.0"].includes(manifest.protocolVersion)) throw new Error("RELEASE_ARTIFACT_INVALID");
  for (const key of ["packageId", "packageVersion", "snapshotId", "rootHash"]) {
    if (typeof expectedRef[key] !== "string" || !expectedRef[key] || expectedRef[key] !== manifest[key]) {
      throw new Error("RELEASE_ARTIFACT_IDENTITY_MISMATCH");
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(manifest.rootHash)
    || hash(JSON.stringify(canonical({ ...manifest, rootHash: "" }))) !== manifest.rootHash) {
    throw new Error("RELEASE_ARTIFACT_HASH_MISMATCH");
  }
  for (const [path, expected] of Object.entries(manifest.hashes)) {
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected)
      || !Object.hasOwn(bundle.components, path) || typeof bundle.components[path] !== "string"
      || hash(bundle.components[path]) !== expected) throw new Error("RELEASE_COMPONENT_HASH_MISMATCH");
  }
  for (const key of ["semanticGraph", "snapshot"]) {
    const path = manifest.entrypoints[key];
    if (typeof path !== "string" || !Object.hasOwn(manifest.hashes, path)) throw new Error("RELEASE_ENTRYPOINT_UNPINNED");
  }
  let snapshot;
  try { snapshot = JSON.parse(bundle.components[manifest.entrypoints.snapshot]); }
  catch { throw new Error("RELEASE_SNAPSHOT_INVALID"); }
  if (snapshot?.snapshot?.id !== manifest.snapshotId) throw new Error("RELEASE_ARTIFACT_IDENTITY_MISMATCH");
}

export function normalizeLaunchTask(task) {
  if (!object(task) || typeof task.nodeId !== "string" || !task.nodeId || task.nodeId.length > 240) throw new Error("TASK_NODE_REQUIRED");
  if (typeof task.label !== "string" || !task.label.trim() || task.label.length > 300) throw new Error("TASK_LABEL_INVALID");
  if (typeof task.summary !== "string") throw new Error("TASK_SUMMARY_INVALID");
  const characters = Array.from(task.summary);
  const summaryTruncated = characters.length > MAX_TASK_SUMMARY_CHARACTERS || task.summaryTruncated === true;
  return { nodeId: task.nodeId, label: task.label, summary: characters.slice(0, MAX_TASK_SUMMARY_CHARACTERS).join(""),
    ...(summaryTruncated ? { summaryTruncated: true } : {}) };
}

/** Resolve the selected task from a verified immutable release, never browser text. */
export function selectedLaunchTask(bundle, nodeId, expectedRef) {
  if (typeof nodeId !== "string" || !nodeId || nodeId.length > 240) throw new Error("TASK_NODE_REQUIRED");
  validateLaunchBundle(bundle, expectedRef);
  let graph;
  try { graph = JSON.parse(bundle.components[bundle.manifest.entrypoints.semanticGraph]); }
  catch { throw new Error("RELEASE_GRAPH_INVALID"); }
  const matches = Array.isArray(graph?.nodes) ? graph.nodes.filter((node) => object(node) && node.id === nodeId) : [];
  const node = matches.length === 1 ? matches[0] : undefined;
  if (!node || !["task", "typical_task"].includes(node.type)) throw new Error("TASK_NOT_IN_PINNED_RELEASE");
  return normalizeLaunchTask({ nodeId, label: node.label, summary: typeof node.summary === "string" ? node.summary : "" });
}

/** Both signing surfaces share the receiver's bound on the encoded ASCII token. */
export function encodeLaunchPayload(payload, secret) {
  const value = typeof secret === "string" ? secret.trim() : "";
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error("ROLE_PACKAGE_LAUNCH_SECRET_INVALID");
  const normalized = payload.intent === "work_task_conversion" ? { ...payload, taskRef: normalizeLaunchTask(payload.taskRef) } : payload;
  const body = Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
  const signature = createHmac("sha256", value).update(body).digest("base64url");
  const token = `${body}.${signature}`;
  if (token.length > MAX_LAUNCH_TOKEN_LENGTH) throw new Error("ROLE_PACKAGE_LAUNCH_TOKEN_TOO_LARGE");
  return token;
}

export function conversionLaunchUrl(baseValue, token) {
  const base = new URL(baseValue);
  if (base.username || base.password || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))) throw new Error("CONVERSION_PUBLIC_URL_INVALID");
  base.pathname = "/convert";
  base.search = "";
  base.hash = new URLSearchParams({ role_token: token }).toString();
  return base.toString();
}
