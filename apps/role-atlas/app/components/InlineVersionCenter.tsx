"use client";

import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import VersionReleaseWorkspace, { type ReleaseRow, type TagRow, type VersionSummary } from "@/app/projects/[projectId]/versions/VersionReleaseWorkspace";

type Project = { id: string; title: string; headVersionId: string | null; currentReleaseId: string | null };

export default function InlineVersionCenter({ project, conversationId, initialSection = "history", onClose, onAdopted }: { project: Project; conversationId?: string; initialSection?: "history" | "publish"; onClose: () => void; onAdopted?: (conversationId: string) => void }) {
  const [data, setData] = useState<{ versions: VersionSummary[]; tags: TagRow[]; releases: ReleaseRow[] } | null>(null);
  const [currentProject, setCurrentProject] = useState(project);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const load = useCallback(async () => {
    setError("");
    try {
      const [versionResponse, tagResponse, releaseResponse, projectResponse] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(project.id)}/versions`),
        fetch(`/api/projects/${encodeURIComponent(project.id)}/tags`),
        fetch(`/api/releases?projectId=${encodeURIComponent(project.id)}`),
        fetch(`/api/projects/${encodeURIComponent(project.id)}`),
      ]);
      const [versions, tags, releases, workspace] = await Promise.all([versionResponse.json(), tagResponse.json(), releaseResponse.json(), projectResponse.json()]) as [
        { versions?: VersionSummary[]; error?: string },
        { tags?: TagRow[]; error?: string },
        { releases?: ReleaseRow[]; error?: string },
        { project?: Project; error?: string },
      ];
      if (!versionResponse.ok || !tagResponse.ok || !releaseResponse.ok || !projectResponse.ok || !workspace.project) throw new Error(versions.error || tags.error || releases.error || workspace.error || "版本中心读取失败。");
      setCurrentProject(workspace.project);
      setData({ versions: versions.versions || [], tags: tags.tags || [], releases: releases.releases || [] });
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "版本中心读取失败。");
    }
  }, [project.id]);

  useEffect(() => { void load(); }, [load]);
  if (error) return <div className="inline-operation-state error"><AlertTriangle size={17} /><b>{error}</b><button onClick={() => void load()}>重试</button><button onClick={onClose}>返回工作台</button></div>;
  if (!data) return <div className="inline-operation-state"><LoaderCircle className="spin" size={18} /><b>正在读取版本、Tag 与 Release…</b></div>;
  return <VersionReleaseWorkspace key={revision} project={currentProject} conversationId={conversationId} initialSection={initialSection} initialVersions={data.versions} initialTags={data.tags} initialReleases={data.releases} embedded onClose={onClose} onChanged={() => void load()} onAdopted={(id) => { if (id) onAdopted?.(id); else void load(); }} />;
}
