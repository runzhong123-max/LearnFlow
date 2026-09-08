/** Signed internal requests and encrypted, short-lived execution envelopes. Never persist cookies. */
const encoder = new TextEncoder();
function bytes(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
function b64(value: ArrayBuffer | Uint8Array) { return btoa(Array.from(new Uint8Array(value), b => String.fromCharCode(b)).join("")); }
async function key(secret: string, usage: "sign" | "encrypt") {
  if (secret.length < 32) throw new Error("JOB_WORKER_NOT_CONFIGURED");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`role-job-${usage}:v1:${secret}`));
  return crypto.subtle.importKey("raw", material, usage === "sign" ? { name: "HMAC", hash: "SHA-256" } : "AES-GCM", false, usage === "sign" ? ["sign", "verify"] : ["encrypt", "decrypt"]);
}
export async function signJobWorkerRequest(secret: string, method: string, path: string, timestamp: string) {
  return b64(await crypto.subtle.sign("HMAC", await key(secret, "sign"), encoder.encode(`${method}\n${path}\n${timestamp}`)));
}
export async function verifyJobWorkerRequest(request: Request, secret: string, now = Date.now()) {
  try {
    const stamp = request.headers.get("x-role-worker-time") || "";
    if (!stamp || !Number.isFinite(Number(stamp)) || Math.abs(now - Number(stamp)) > 60_000) return false;
    return await crypto.subtle.verify("HMAC", await key(secret, "sign"), bytes(request.headers.get("x-role-worker-signature") || ""), encoder.encode(`${request.method}\n${new URL(request.url).pathname}\n${stamp}`));
  } catch { return false; }
}
export async function sealJobEnvelope(value: unknown, secret: string, jobId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(jobId) }, await key(secret, "encrypt"), encoder.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(cipher)}`;
}
export async function openJobEnvelope<T>(value: string, secret: string, jobId: string): Promise<T> {
  const [iv, cipher] = value.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: encoder.encode(jobId) }, await key(secret, "encrypt"), bytes(cipher));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
