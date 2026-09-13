import { and, sql, asc, desc, eq } from "drizzle-orm";
import { ensureAppSchema, getD1, getDb } from "@/db";
import { loadLargeText, storeLargeText } from "@/db/large-text";
import { snapshotVersions } from "@/db/schema";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { normalizeRolePackage } from "@/lib/packages/role-package-manifest";
import type { RiskEvent, RiskRunRequest, RiskRunResult } from "@/lib/risk/types";
import { commitStaticSnapshot } from "@/lib/versioning/commit";

export async function getStoredSnapshot(snapshotId: string) {
  await ensureAppSchema();
  const db = getDb();
  const [row] = await db.select().from(snapshotVersions).where(eq(snapshotVersions.snapshotId, snapshotId)).limit(1);
  if (!row) return null;
  const packageJson = await loadLargeText(getD1(), { table: "snapshot_versions", id: snapshotId, column: "package_json" }, row.packageJson);
  if (!packageJson) return null;
  try { return { row, result: normalizeRolePackage(JSON.parse(packageJson) as ColdStartBuildResult) }; }
  catch { return null; }
}
