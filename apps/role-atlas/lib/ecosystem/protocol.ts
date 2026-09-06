import { z } from "zod/v4";
import { sha256Hex } from "@/lib/versioning/canonical";
export const PROTOCOL = "learnflow-ecosystem/v1";
export const operations = ["catalog.search", "package.resolve", "role.query", "agent.run", "agent.get_run", "learning.resolve", "learning.validate_extension", "learning.validate_alignment"] as const;
export const requestSchema = z.object({ protocol: z.literal(PROTOCOL), operation: z.enum(operations), requestId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9:._-]+$/), payload: z.record(z.string(), z.unknown()) }).strict();
export type GatewayRequest = z.infer<typeof requestSchema>;
export const packageRefSchema = z.object({ packageId: z.string().min(1).max(256), packageVersion: z.string().min(1).max(128), snapshotId: z.string().min(1).max(256), rootHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const claimsSchema = z.object({ v: z.literal(1), iss: z.literal("learnflow"), aud: z.literal("role-atlas"), sub: z.string().regex(/^learnflow:learner:[1-9][0-9]*$/), role: z.enum(["user", "admin"]), iat: z.number().int(), exp: z.number().int(), requestId: z.string(), bodyHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type Actor = Pick<z.infer<typeof claimsSchema>, "sub" | "role">;
export class GatewayError extends Error { constructor(public code: string, public status = 400, public retryable = false) { super(code); } }
export async function verifyDelegation(token: string | null, raw: string, request: GatewayRequest, secret: string, now = Math.floor(Date.now() / 1000)): Promise<Actor> {
  if (secret.length < 32) throw new GatewayError("GATEWAY_NOT_CONFIGURED", 503);
  if (!token || token.length > 3000) throw new GatewayError("DELEGATION_REQUIRED", 401);
  const [encoded, signature, extra] = token.split(".");
  if (extra !== undefined || !encoded || !/^[a-zA-Z0-9_-]+$/.test(encoded) || !/^[a-f0-9]{64}$/.test(signature || "")) throw new GatewayError("DELEGATION_INVALID", 401);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const verified = await crypto.subtle.verify("HMAC", key, Uint8Array.from(signature.match(/../g)!, x => parseInt(x, 16)), new TextEncoder().encode(encoded));
  if (!verified) throw new GatewayError("DELEGATION_INVALID", 401);
  let claims: z.infer<typeof claimsSchema>;
  try { claims = claimsSchema.parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), x => x.charCodeAt(0))))); }
  catch { throw new GatewayError("DELEGATION_INVALID", 401); }
  if (claims.iat > now + 5 || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 60 || claims.requestId !== request.requestId || claims.bodyHash !== await sha256Hex(raw)) throw new GatewayError("DELEGATION_INVALID", 401);
  return { sub: claims.sub, role: claims.role };
}
export async function readBoundedBody(request: Request, max = 4 * 1024 * 1024) {
  if (!request.body) throw new GatewayError("EMPTY_BODY");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) { await reader.cancel(); throw new GatewayError("BODY_TOO_LARGE", 413); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new GatewayError("INVALID_UTF8"); }
}
