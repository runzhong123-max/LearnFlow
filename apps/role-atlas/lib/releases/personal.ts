import { ensureAppSchema, getD1 } from "@/db";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { commitProjectVersion, commitStaticSnapshot, getProjectVersionRecord } from "@/lib/versioning/commit";
import { sha256Hex } from "@/lib/versioning/canonical";
import { prepareRelease } from "./service";

/** After project authorization, freeze the visible durable preview without adopting it. */
export async function preparePersonalRelease(input: { projectId: string; snapshotId: string; projectVersionId?: string }) {
  await ensureAppSchema();
  const d1 = getD1();
  let versionId = input.projectVersionId;
  if (!versionId) {
    const stored = await d1.prepare("SELECT id FROM project_versions WHERE project_id=? AND snapshot_id=? ORDER BY created_at,id LIMIT 1")
      .bind(input.projectId, input.snapshotId).first<{ id: string }>();
    versionId = stored?.id;
  }
  if (!versionId) {
    const event = await d1.prepare(`SELECT event_json FROM build_events WHERE project_id=?
      AND json_valid(event_json) AND json_extract(event_json,'$.payload.result.snapshot.id')=?
      ORDER BY id DESC LIMIT 1`).bind(input.projectId, input.snapshotId).first<{ event_json: string }>();
    const result = event ? JSON.parse(event.event_json).payload?.result as ColdStartBuildResult : null;
    if (!result || result.projectId !== input.projectId || result.snapshot.id !== input.snapshotId) {
      throw new Error("当前可见岗位内容未能从项目记录中读取，请刷新项目后重试。");
    }
    const sourceRunId = `personal:${await sha256Hex(JSON.stringify([input.projectId, input.snapshotId]))}`;
    // Retain visible stable node IDs rather than remapping them to a newer head.
    await commitStaticSnapshot({ result, sourceRunId });
    const version = await commitProjectVersion({ projectId: input.projectId, result, sourceRunId,
      sourceKind: "workspace", adopt: false, reuseSnapshotId: input.snapshotId,
      message: "保存当前可见岗位内容到个人岗位包", authorKind: "user" });
    versionId = version.id;
  }
  const version = await getProjectVersionRecord(input.projectId, versionId);
  if (!version || version.snapshotId !== input.snapshotId) throw new Error("VERSION_SNAPSHOT_CONFLICT");
  const key = await sha256Hex(JSON.stringify([input.projectId, version.id, input.snapshotId]));
  return prepareRelease({ projectId: input.projectId, projectVersionId: version.id,
    packageVersion: `0.0.0-personal.${key}`, visibility: "private", evidencePolicy: "metadata", sourceUse: "personal_reference" });
}
