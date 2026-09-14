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
  projectVersionId?: string;
  snapshotId: string;
  signal: AbortSignal;
}, request: typeof fetch = fetch): Promise<string> {
  const matches = (release: TaskRelease) => (!input.projectVersionId || release.sourceProjectVersionId === input.projectVersionId)
    && release.snapshotId === input.snapshotId && ["ready", "published"].includes(release.status)
    && Boolean(release.artifactRootHash);
  const response = await request(`/api/releases?projectId=${encodeURIComponent(input.projectId)}`, { signal: input.signal });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("无法读取当前岗位包，请检查登录状态后重试。");
    if (response.status === 404) throw new Error("当前岗位项目或岗位包不存在，请重新打开项目后重试。");
    throw new Error(`无法读取当前岗位包（${response.status}），请稍后重试。`);
  }
  const existing = await response.json() as { releases?: TaskRelease[] };
  const release = existing.releases?.find(matches);
  if (release) return release.id;

  const prepared = await request("/api/releases", {
    method: "POST", signal: input.signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "prepare_personal", snapshotId: input.snapshotId, projectId: input.projectId, projectVersionId: input.projectVersionId }),
  });
  const payload = await prepared.json() as { release?: TaskRelease; error?: string };
  if (!prepared.ok || !payload.release || !matches(payload.release)) {
    throw new Error(payload.release?.error || payload.error || "当前版本未通过岗位包校验，请先完善任务后重试。");
  }
  return payload.release.id;
}
