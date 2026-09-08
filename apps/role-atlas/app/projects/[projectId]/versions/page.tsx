import { serverMayReadProject } from "@/lib/access-server";
import { publicationBlockers, validateBuildResult } from "@/lib/packages/validator";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getProjectWorkspace } from "@/lib/projects/repository";
import { listProjectReleases } from "@/lib/releases/service";
import { listProjectVersions } from "@/lib/versioning/commit";
import { listProjectTags } from "@/lib/versioning/tags";
import VersionReleaseWorkspace from "./VersionReleaseWorkspace";

export const metadata: Metadata = { title: "版本与发布 · Role Atlas" };

export default async function VersionPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!await serverMayReadProject(projectId)) notFound();
  const [workspace, versions, tags, releases] = await Promise.all([
    getProjectWorkspace(projectId),
    listProjectVersions(projectId),
    listProjectTags(projectId),
    listProjectReleases(projectId),
  ]);
  if (!workspace) notFound();
  return <VersionReleaseWorkspace
    project={{
      id: workspace.project.id,
      title: workspace.project.title,
      headVersionId: workspace.project.headVersionId || workspace.project.activeVersionId,
      currentReleaseId: workspace.project.currentReleaseId,
    }}
    initialVersions={versions.map((version) => {
      const summary: Partial<typeof version> = { ...version };
      delete summary.result;
      return { ...summary, publicationBlockers: [...validateBuildResult(version.result).hardErrors, ...publicationBlockers(version.result)] } as Omit<typeof version, "result"> & { publicationBlockers: string[] };
    })}
    initialTags={tags}
    initialReleases={releases}
  />;
}
