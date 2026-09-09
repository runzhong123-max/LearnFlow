type TaskRelease = {
  id: string;
  sourceProjectVersionId: string | null;
  snapshotId: string;
  status: string;
  artifactRootHash: string | null;
  error?: string | null;
};

/** Reuse the displayed immutable version; preparation never publishes to Hub. */
export async function prepareTaskRelease(input: {
  projectId: string;
  projectVersionId: string;
  snapshotId: string;
  signal: AbortSignal;
}, request: typeof fetch = fetch): Promise<string> {
  const matches = (release: TaskRelease) => release.sourceProjectVersionId === input.projectVersionId
    && release.snapshotId === input.snapshotId && ["ready", "published"].includes(release.status)
    && Boolean(release.artifactRootHash);
  const response = await request(`/api/releases?projectId=${encodeURIComponent(input.projectId)}`, { signal: input.signal });
  if (!response.ok) throw new Error("无法读取当前岗位包，请检查登录状态后重试。");
  const existing = await response.json() as { releases?: TaskRelease[] };
  const release = existing.releases?.find(matches);
  if (release) return release.id;

  // Stable per source version: retrying cannot silently create a new package version.
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([input.projectId, input.projectVersionId, input.snapshotId])));
  const version = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  const prepared = await request("/api/releases", {
    method: "POST", signal: input.signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "prepare", projectId: input.projectId, projectVersionId: input.projectVersionId,
      packageVersion: `0.0.0-conversion.${version}`, visibility: "private", evidencePolicy: "metadata" }),
  });
  const payload = await prepared.json() as { release?: TaskRelease; error?: string };
  if (!prepared.ok || !payload.release || !matches(payload.release)) {
    throw new Error(payload.release?.error || payload.error || "当前版本未通过岗位包校验，请先完善任务后重试。");
  }
  return payload.release.id;
}
