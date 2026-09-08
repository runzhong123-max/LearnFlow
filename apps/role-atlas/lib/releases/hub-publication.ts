import type { StaticRolePackageBundle } from "@/lib/packages/types";
import { assertReleaseQuality, validateReleaseArtifact } from "./quality";

/** Mutable publication policy; immutable releases and their content hashes stay intact. */
export async function changeHubPublication(d1: D1Database, input: {
  packageLineId: string; action: "withdraw_from_hub" | "restore_to_hub";
  expectedRegistryVersion: number; expectedReleaseId: string;
}) {
  const line = await d1.prepare(`SELECT id, visibility, registry_version, recommended_release_id FROM package_lines WHERE id=?`)
    .bind(input.packageLineId).first<{ id: string; visibility: string; registry_version: number; recommended_release_id: string | null }>();
  if (!line) throw new Error("PACKAGE_LINE_NOT_FOUND");
  if (line.recommended_release_id !== input.expectedReleaseId) throw new Error("PUBLICATION_CONFLICT");
  const visibility = input.action === "withdraw_from_hub" ? "private" : "public";
  // Idempotent retries must not append another event or advance the registry version.
  if (line.visibility === visibility) return { ...line, changed: false };
  if (line.registry_version !== input.expectedRegistryVersion) throw new Error("PUBLICATION_CONFLICT");
  const release = await d1.prepare(`SELECT r.project_id, r.status, r.published_at,
    json_extract(a.content, '$.manifest.visibility') AS artifact_visibility, a.content AS artifact_content
    FROM package_releases r JOIN package_artifacts a ON a.root_hash=r.artifact_root_hash
    WHERE r.id=? AND r.package_line_id=?`).bind(input.expectedReleaseId, line.id)
    .first<{ project_id: string | null; status: string; published_at: string | null; artifact_visibility: string; artifact_content: string }>();
  if (!release || release.status !== "published" || !release.published_at || release.artifact_visibility !== "public") throw new Error("PUBLIC_RELEASE_REQUIRED");
  if (input.action === "restore_to_hub") {
    const bundle = JSON.parse(release.artifact_content) as StaticRolePackageBundle;
    assertReleaseQuality(await validateReleaseArtifact(bundle));
  }
  const now = new Date().toISOString();
  const guard = `id=? AND registry_version=? AND recommended_release_id=? AND visibility=?`;
  const args = [line.id, line.registry_version, input.expectedReleaseId, line.visibility];
  const results = await d1.batch([
    d1.prepare(`INSERT INTO release_events (release_id,package_line_id,project_id,action,actor_kind,detail_json,created_at)
      SELECT ?,?, ?,?, 'user',?,? WHERE EXISTS (SELECT 1 FROM package_lines WHERE ${guard})`)
      .bind(input.expectedReleaseId,line.id,release.project_id,input.action === "withdraw_from_hub" ? "release.hub_withdrawn" : "release.hub_restored",
        JSON.stringify({ previousVisibility: line.visibility, visibility }),now,...args),
    d1.prepare(`UPDATE package_lines SET visibility=?,registry_version=registry_version+1,updated_at=? WHERE ${guard}`)
      .bind(visibility,now,...args),
  ]);
  if (results[1].meta.changes !== 1) throw new Error("PUBLICATION_CONFLICT");
  return { ...line, visibility, registry_version: line.registry_version + 1, changed: true };
}
