/** Persisted messages can contain both source citations and graph object citations. */
export type CitationView = {
  kind: "source" | "graph"; handle: string; targetId: string; label: string;
  lifecycle: string; confidence?: number; url?: string;
  artifactKind?: "role_semantic" | "work_process";
};
export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const url = new URL(value); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Display the title without an unsafe link. */ }
}
export function normalizeCitations(value: unknown): CitationView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const targetId = typeof row.targetId === "string" ? row.targetId : "";
    const label = typeof row.label === "string" ? row.label : typeof row.title === "string" ? row.title : "";
    if (!label) return [];
    return [{ kind: targetId ? "graph" as const : "source" as const, targetId, label,
      handle: typeof row.handle === "string" ? row.handle : String(index + 1),
      lifecycle: typeof row.lifecycle === "string" ? row.lifecycle : "",
      confidence: typeof row.confidence === "number" && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1 ? row.confidence : undefined,
      url: safeSourceUrl(row.url), artifactKind: row.artifactKind === "work_process" ? "work_process" as const : "role_semantic" as const }];
  });
}
export function citationCaption(citation: CitationView): string {
  if (citation.kind === "source") return "检索资料";
  return [citation.artifactKind === "work_process" ? "事理" : "语义", citation.lifecycle === "accepted" ? "已接受" : citation.lifecycle === "candidate" ? "候选" : "",
    citation.confidence === undefined ? "" : citation.confidence.toFixed(2)].filter(Boolean).join(" · ");
}
