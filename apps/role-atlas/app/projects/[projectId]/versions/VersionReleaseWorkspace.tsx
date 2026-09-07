"use client";

import { ArrowLeft, CheckCircle2, Download, GitCompareArrows, GitMerge, History, PackageCheck, Rocket, RotateCcw, Tag } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SemanticDiff } from "@/lib/versioning/types";
import "./version-adoption.css";

export type VersionSummary = {
  id: string;
  parentVersionId: string | null;
  sourceRunId: string | null;
  sourceKind: string;
  version: string;
  snapshotId: string;
  status: string;
  rootHash: string;
  message: string;
  authorKind: string;
  createdAt: string;
};

export type TagRow = { id: string; name: string; targetVersionId: string; description: string; createdAt: string };
export type ReleaseRow = { id: string; packageLineId: string; sourceProjectVersionId: string | null; packageVersion: string; status: string; artifactRootHash: string | null; error: string | null; publishedAt: string | null; createdAt: string };

export default function VersionReleaseWorkspace({
  project,
  initialVersions,
  initialTags,
  initialReleases,
  embedded = false,
  onClose,
  onChanged,
  conversationId,
  onAdopted,
  initialSection = "history",
  initialVersionId,
}: {
  project: { id: string; title: string; headVersionId: string | null; currentReleaseId: string | null };
  initialVersions: VersionSummary[];
  initialTags: TagRow[];
  initialReleases: ReleaseRow[];
  embedded?: boolean;
  onClose?: () => void;
  onChanged?: () => void;
  conversationId?: string;
  onAdopted?: (conversationId?: string) => void;
  initialSection?: "history" | "publish";
  initialVersionId?: string;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(initialVersionId || project.headVersionId || initialVersions[0]?.id || "");
  const [compareFrom, setCompareFrom] = useState(initialVersions.find((item) => item.id === selectedId)?.parentVersionId || initialVersions[1]?.id || "");
  const [tagName, setTagName] = useState("");
  const [packageVersion, setPackageVersion] = useState("1.0.0");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [evidencePolicy, setEvidencePolicy] = useState<"full" | "metadata" | "redacted">("metadata");
  const [diff, setDiff] = useState<SemanticDiff | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [releases, setReleases] = useState(initialReleases);
  const [pendingPublish, setPendingPublish] = useState<{ releaseId: string; key: string } | null>(null);
  const publishRef = useRef<HTMLElement>(null);
  const publishKey = JSON.stringify([selectedId, packageVersion, visibility, evidencePolicy]);
  useEffect(() => {
    if (initialSection === "publish") {
      publishRef.current?.focus({ preventScroll: true });
      publishRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [initialSection]);

  function rememberRelease(release: ReleaseRow) {
    setReleases((current) => [release, ...current.filter((item) => item.id !== release.id)]);
  }

  const [currentHeadVersionId, setCurrentHeadVersionId] = useState(project.headVersionId);
  const [switchConversation, setSwitchConversation] = useState(false);
  const [adoptionConflict, setAdoptionConflict] = useState(false);
  const selected = useMemo(() => initialVersions.find((item) => item.id === selectedId), [initialVersions, selectedId]);
  const currentHead = initialVersions.find((item) => item.id === currentHeadVersionId);

  const adoptSelected = async () => {
    if (!selected || busy) return;
    setBusy("adopt"); setNotice(""); setAdoptionConflict(false);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(selected.id)}/adopt`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedHeadVersionId: currentHeadVersionId, ...(switchConversation && conversationId ? { conversationId } : {}) }),
      });
      const payload = await response.json() as { adopted?: boolean; appliedToHead?: boolean; currentHeadVersionId?: string | null; conversationSwitched?: boolean; error?: string };
      if (response.status === 409) {
        setAdoptionConflict(true);
        if (Object.prototype.hasOwnProperty.call(payload, "currentHeadVersionId")) {
          setCurrentHeadVersionId(payload.currentHeadVersionId ?? null);
          if (payload.currentHeadVersionId) setCompareFrom(payload.currentHeadVersionId);
          setDiff(null);
        }
        setNotice(`未采用此版本：${payload.error || "项目当前版本或对话状态已经变化"}。候选成果完整保留，请先核对当前版本，再决定是否重新采用。`);
        return;
      }
      if (!response.ok || payload.adopted === false || payload.appliedToHead === false) throw new Error(payload.error || "版本尚未采用，请重试。");
      setCurrentHeadVersionId(payload.currentHeadVersionId || selected.id);
      if (switchConversation && conversationId && payload.conversationSwitched !== true) {
        setNotice("项目当前版本已采用，但此对话尚未切换。请重新打开版本中心核对后再切换；历史引用保持不变。");
        onAdopted?.();
        return;
      }
      setNotice(switchConversation && conversationId ? "已采用为项目当前版本，并切换此对话的后续工作版本；历史引用保持原样。" : "已采用为项目当前版本。新建对话将使用此版本，已有对话及其引用保持原样。");
      onAdopted?.(switchConversation ? conversationId : undefined);
      if (!onAdopted && !embedded) router.refresh();
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "版本采用失败；候选成果仍然保留。"); }
    finally { setBusy(""); }
  };

  const action = async (key: string, request: Promise<Response>) => {
    setBusy(key); setNotice("");
    try {
      const response = await request;
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "操作失败");
      setNotice("操作已完成，版本与发布记录已更新。");
      if (onChanged) onChanged(); else router.refresh();
      return payload;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
      return null;
    } finally { setBusy(""); }
  };

  const publishSelected = async () => {
    if (!selected || busy) return;
    setBusy("save-release"); setNotice(""); setAdoptionConflict(false);
    let preparedId = pendingPublish?.key === publishKey ? pendingPublish.releaseId : "";
    try {
      if (!preparedId) {
        const prepared = await fetch("/api/releases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "prepare", projectId: project.id, projectVersionId: selected.id, packageVersion, visibility, evidencePolicy }) });
        const payload = await prepared.json() as { release?: ReleaseRow; error?: string };
        if (payload.release) rememberRelease(payload.release);
        if (!prepared.ok || !payload.release?.id) throw new Error(payload.error || payload.release?.error || "岗位包编译未完成，请查看保留的编译记录。");
        if (payload.release.sourceProjectVersionId !== selected.id) throw new Error("此岗位包版本号已对应其他项目版本，请修改版本号后重新保存。");
        preparedId = payload.release.id;
        setPendingPublish({ releaseId: preparedId, key: publishKey });
      }
      const published = await fetch("/api/releases", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "publish", releaseId: preparedId }) });
      const payload = await published.json() as { release?: ReleaseRow; error?: string };
      if (payload.release) rememberRelease(payload.release);
      if (!published.ok) throw new Error(payload.error || "岗位包编译已保存，发布步骤暂未完成。");
      setPendingPublish(null);
      setNotice(visibility === "private" ? "已保存到我的岗位包，仅自己可见。" : "岗位包已发布到公开图谱市场。");
      if (onChanged) onChanged(); else router.refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "岗位包保存失败。";
      setNotice(preparedId ? `${message} 已编译成果保留，可点击下方按钮继续完成。` : message);
    } finally { setBusy(""); }
  };

  const loadDiff = async () => {
    if (!compareFrom || !selectedId) return;
    setBusy("diff"); setNotice("");
    try {
      const response = await fetch(`/api/projects/${project.id}/diffs?from=${encodeURIComponent(compareFrom)}&to=${encodeURIComponent(selectedId)}`);
      const payload = await response.json() as { diff?: SemanticDiff; error?: string };
      if (!response.ok || !payload.diff) throw new Error(payload.error || "Diff 生成失败");
      setDiff(payload.diff);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Diff 生成失败"); }
    finally { setBusy(""); }
  };

  const Shell = embedded ? "div" : "main";
  return <Shell className={`version-shell${embedded ? " embedded-operation" : ""}`}>
    <header className="version-topbar">
      {embedded && onClose ? <button type="button" onClick={onClose}><ArrowLeft size={15} /> 返回岗位工作台</button> : <Link href={`/projects/${project.id}`}><ArrowLeft size={15} /> 返回岗位工作台</Link>}
      <span>VERSION · TAG · RELEASE</span>
      {embedded ? <span>页内版本中心</span> : <Link href="/registry">岗位包中心</Link>}
    </header>
    <section className="version-heading">
      <div><span>IMMUTABLE SNAPSHOT HISTORY</span><h1>{project.title}</h1><p>项目历史、Tag 与发布彼此独立；恢复历史不会删除后续版本。</p></div>
      <div className="version-head-facts"><span><b>{initialVersions.length}</b> 个版本</span><span><b>{initialTags.length}</b> 个 Tag</span><span><b>{releases.length}</b> 个 Release</span></div>
    </section>
    {notice ? <div className={`version-notice ${adoptionConflict ? "adoption-conflict" : ""}`} role={adoptionConflict ? "alert" : "status"}>{notice}</div> : null}
    <div className="version-layout">
      <aside className="version-timeline">
        <header><History size={15} /><span><b>项目版本</b><small>每次构建、迭代与实例化的不可变提交</small></span></header>
        {initialVersions.map((version) => <button disabled={Boolean(busy)} key={version.id} className={selectedId === version.id ? "active" : ""} onClick={() => { setSelectedId(version.id); setCompareFrom(version.parentVersionId || ""); setDiff(null); }}>
          <i>{version.id === currentHeadVersionId ? "当前版本" : version.sourceKind}</i>
          <b>{version.message || version.version}</b>
          <small>{new Date(version.createdAt).toLocaleString("zh-CN")} · {version.snapshotId}</small>
          <code>{version.rootHash.slice(0, 16)}</code>
        </button>)}
      </aside>
      <section className="version-main">
        {selected ? <>
          <article className="version-card selected-version-card">
            <header><span><b>{selected.message || selected.version}</b><small>{selected.status} · {selected.sourceKind}</small></span><code>{selected.id}</code></header>
            <dl><div><dt>Snapshot</dt><dd>{selected.snapshotId}</dd></div><div><dt>Root hash</dt><dd>{selected.rootHash}</dd></div><div><dt>父版本</dt><dd>{selected.parentVersionId || "初始版本"}</dd></div></dl>
            <section className="version-adoption" aria-label="采用项目版本">
              <div><GitMerge size={17} /><span><b>{selected.id === currentHeadVersionId ? "这是项目当前版本" : "将选中成果设为项目当前版本"}</b><small>{selected.id === currentHeadVersionId ? "新建对话以此版本开始。已有对话仍保留各自的版本。" : "并行对话的成果独立保存；采用会更换项目默认版本，其他候选与历史完整保留。"}</small></span></div>
              {selected.id !== currentHeadVersionId && <p>当前默认：<b>{currentHead?.message || currentHead?.version || currentHeadVersionId || "尚无版本"}</b><br />将采用：<b>{selected.message || selected.version}</b></p>}
              {conversationId && <label><input type="checkbox" checked={switchConversation} disabled={Boolean(busy)} onChange={(event) => setSwitchConversation(event.target.checked)} />同时让此对话的后续工作使用选中版本<small>历史消息中的节点引用仍固定到原快照；正在运行的对话会拒绝切换。</small></label>}
              {(selected.id !== currentHeadVersionId || switchConversation) && <button type="button" data-testid="adopt-project-version" disabled={Boolean(busy)} onClick={() => void adoptSelected()}><CheckCircle2 size={13} />{busy === "adopt" ? "正在采用…" : adoptionConflict ? "已核对，重新尝试采用" : "采用选中版本"}</button>}
            </section>

          </article>

          <div className="version-two-column">
            <article className="version-card">
              <header><GitCompareArrows size={15} /><span><b>语义 Diff</b><small>按稳定对象 ID 与字段路径比较</small></span></header>
              <label>比较来源<select value={compareFrom} onChange={(event) => setCompareFrom(event.target.value)}><option value="">选择历史版本</option>{currentHeadVersionId && currentHeadVersionId !== selectedId && !initialVersions.some((item) => item.id === currentHeadVersionId) && <option value={currentHeadVersionId}>最新项目版本（刚刚更新）</option>}{initialVersions.filter((item) => item.id !== selectedId).map((item) => <option value={item.id} key={item.id}>{item.message || item.version}</option>)}</select></label>
              <button disabled={!compareFrom || busy === "diff"} onClick={() => void loadDiff()}>生成 Diff</button>
              {diff ? <div className="diff-summary"><b>{diff.summary.total} 项语义变化</b><span>+{diff.summary.added} / −{diff.summary.removed} / 修改 {diff.summary.modified} / 重命名 {diff.summary.renamed}</span><small>建议 SemVer：{diff.recommendedBump} · 影响：{diff.impacts.join("、") || "无"}</small></div> : null}
            </article>

            <article className="version-card">
              <header><Tag size={15} /><span><b>标记里程碑</b><small>Tag 是指向当前版本的不可变名称</small></span></header>
              <label>Tag 名称<input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="例如：首个可用版" /></label>
              <button disabled={!tagName.trim() || busy === "tag"} onClick={() => void action("tag", fetch(`/api/projects/${project.id}/tags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: tagName, targetVersionId: selected.id }) }))}>创建 Tag</button>
              <div className="tag-list">{initialTags.filter((tag) => tag.targetVersionId === selected.id).map((tag) => <span key={tag.id}>{tag.name}</span>)}</div>
            </article>
          </div>

          <article ref={publishRef} tabIndex={-1} className="version-card release-builder" aria-label="保存与发布岗位包">
            <header><PackageCheck size={15} /><span><b>保存与发布岗位包</b><small>固定选中版本，按你选择的可见范围保存成果</small></span></header>
            <div className="release-form"><label>岗位包版本号<input disabled={Boolean(busy)} value={packageVersion} onChange={(event) => setPackageVersion(event.target.value)} /></label><label>可见范围<select disabled={Boolean(busy)} value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option value="private">仅自己可见</option><option value="public">公开图谱市场</option></select></label><label>证据策略<select disabled={Boolean(busy)} value={evidencePolicy} onChange={(event) => setEvidencePolicy(event.target.value as typeof evidencePolicy)}><option value="metadata">只公开元数据</option><option value="redacted">脱敏</option><option value="full">完整</option></select></label></div>
            <p className="release-visibility-note">{visibility === "private" ? "仅自己可见：成果保存到个人岗位包中心，不进入公开市场。" : "公开发布：此岗位包将可被其他用户发现；原始证据按所选策略处理。"}</p>
            <div className="release-publish-actions">
              <button className="secondary" disabled={Boolean(busy)} onClick={() => void action("prepare", fetch("/api/releases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "prepare", projectId: project.id, projectVersionId: selected.id, packageVersion, visibility, evidencePolicy }) }))}>仅编译并校验</button>
              <button data-testid="save-or-publish-package" disabled={Boolean(busy)} onClick={() => void publishSelected()}><Rocket size={13} />{busy === "save-release" ? "正在保存…" : pendingPublish?.key === publishKey ? visibility === "private" ? "继续保存到我的岗位包" : "继续发布到公开图谱市场" : visibility === "private" ? "保存到我的岗位包" : "发布到公开图谱市场"}</button>
            </div>
          </article>
        </> : <p>项目尚无不可变版本。</p>}
      </section>
      <aside className="release-list">
        <header><PackageCheck size={15} /><span><b>Release</b><small>发布失败不会改变当前推荐版本</small></span></header>
        {releases.map((release) => <article key={release.id} className={release.id === project.currentReleaseId ? "current" : ""}>
          <span><b>v{release.packageVersion}</b><i>{release.status}</i></span>
          <small>{new Date(release.createdAt).toLocaleString("zh-CN")}</small>
          {release.error ? <p>{release.error}</p> : null}
          <div>
            {release.status === "ready" ? <button disabled={busy === release.id} onClick={() => void action(release.id, fetch("/api/releases", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "publish", releaseId: release.id }) }))}><CheckCircle2 size={12} /> 发布</button> : null}
            {release.status === "published" && release.id !== project.currentReleaseId ? <button disabled={busy === `rollback:${release.id}`} onClick={() => void action(`rollback:${release.id}`, fetch("/api/releases", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rollback", packageLineId: release.packageLineId, targetReleaseId: release.id, expectedCurrentReleaseId: project.currentReleaseId }) }))}><RotateCcw size={12} /> 回滚到此版</button> : null}
            {release.artifactRootHash && ["ready", "published", "deprecated"].includes(release.status) ? <a href={`/api/releases/${release.id}/export`}><Download size={12} /> 导出</a> : null}
          </div>
        </article>)}
      </aside>
    </div>
  </Shell>;
}
