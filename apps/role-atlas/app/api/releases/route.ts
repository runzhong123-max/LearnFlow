import { ensureAppSchema, getD1 } from "@/db";
import { changeHubPublication } from "@/lib/releases/hub-publication";
import { authorizeApiRequest } from "@/lib/access";
import { z } from "zod/v4";
import { deprecateRelease, listProjectReleases, prepareRelease, publishProjectVersionToHub, publishRelease, rollbackRelease } from "@/lib/releases/service";

export const runtime = "edge";

const releaseInputSchema = z.object({
  projectId: z.string().min(4).max(100),
  projectVersionId: z.string().min(4).max(220),
  packageVersion: z.string().min(5).max(80),
  packageId: z.string().max(180).optional(),
  visibility: z.enum(["private", "unlisted", "public"]).default("private"),
  evidencePolicy: z.enum(["full", "metadata", "redacted"]).default("metadata"),
  registry: z.object({
    maintainerName: z.string().max(160).optional(),
    maintainerKind: z.enum(["role_atlas", "source_organization", "community", "organization", "individual"]).optional(),
    maintenanceKind: z.enum(["role_atlas", "source_official", "community", "private"]).optional(),
    maintenancePolicy: z.object({
      reviewCadence: z.string().max(120).optional(),
      updateTriggers: z.array(z.string().max(120)).max(20).optional(),
      notes: z.string().max(500).optional(),
    }).optional(),
    hostingKind: z.enum(["bundled", "hosted", "remote"]).optional(),
    license: z.string().max(120).optional(),
    protocolRange: z.string().max(40).optional(),
    scope: z.object({
      market: z.string().max(160).optional(),
      industries: z.array(z.string().max(120)).max(20).optional(),
      educationStages: z.array(z.string().max(120)).max(20).optional(),
      audiences: z.array(z.string().max(120)).max(20).optional(),
      region: z.string().max(120).optional(),
    }).optional(),
  }).optional(),
});

const prepareSchema = releaseInputSchema.extend({ action: z.literal("prepare") });
const publishToHubSchema = releaseInputSchema.omit({ visibility: true }).extend({ action: z.literal("publish_to_hub") });
const createSchema = z.discriminatedUnion("action", [prepareSchema, publishToHubSchema]);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("withdraw_from_hub"), packageLineId: z.string().min(4).max(220), expectedReleaseId: z.string().min(4).max(220), expectedRegistryVersion: z.number().int().nonnegative() }),
  z.object({ action: z.literal("restore_to_hub"), packageLineId: z.string().min(4).max(220), expectedReleaseId: z.string().min(4).max(220), expectedRegistryVersion: z.number().int().nonnegative() }),

  z.object({ action: z.literal("publish"), releaseId: z.string().min(4).max(220) }),
  z.object({ action: z.literal("rollback"), packageLineId: z.string().min(4).max(220), targetReleaseId: z.string().min(4).max(220), expectedCurrentReleaseId: z.string().max(220).nullable().optional() }),
  z.object({ action: z.literal("deprecate"), releaseId: z.string().min(4).max(220), reason: z.string().max(1_000).optional() }),
]);

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return Response.json({ error: "缺少 projectId。" }, { status: 400 });
  return Response.json({ releases: await listProjectReleases(projectId) });
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const input = createSchema.parse(await request.json());
    const release = input.action === "publish_to_hub"
      ? await publishProjectVersionToHub(input)
      : await prepareRelease(input);
    return Response.json({ release }, { status: release.status === "failed" ? 422 : 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "岗位包编译失败。";
    return Response.json({ error: message }, { status: message === "VERSION_NOT_FOUND" ? 404 : /UNIQUE|CONFLICT/u.test(message) ? 409 : 400 });
  }
}

export async function PATCH(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const input = actionSchema.parse(await request.json());
    if (input.action === "withdraw_from_hub" || input.action === "restore_to_hub") {
      await ensureAppSchema();
      return Response.json({ publication: await changeHubPublication(getD1(), input) }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (input.action === "publish") return Response.json({ release: await publishRelease(input) });
    if (input.action === "rollback") return Response.json({ release: await rollbackRelease(input) });
    return Response.json({ release: await deprecateRelease(input) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "发布操作失败。";
    const status = /NOT_FOUND/u.test(message) ? 404 : /CONFLICT/u.test(message) ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}
