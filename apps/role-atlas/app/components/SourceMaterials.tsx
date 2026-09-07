"use client";

import { useRef, useState } from "react";
import { sourceInputSchema, type SourceInput } from "@/lib/build/types";
import { MATERIAL_ACCEPT, materialSource, parseMaterialFile } from "@/lib/source-materials";
import "./source-materials.css";

export default function SourceMaterials({ value, onChange, disabled, onBusyChange }: {
  value: SourceInput[]; onChange: (sources: SourceInput[]) => void; disabled: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [mode, setMode] = useState<"file" | "url" | "text">("file");
  const [kind, setKind] = useState<SourceInput["kind"]>("public_document");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const blocked = disabled || busy;

  async function add(files?: File[]) {
    if (disabled || lock.current || (files && !files.length)) return;
    if (value.length + (files?.length || 1) > 20) { setError("最多添加 20 份资料，请先移除部分资料。"); return; }
    lock.current = true; setBusy(true); onBusyChange(true); setError("");
    try {
      const added: SourceInput[] = []; const failures: string[] = [];
      if (files) {
        for (const file of files) {
          try { added.push(await parseMaterialFile(file, kind)); }
          catch (e) { failures.push(`${file.name}：${e instanceof Error ? e.message : "解析失败"}`); }
        }
      } else if (mode === "url") {
        const response = await fetch("/api/source-materials", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, title, kind }), signal: AbortSignal.timeout(25_000) });
        const payload = await response.json() as { source?: unknown; error?: string };
        if (!response.ok) throw new Error(payload.error || "URL 读取失败");
        added.push(sourceInputSchema.parse(payload.source)); setUrl(""); setTitle("");
      } else {
        added.push(materialSource(title.trim() || "用户提供文本", text, kind)); setText(""); setTitle("");
      }
      onChange([...value, ...added]); setError(failures.join("\n"));
    } catch (e) { setError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "资料读取超时，请重试或改用附件、文本。" : e instanceof Error ? e.message : "资料添加失败，请重试。"); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }

  return <section className="source-materials" aria-label="可选资料">
    <div className="material-modes" aria-label="资料添加方式">
      {([["file", "附件"], ["url", "URL"], ["text", "文本"]] as const).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={mode === id} disabled={blocked} onClick={() => setMode(id)}>{label}</button>)}
    </div>
    <label><span>资料类型</span><select value={kind} disabled={blocked} onChange={(e) => setKind(e.target.value as SourceInput["kind"])}>
      <option value="public_document">公开资料 / JD / 标准</option><option value="private_document">私域岗位资料</option><option value="workspace_observation">真实工作事件观察</option>
    </select></label>
    {mode === "file" ? <div className={`material-drop${dragging ? " dragging" : ""}`}
      onDragOver={(e) => { e.preventDefault(); if (!blocked) setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!blocked) void add(Array.from(e.dataTransfer.files)); }}>
      <label><strong>拖动附件到这里，或点击选择</strong><input type="file" multiple accept={MATERIAL_ACCEPT} disabled={blocked}
        onChange={(e) => { if (e.target.files?.length) void add(Array.from(e.target.files)); e.target.value = ""; }} /></label>
      <small>PDF、Word（DOCX）、TXT、MD、CSV、JSON；每份不超过 5 MB、60000 字符。扫描件请先 OCR。</small>
    </div> : <>
      <label><span>资料标题（可选）</span><input value={title} maxLength={240} disabled={blocked} onChange={(e) => setTitle(e.target.value)} /></label>
      {mode === "url" ? <label><span>公开网页 URL</span><input type="url" value={url} disabled={blocked} maxLength={500} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} /></label>
        : <label><span>资料文本</span><textarea value={text} disabled={blocked} maxLength={60_000} placeholder="粘贴 JD、流程材料或脱敏工作记录…" onChange={(e) => setText(e.target.value)} /></label>}
      <button type="button" disabled={blocked || !(mode === "url" ? url.trim() : text.trim())} onClick={() => void add()}>添加到本轮资料</button>
      <small>点击添加后进入下方清单，随本轮生成提交。</small>
    </>}
    <div role="status" aria-live="polite">{busy ? "正在读取资料，请稍候…" : `已添加 ${value.length} / 20 份资料`}</div>
    {error ? <p role="alert" className="material-error">{error}</p> : null}
    {value.map((source, index) => <details key={`${index}-${source.title}`} className="material-item">
      <summary>{source.title} · {source.content.length} 字符</summary>
      <p>{source.locator || "手动文本"}</p><pre>{source.content.slice(0, 600)}{source.content.length > 600 ? "\n（预览前 600 字符）" : ""}</pre>
      <button type="button" disabled={blocked} aria-label={`移除 ${source.title}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>移除</button>
    </details>)}
  </section>;
}
