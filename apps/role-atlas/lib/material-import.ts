/** Recognize links in pasted prose, Markdown and URL lists without calling a model. */
export function detectMaterialUrls(text: string) {
  const found: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const separated = text.replace(/[,;](?=(?:https?:\/\/|www\.))/giu, "\n");
  for (const match of separated.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`\[\]\u201c\u201d\u2018\u2019，。；、！？]+/giu)) {
    let raw = match[0].replace(/[，。；、！？,;.!?]+$/u, "");
    // Strip Markdown/prose closing brackets, retaining balanced URL parentheses.
    for (const [open, close] of [["(", ")"], ["[", "]"], ["（", "）"], ["【", "】"]]) {
      while (raw.endsWith(close) && raw.split(close).length > raw.split(open).length) raw = raw.slice(0, -close.length);
    }
    raw = raw.replace(/[，。；、！？,;.!?]+$/u, "");
    const url = /^www\./iu.test(raw) ? `https://${raw}` : raw;
    const key = materialUrlKey(url);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); found.push(url);
  }
  return { urls: found, duplicates };
}

export function materialUrlKey(raw: string) {
  try { const url = new URL(raw); url.hash = ""; return url.href; }
  catch { return raw.trim(); }
}

export type ImportStatus = "queued" | "reading" | "ready" | "failed" | "cancelled";
export type ImportItem<T> = { id: string; label: string; input: T; status: ImportStatus; error?: string; elapsedMs?: number; canRetry: boolean };

/** Bounded local queue: each result is delivered independently and cancelled work cannot append sources. */
export class MaterialImportQueue<T, R> {
  private items: ImportItem<T>[] = [];
  private active = new Map<string, AbortController>();
  private disposed = false;
  constructor(private options: {
    concurrency: number;
    load: (input: T, signal: AbortSignal) => Promise<R>;
    onResult: (result: R, input: T) => void;
    onUpdate: (items: ImportItem<T>[], busy: boolean) => void;
  }) {}
  private publish() {
    if (!this.disposed) this.options.onUpdate(this.items.map((item) => ({ ...item, canRetry: ["failed", "cancelled"].includes(item.status) && !this.active.has(item.id) })), this.items.some((item) => ["queued", "reading"].includes(item.status)));
  }
  enqueue(items: Array<{ id: string; label: string; input: T }>) {
    if (this.disposed) return;
    this.items.push(...items.map((item) => ({ ...item, status: "queued" as const, canRetry: false })));
    this.publish(); this.pump();
  }
  private pump() {
    if (this.disposed) return;
    while (this.active.size < this.options.concurrency) {
      const item = this.items.find((entry) => entry.status === "queued");
      if (!item) break;
      const controller = new AbortController();
      this.active.set(item.id, controller); item.status = "reading";
      const started = Date.now(); this.publish();
      void Promise.resolve().then(() => this.options.load(item.input, controller.signal)).then((result) => {
        if (controller.signal.aborted || this.disposed) return;
        this.options.onResult(result, item.input); item.status = "ready";
      }).catch((error) => {
        if (controller.signal.aborted || this.disposed) return;
        item.status = "failed";
        item.error = error instanceof Error ? error.message : "读取失败，请重试。";
      }).finally(() => {
        this.active.delete(item.id); item.elapsedMs = Date.now() - started;
        this.publish(); this.pump();
      });
    }
  }
  cancel(id: string) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || !["queued", "reading"].includes(item.status)) return;
    item.status = "cancelled"; this.active.get(id)?.abort(); this.publish(); this.pump();
  }
  retry(id: string) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || this.active.has(id) || !["failed", "cancelled"].includes(item.status)) return;
    item.status = "queued"; item.error = undefined; item.elapsedMs = undefined;
    this.publish(); this.pump();
  }
  clearFinished() { this.items = this.items.filter((item) => ["queued", "reading"].includes(item.status) || this.active.has(item.id)); this.publish(); }
  dispose() { this.disposed = true; for (const controller of this.active.values()) controller.abort(); }
}
