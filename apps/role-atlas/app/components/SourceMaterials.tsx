"use client";

import { useEffect, useRef, useState } from "react";
import { sourceInputSchema, type SourceInput } from "@/lib/build/types";
import { MATERIAL_ACCEPT, materialSource, parseMaterialFile } from "@/lib/source-materials";
import { detectMaterialUrls, materialUrlKey, MaterialImportQueue, type ImportItem } from "@/lib/material-import";
import "./source-materials.css";

type MaterialInput = { kind: SourceInput["kind"] } & ({ mode: "file"; file: File } | { mode: "url"; url: string; title: string });
const pending = (item: ImportItem<MaterialInput>) => item.status === "queued" || item.status === "reading";
const statusLabels = { queued: "排队中", reading: "读取中", ready: "已读取", failed: "读取失败", cancelled: "已取消" };
const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

export default function SourceMaterials({ value, onChange, disabled, onBusyChange }: {
  value: SourceInput[]; onChange: (sources: SourceInput[]) => void; disabled: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [mode, setMode] = useState<"file" | "url" | "text">("file");
  const [kind, setKind] = useState<SourceInput["kind"]>("public_document");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [urlText, setUrlText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [items, setItems] = useState<ImportItem<MaterialInput>[]>([]);
  const queue = useRef<MaterialImportQueue<MaterialInput, SourceInput> | null>(null);
  const itemsRef = useRef(items);
  const valueRef = useRef(value);
  const previousValue = useRef(value);
  if (previousValue.current !== value) { previousValue.current = value; valueRef.current = value; }
  const callbacks = useRef({ onChange, onBusyChange });
  callbacks.current = { onChange, onBusyChange };
  const dragDepth = useRef(0);
  const resolvedUrls = useRef(new Map<string, SourceInput>());
  const resolvedFiles = useRef(new Map<string, SourceInput>());
  const detected = detectMaterialUrls(urlText);
  const textLinks = mode === "text" ? detectMaterialUrls(text) : { urls: [], duplicates: 0 };
  const queuedCount = items.filter((item) => item.status === "queued").length;
  const readingCount = items.filter((item) => item.status === "reading").length;

  useEffect(() => {
    const imports = new MaterialImportQueue<MaterialInput, SourceInput>({
      concurrency: 3,
      load: async (input, signal) => {
        signal.throwIfAborted();
        if (input.mode === "file") return parseMaterialFile(input.file, input.kind);
        let response: Response;
        try {
          response = await fetch("/api/source-materials", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: input.url, title: input.title, kind: input.kind }), signal: AbortSignal.any([signal, AbortSignal.timeout(22_000)]) });
        } catch (cause) {
          if (signal.aborted) throw cause;
          throw new Error(cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name) ? "读取超时；可单独重试或粘贴网页正文。" : "连接失败，请检查网络后重试。");
        }
        const payload = await response.json() as { source?: unknown; error?: string };
        if (!response.ok) throw new Error(payload.error || `读取失败（${response.status}）`);
        return sourceInputSchema.parse(payload.source);
      },
      onResult: (source, input) => {
        if (input.mode === "url") resolvedUrls.current.set(materialUrlKey(input.url), source);
        else resolvedFiles.current.set(fileKey(input.file), source);
        if (valueRef.current.some((item) => item.locator === source.locator && item.content === source.content)) return;
        if (valueRef.current.length >= 20) throw new Error("资料已满 20 份，请先移除部分资料后重试。");
        valueRef.current = [...valueRef.current, source];
        callbacks.current.onChange(valueRef.current);
      },
      onUpdate: (next, busy) => { itemsRef.current = next; setItems(next); callbacks.current.onBusyChange(busy); },
    });
    queue.current = imports;
    return () => { imports.dispose(); queue.current = null; callbacks.current.onBusyChange(false); };
  }, []);

  function remainingSlots() { return 20 - valueRef.current.length - itemsRef.current.filter(pending).length; }
  function enqueue(inputs: Array<{ label: string; input: MaterialInput }>) {
    if (!inputs.length || disabled) return false;
    if (inputs.length > remainingSlots()) { setError(`最多添加 20 份资料，当前还可添加 ${Math.max(0, remainingSlots())} 份（含排队项）。请减少本次数量或移除部分资料。`); return false; }
    queue.current?.enqueue(inputs.map((item) => ({ ...item, id: crypto.randomUUID() })));
    setError(""); return true;
  }
  function addFiles(files: File[]) {
    const existing = new Set([
      ...itemsRef.current.filter(pending).flatMap((item) => item.input.mode === "file" ? [fileKey(item.input.file)] : []),
      ...[...resolvedFiles.current].filter(([, result]) => valueRef.current.some((source) => source.locator === result.locator && source.content === result.content)).map(([key]) => key),
    ]);
    const unique = files.filter((file) => { const key = fileKey(file); if (existing.has(key)) return false; existing.add(key); return true; });
    setNotice(unique.length < files.length ? `已跳过 ${files.length - unique.length} 个重复附件。` : "");
    enqueue(unique.map((file) => ({ label: file.name, input: { mode: "file", file, kind } })));
  }
  function addUrls(inputText = urlText, fromText = false) {
    const parsed = detectMaterialUrls(inputText);
    if (!parsed.urls.length) { setError("未识别到链接，请粘贴 https:// 或 www. 开头的网址。"); return; }
    const existing = new Set([
      ...valueRef.current.flatMap((source) => source.locator?.startsWith("https://") ? [materialUrlKey(source.locator)] : []),
      ...itemsRef.current.filter(pending).flatMap((item) => item.input.mode === "url" ? [materialUrlKey(item.input.url)] : []),
      ...[...resolvedUrls.current].filter(([, result]) => valueRef.current.some((source) => source.locator === result.locator && source.content === result.content)).map(([url]) => url),
    ]);
    const fresh = parsed.urls.filter((url) => !existing.has(materialUrlKey(url)));
    const skipped = parsed.duplicates + parsed.urls.length - fresh.length;
    setNotice(skipped ? `已跳过 ${skipped} 个重复链接。` : "");
    if (!fresh.length) { setError(""); setNotice("这些链接已添加或正在读取，没有重复提交。"); return; }
    if (enqueue(fresh.map((url) => ({ label: url, input: { mode: "url", url, title: parsed.urls.length === 1 ? title : "", kind } })))) {
      if (!fromText) { setUrlText(""); setTitle(""); }
    }
  }
  function addText() {
    if (disabled) return;
    if (remainingSlots() < 1) { setError("资料已满 20 份（含排队项），请先移除部分资料。"); return; }
    try {
      const source = materialSource(title.trim() || "用户提供文本", text, kind);
      valueRef.current = [...valueRef.current, source]; callbacks.current.onChange(valueRef.current);
      setText(""); setTitle(""); setError(""); setNotice("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "文本添加失败。"); }
  }
  function retry(id: string) {
    if (remainingSlots() < 1) { setError("资料已满，请先移除部分资料再重试。"); return; }
    setError(""); queue.current?.retry(id);
  }

  return <section className={`source-materials${dragging ? " dragging" : ""}`} aria-label="可选资料"
    onDragEnter={(event) => { if (!Array.from(event.dataTransfer.types).includes("Files")) return; event.preventDefault(); dragDepth.current++; if (!disabled) setDragging(true); }}
    onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? "none" : "copy"; } }}
    onDragLeave={(event) => { if (!Array.from(event.dataTransfer.types).includes("Files")) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={(event) => { if (!Array.from(event.dataTransfer.types).includes("Files")) return; event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false); if (!disabled) addFiles(Array.from(event.dataTransfer.files)); }}>
    <div className="material-modes" aria-label="资料添加方式">
      {([["file", "附件"], ["url", "URL"], ["text", "文本"]] as const).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={mode === id} disabled={disabled} onClick={() => { setMode(id); setError(""); setNotice(""); }}>{label}</button>)}
    </div>
    {dragging && <div className="material-drop-hint">松开即可添加附件</div>}
    <label><span>资料类型</span><select value={kind} disabled={disabled} onChange={(e) => setKind(e.target.value as SourceInput["kind"])}>
      <option value="public_document">公开资料 / JD / 标准</option><option value="private_document">私域岗位资料</option><option value="workspace_observation">真实工作事件观察</option>
    </select></label>
    {mode === "file" ? <div className="material-drop">
      <label><strong>拖动多个附件到这里，或点击选择</strong><input type="file" multiple accept={MATERIAL_ACCEPT} disabled={disabled}
        onChange={(e) => { if (e.target.files?.length) addFiles(Array.from(e.target.files)); e.target.value = ""; }} /></label>
      <small>PDF、Word（DOCX）、TXT、MD、CSV、JSON；每份不超过 5 MB、60000 字符。扫描件请先 OCR。切到 URL 或文本时也可拖入附件。</small>
    </div> : <>
      {(mode === "text" || detected.urls.length < 2) && <label><span>资料标题（可选）</span><input value={title} maxLength={240} disabled={disabled} onChange={(e) => setTitle(e.target.value)} /></label>}
      {mode === "url" ? <label><span>粘贴多个 URL 或含链接的文字</span><textarea aria-label="批量网页链接" value={urlText} disabled={disabled} maxLength={20_000} placeholder={"https://…\nhttps://…\n也可粘贴含链接的列表、Markdown 或一段文字"} onChange={(e) => setUrlText(e.target.value)} /></label>
        : <label><span>资料文本</span><textarea value={text} disabled={disabled} maxLength={60_000} placeholder="粘贴 JD、流程材料或脱敏工作记录…" onChange={(e) => setText(e.target.value)} /></label>}
      {mode === "url" && <small>识别到 {detected.urls.length} 个链接{detected.duplicates ? `，已合并 ${detected.duplicates} 个重复项` : ""}。最多 3 条并行读取，成功项立即加入。</small>}
      <button type="button" disabled={disabled || !(mode === "url" ? urlText.trim() : text.trim())} onClick={() => mode === "url" ? addUrls() : addText()}>{mode === "url" ? `批量添加${detected.urls.length ? ` ${detected.urls.length} 个链接` : "链接"}` : "添加文本到本轮资料"}</button>
      {textLinks.urls.length > 0 && <button type="button" className="material-detected" disabled={disabled} onClick={() => addUrls(text, true)}>识别到 {textLinks.urls.length} 个链接 · 作为网页批量读取</button>}
      <small>{mode === "text" ? "添加文本会保留原文；选择读取链接才会抓取网页。" : "不需要逐条输入。受网站访问限制的链接会单独提示，不影响其他资料。"}</small>
    </>}
    <div role="status" aria-live="polite">已添加 {value.length} / 20 份资料{readingCount || queuedCount ? ` · 读取中 ${readingCount} · 排队 ${queuedCount}` : ""}</div>
    {notice && <small role="status">{notice}</small>}
    {error && <p role="alert" className="material-error">{error}</p>}
    {items.length > 0 && <div className="material-imports" aria-label="资料读取队列">
      {items.map((item) => <article key={item.id} className={`material-import ${item.status}`}>
        <div><b>{item.label}</b><span>{statusLabels[item.status]}{item.elapsedMs !== undefined ? ` · ${(item.elapsedMs / 1000).toFixed(1)} 秒` : ""}</span></div>
        {item.error && <p>{item.error}</p>}
        {pending(item) ? <button type="button" disabled={disabled} onClick={() => queue.current?.cancel(item.id)} aria-label={`取消读取 ${item.label}`}>取消</button> : item.canRetry ? <button type="button" disabled={disabled} onClick={() => retry(item.id)} aria-label={`重试读取 ${item.label}`}>重试</button> : null}
      </article>)}
      <button type="button" disabled={disabled} onClick={() => queue.current?.clearFinished()}>清理已结束记录</button>
    </div>}
    {value.map((source, index) => <details key={`${index}-${source.title}`} className="material-item">
      <summary>{source.title} · {source.content.length} 字符</summary>
      <p>{source.locator || "手动文本"}</p><pre>{source.content.slice(0, 600)}{source.content.length > 600 ? "\n（预览前 600 字符）" : ""}</pre>
      <button type="button" disabled={disabled} aria-label={`移除 ${source.title}`} onClick={() => { valueRef.current = valueRef.current.filter((_, i) => i !== index); callbacks.current.onChange(valueRef.current); }}>移除</button>
    </details>)}
  </section>;
}
