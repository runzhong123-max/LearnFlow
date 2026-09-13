/** Use the authorized envelope ID, never a snapshot's upstream project ID. */
export function workspaceProjectIdentity(routeId: string | undefined, projectId?: string) {
  if (!projectId || routeId === projectId) return routeId;
  try {
    if (routeId && decodeURIComponent(routeId) === projectId) return projectId;
  } catch { /* A malformed route must not adopt a different project. */ }
  throw new Error("PROJECT_SCOPE_MISMATCH");
}
