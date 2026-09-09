import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import { AUTOMATIC_MOUNT_POLICY, type AutomaticMountResult } from "./automatic-contract";
import type { RolePackageRef } from "./contract";

export type AutomaticMountInput = { requestId: string; packageRef: RolePackageRef; projectId: string; projectVersionId: string; sourceRunId: string; policyVersion: typeof AUTOMATIC_MOUNT_POLICY };
export class AutomaticMountError extends Error {
  constructor(message: string, public retryable = false) { super(message); }
}
export async function automaticMountDelegation(secret: string, subject: string, requestId: string, body: string, now = Math.floor(Date.now() / 1000)) {
  if (secret.length < 32 || !/^learnflow:learner:[1-9][0-9]*$/.test(subject)) throw new AutomaticMountError("自动挂载身份或服务配置无效。");
  const claims = { v: 1, iss: "role-atlas", aud: "learnflow-curriculum", sub: subject, iat: now, exp: now + 60, requestId, bodyHash: await sha256Hex(body) };
  const encoded = Buffer.from(canonicalStringify(claims), "utf8").toString("base64url");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
  return `${encoded}.${Buffer.from(signature).toString("hex")}`;
}
export function automaticMountEndpoint(base: string) {
  const url = new URL(base);
  const local = ["localhost", "127.0.0.1", "[::1]", "learnflow-backend"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || !["", "/"].includes(url.pathname)) throw new AutomaticMountError("自动挂载服务必须配置可信源站。");
  url.pathname = "/api/ecosystem/learning-path/automatic";
  return url;
}
export async function requestAutomaticMount(input: AutomaticMountInput, config: { baseUrl: string; secret: string; subject: string; signal?: AbortSignal }, fetcher: typeof fetch = fetch): Promise<AutomaticMountResult> {
  const body = canonicalStringify(input);
  const response = await fetcher(automaticMountEndpoint(config.baseUrl), { method: "POST", redirect: "manual", headers: {
    "content-type": "application/json", "accept": "application/json",
    "X-Role-Atlas-Delegation": await automaticMountDelegation(config.secret, config.subject, input.requestId, body),
  }, body, signal: config.signal || AbortSignal.timeout(60_000) });
  const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  if (reader) try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new AutomaticMountError("自动挂载响应超过限制。"); } chunks.push(next.value); } } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks).toString("utf8");
  let envelope; try { envelope = JSON.parse(raw); } catch { throw new AutomaticMountError("自动挂载服务暂时不可用。", response.status >= 500); }
  if (response.status >= 300 && response.status < 400) throw new AutomaticMountError("自动挂载服务返回了不允许的重定向。");
  if (!response.ok || !envelope.ok) throw new AutomaticMountError("自动挂载未完成，请查看任务状态后重试。", response.status >= 500 || response.status === 409 || envelope.error?.retryable === true);
  if (envelope.protocol !== "learnflow-ecosystem/v1" || envelope.requestId !== input.requestId || canonicalStringify(envelope.data?.packageRef) !== canonicalStringify(input.packageRef)
    || !["completed", "partial", "needs_research"].includes(envelope.data?.status) || !Array.isArray(envelope.data?.points) || !Array.isArray(envelope.data?.receipts) || !Array.isArray(envelope.data?.unresolved)
    || envelope.data.receipts.some((receipt: { masteryUnchanged?: boolean }) => receipt.masteryUnchanged !== true)) throw new AutomaticMountError("自动挂载回执的版本或协议不匹配。");
  return envelope.data as AutomaticMountResult;
}
