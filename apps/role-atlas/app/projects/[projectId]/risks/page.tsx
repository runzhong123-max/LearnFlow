import { serverMayReadProject } from "@/lib/access-server";
import { notFound, redirect } from "next/navigation";
import { resolveSnapshot } from "@/lib/snapshots/resolver";

export default async function LegacyProjectRiskPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ conversation?: string }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  if (!await serverMayReadProject(projectId)) notFound();
  const resolved = await resolveSnapshot({ projectId });
  if (!resolved) notFound();
  const paramsOut = new URLSearchParams({ profile: "co_guided", project: projectId });
  if (resolved.reference.versionId) paramsOut.set("version", resolved.reference.versionId);
  if (query.conversation) paramsOut.set("conversation", query.conversation);
  redirect(`/snapshots/${encodeURIComponent(resolved.reference.snapshotId)}/iterate?${paramsOut.toString()}`);
}
