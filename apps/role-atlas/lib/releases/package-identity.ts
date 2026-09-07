const PROJECT_PACKAGE_PREFIX = "role-package:project:";

/** New package ownership is anchored to the project, never to a shared role title. */
export async function projectReleasePackageId(d1: Pick<D1Database, "prepare">, input: { projectId: string; packageId?: string }) {
  const canonicalId = `${PROJECT_PACKAGE_PREFIX}${input.projectId}`;
  if (input.packageId) {
    if (input.packageId.startsWith(PROJECT_PACKAGE_PREFIX) && input.packageId !== canonicalId) throw new Error("PACKAGE_ID_PROJECT_MISMATCH");
    return input.packageId;
  }
  // Preserve an existing project's published identity; this does not migrate or take ownership of a line.
  const existing = await d1.prepare(`SELECT l.package_id FROM package_releases r JOIN package_lines l ON l.id=r.package_line_id
    WHERE r.project_id=? ORDER BY r.created_at DESC, r.id DESC LIMIT 1`).bind(input.projectId).first<{ package_id: string }>();
  return existing?.package_id || canonicalId;
}
