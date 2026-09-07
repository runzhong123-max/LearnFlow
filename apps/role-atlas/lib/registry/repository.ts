import { asc, desc, eq, like, or } from "drizzle-orm";
import { ensureAppSchema, getD1, getDb } from "@/db";
import { maintainers, packageLines, packageReleases, roleIdentities } from "@/db/schema";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { domainId } from "@/lib/versioning/canonical";
import type { RegistryMetadata } from "./types";

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; }
  catch { return fallback; }
}

export async function ensureRegistryPackageLine(input: {
  result: ColdStartBuildResult;
  packageId?: string;
  metadata?: RegistryMetadata;
}) {
  await ensureAppSchema();
  const db = getDb();
  const packageId = input.packageId || input.result.packages.rolePackage.packageId;
  const [existing] = await db.select().from(packageLines).where(eq(packageLines.packageId, packageId)).limit(1);
  if (existing) return existing;

  const roleNode = input.result.semantic.nodes.find((node) => node.type === "market_role");
  const aliases = roleNode?.aliases || [];
  const roleTitle = input.result.brief.roleTitle;
  let [identity] = await db.select().from(roleIdentities).where(eq(roleIdentities.canonicalName, roleTitle)).limit(1);
  if (!identity) {
    const id = domainId("role-identity");
    await db.insert(roleIdentities).values({
      id,
      canonicalName: roleTitle,
      aliasesJson: JSON.stringify(aliases),
      description: input.result.brief.roleDescription || roleNode?.summary || "",
      industryDomainsJson: JSON.stringify(input.metadata?.scope?.industries || []),
    });
    [identity] = await db.select().from(roleIdentities).where(eq(roleIdentities.id, id)).limit(1);
  }

  const maintainerName = input.metadata?.maintainerName || "Role Atlas";
  let [maintainer] = await db.select().from(maintainers).where(eq(maintainers.name, maintainerName)).limit(1);
  if (!maintainer) {
    const id = domainId("maintainer");
    await db.insert(maintainers).values({
      id,
      name: maintainerName,
      kind: input.metadata?.maintainerKind || "role_atlas",
      description: input.metadata?.maintenanceKind === "source_official" ? "来源机构声明维护的岗位包。" : "岗位包维护主体。",
    });
    [maintainer] = await db.select().from(maintainers).where(eq(maintainers.id, id)).limit(1);
  }
  const id = domainId("package-line");
  await db.insert(packageLines).values({
    id,
    roleIdentityId: identity.id,
    packageId,
    title: roleTitle,
    scopeJson: JSON.stringify(input.metadata?.scope || { market: input.result.brief.market, audiences: input.result.brief.audience }),
    maintainerId: maintainer.id,
    maintenanceKind: input.metadata?.maintenanceKind || "role_atlas",
    maintenancePolicyJson: JSON.stringify(input.metadata?.maintenancePolicy || { reviewCadence: "按需", updateTriggers: ["重要来源变化", "用户迭代"] }),
    hostingKind: input.metadata?.hostingKind || "hosted",
    visibility: input.metadata?.visibility || "private",
    license: input.metadata?.license || "unspecified",
    evidencePolicy: input.metadata?.evidencePolicy || "metadata",
    protocolRange: input.metadata?.protocolRange || ">=2.0.0 <4.0.0",
  });
  const [created] = await db.select().from(packageLines).where(eq(packageLines.id, id)).limit(1);
  return created;
}

export async function listRegistryPackages(input: { query?: string; visibility?: string; status?: string; ownerSubjectId?: string; scope?: "mine" | "public" } = {}) {
  await ensureAppSchema();
  const db = getDb();
  const query = input.query?.trim();
  const rows = query
    ? await db.select().from(packageLines).where(or(like(packageLines.title, `%${query}%`), like(packageLines.packageId, `%${query}%`))).orderBy(asc(packageLines.title))
    : await db.select().from(packageLines).orderBy(asc(packageLines.title));
  const filtered = rows.filter((row) => (!input.visibility || row.visibility === input.visibility) && (!input.status || row.status === input.status));
  const [identities, maintainerRows, releases] = await Promise.all([
    db.select().from(roleIdentities),
    db.select().from(maintainers),
    db.select().from(packageReleases).orderBy(desc(packageReleases.createdAt)),
  ]);
  const ownedProjects = input.ownerSubjectId ? await getD1().prepare("SELECT id FROM projects WHERE owner_subject_id=? AND deleted_at IS NULL")
    .bind(input.ownerSubjectId).all<{ id: string }>() : null;
  const ownedIds = new Set(ownedProjects?.results.map(row => row.id) || []);
  const publicOnly = input.scope === "public" || input.visibility === "public";
  const publicRows = publicOnly ? await getD1().prepare(`SELECT r.id FROM package_releases r JOIN package_lines l ON l.id=r.package_line_id
    JOIN package_artifacts a ON a.root_hash=r.artifact_root_hash WHERE l.visibility='public' AND r.status IN ('published','deprecated')
    AND r.published_at IS NOT NULL AND json_extract(a.content, '$.manifest.visibility')='public'`).all<{ id: string }>() : null;
  const publicIds = new Set(publicRows?.results.map(row => row.id) || []);
  const visibleReleases = releases.filter(row => (!input.ownerSubjectId || Boolean(row.projectId && ownedIds.has(row.projectId)))
    && (!publicOnly || publicIds.has(row.id)));
  const visibleLines = new Set(visibleReleases.map(row => row.packageLineId));
  return filtered.filter(line => (!input.ownerSubjectId && !publicOnly) || visibleLines.has(line.id)).map((line) => ({
    ...line,
    scope: safeJson(line.scopeJson, {}),
    maintenancePolicy: safeJson(line.maintenancePolicyJson, {}),
    roleIdentity: (() => {
      const identity = identities.find((item) => item.id === line.roleIdentityId);
      if (!identity) return null;
      // Taxonomy identities are shared by role title, not by owner. Never project a different
      // project's private description or aliases through that shared row into personal/public catalogs.
      return input.ownerSubjectId || publicOnly
        ? { ...identity, canonicalName: line.title, description: "", aliasesJson: "[]", industryDomainsJson: "[]" }
        : identity;
    })(),
    maintainer: maintainerRows.find((item) => item.id === line.maintainerId) || null,
    releases: visibleReleases.filter((item) => item.packageLineId === line.id),
  }));
}

export async function getRegistryPackage(packageLineId: string, input: { ownerSubjectId?: string; scope?: "mine" | "public" } = {}) {
  const packages = await listRegistryPackages(input);
  return packages.find((item) => item.id === packageLineId || item.packageId === packageLineId) || null;
}

export async function updateRegistryPackageStatus(input: { packageLineId: string; status: "active" | "disputed" | "deprecated" | "superseded"; supersededByPackageLineId?: string | null }) {
  await ensureAppSchema();
  if (input.status === "superseded" && !input.supersededByPackageLineId) throw new Error("SUPERSEDED_TARGET_REQUIRED");
  if (input.supersededByPackageLineId === input.packageLineId) throw new Error("SUPERSEDED_TARGET_SELF");
  const db = getDb();
  if (input.status === "superseded") {
    const [target] = await db.select({ id: packageLines.id }).from(packageLines).where(eq(packageLines.id, input.supersededByPackageLineId!)).limit(1);
    if (!target) throw new Error("SUPERSEDED_TARGET_NOT_FOUND");
  }
  await db.update(packageLines).set({
    status: input.status,
    supersededByPackageLineId: input.status === "superseded" ? input.supersededByPackageLineId : null,
    updatedAt: new Date().toISOString(),
  }).where(eq(packageLines.id, input.packageLineId));
  return getRegistryPackage(input.packageLineId);
}
