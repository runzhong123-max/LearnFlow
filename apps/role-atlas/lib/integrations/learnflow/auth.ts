export type LearnFlowIdentity = {
  issuer: "learnflow";
  subjectId: string;
  accountId: number;
  learnerId: number;
  username: string;
  displayName: string;
  role: "user" | "admin";
};

type LearnFlowAuthPayload = {
  id?: unknown;
  learner_id?: unknown;
  username?: unknown;
  display_name?: unknown;
  role?: unknown;
};

function normalizedBaseUrl(value: string) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1", "learnflow-backend"].includes(url.hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3})\.(?:\d{1,3})$/u.test(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("LEARNFLOW_AUTH_BASE_URL_INVALID");
  }
  url.search = "";
  url.hash = "";
  return url;
}

export async function resolveLearnFlowIdentity(input: {
  request: Request;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LearnFlowIdentity | null> {
  const base = normalizedBaseUrl(input.baseUrl);
  // Assign a pathname: a root base otherwise produces //api/auth/me,
  // which URL resolves as a new host and forwards credentials there.
  const endpoint = new URL(base);
  endpoint.pathname = `${base.pathname.replace(/\/+$/u, "")}/api/auth/me`;
  const headers = new Headers({ Accept: "application/json" });
  for (const name of ["cookie", "authorization", "x-learnflow-desktop-token"] as const) {
    const value = input.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("cookie") && !headers.has("authorization") && !headers.has("x-learnflow-desktop-token")) return null;
  const response = await (input.fetchImpl || fetch)(endpoint, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(Math.min(10_000, Math.max(500, input.timeoutMs || 3_000))),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`LEARNFLOW_AUTH_UNAVAILABLE:${response.status}`);
  const payload = await response.json() as LearnFlowAuthPayload;
  if (!Number.isInteger(payload.id) || Number(payload.id) <= 0 || !Number.isInteger(payload.learner_id) || Number(payload.learner_id) <= 0) {
    throw new Error("LEARNFLOW_AUTH_RESPONSE_INVALID");
  }
  if (typeof payload.username !== "string" || typeof payload.display_name !== "string" || !["user", "admin"].includes(String(payload.role))) {
    throw new Error("LEARNFLOW_AUTH_RESPONSE_INVALID");
  }
  return {
    issuer: "learnflow",
    subjectId: `learnflow:learner:${payload.learner_id}`,
    accountId: Number(payload.id),
    learnerId: Number(payload.learner_id),
    username: payload.username,
    displayName: payload.display_name,
    role: payload.role as "user" | "admin",
  };
}
