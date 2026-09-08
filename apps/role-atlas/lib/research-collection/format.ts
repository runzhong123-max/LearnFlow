export const COLLECTION_VERSION = "role-research-archive/v1";
const secretKey = /^(?:api[_-]?key|authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|password|secret|credentials|providerConfig|searchConfig)$/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED]" : redact(item)]));
  if (typeof value === "string") return value.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]").replace(/\bsk-[a-zA-Z0-9_-]{16,}/g, "[REDACTED_API_KEY]");
  return value;
}
export function parse(value: unknown) { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }
export function decodeRow(row: Record<string, unknown>) { return Object.fromEntries(Object.entries(row).map(([k,v]) => [k.replace(/_json$/, ""), k.endsWith("_json") ? parse(v) : v])); }
export function safeName(value: string) { return value.replace(/[^a-zA-Z0-9_.-]/g,"_").slice(0,120) || "item"; }
export async function sha256(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map(b => b.toString(16).padStart(2,"0")).join(""); }
export function bounded(value: string, limit = 160_000) { return { text: value.slice(0, limit), truncated: value.length > limit, originalCharacters: value.length }; }

// Injective path encoding avoids collisions between legacy IDs such as a:b and a_b.
export function pathToken(value:string){return encodeURIComponent(value).replace(/\./g,"%2E");}

export function removeCredential(value:unknown,credential:string):unknown {
 if(!credential)return value;
 if(typeof value==="string")return value.split(credential).join("[REDACTED]");
 if(Array.isArray(value))return value.map(item=>removeCredential(item,credential));
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,removeCredential(item,credential)]));
 return value;
}
