import type { RoleCardNode } from "@/app/components/RoleCardView";

export type ChatDraft = { text: string; references: RoleCardNode[] };
export const emptyChatDraft: ChatDraft = { text: "", references: [] };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const maxAgeMs = 24 * 60 * 60 * 1_000;

export function chatDraftKey(subjectId: string, projectId: string | undefined, conversationId: string, snapshotId: string) {
  if (!subjectId || (projectId && !conversationId)) return undefined;
  return `role-atlas.chat-draft.v1:${JSON.stringify([subjectId, projectId || "bundled", conversationId || "sample", snapshotId])}`;
}

export function saveChatDraft(storage: Storage, key: string | undefined, draft: ChatDraft, now = Date.now()) {
  if (!key) return;
  try {
    if (!draft.text && !draft.references.length) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ savedAt: now, text: draft.text.slice(0, 12_000), references: draft.references.slice(0, 12) }));
  } catch { /* Private browsing or a full tab storage must not prevent sending. */ }
}

export function readChatDraft(storage: Storage, key: string | undefined, now = Date.now()): ChatDraft {
  if (!key) return emptyChatDraft;
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    if (!value || typeof value.savedAt !== "number" || now - value.savedAt > maxAgeMs || value.savedAt > now || typeof value.text !== "string" || !Array.isArray(value.references)) return emptyChatDraft;
    const references = value.references.filter((node: unknown): node is RoleCardNode => Boolean(node) && typeof node === "object" && typeof (node as RoleCardNode).id === "string" && typeof (node as RoleCardNode).label === "string" && typeof (node as RoleCardNode).type === "string").slice(0, 12);
    return { text: value.text.slice(0, 12_000), references };
  } catch { return emptyChatDraft; }
}

/** Restore legacy persisted references (targetId) without inventing current-version identity. */
export function restoreChatReferences(values: unknown[], available: RoleCardNode[] = [], snapshotId?: string): RoleCardNode[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const ref = value as Record<string, unknown>;
    const id = typeof ref.targetId === "string" ? ref.targetId : typeof ref.id === "string" ? ref.id : "";
    if (!id) return [];
    const refSnapshot = typeof ref.snapshotId === "string" ? ref.snapshotId : undefined;
    const current = (!refSnapshot || refSnapshot === snapshotId) ? available.find((node) => node.id === id) : undefined;
    return [{ ...(current || { id, type: typeof ref.type === "string" ? ref.type : "reference", label: typeof ref.label === "string" ? ref.label : `历史节点 · ${id}`, summary: "引用固定于发送时的岗位快照。", ring: 0, lifecycle: "candidate", assertion_refs: [], evidence_summary: { binding_refs: [], source_refs: [], max_confidence: 0, has_segment_evidence: false, temporal_status_counts: {} }, data: {} }),
      ...(refSnapshot ? { snapshotId: refSnapshot } : {}),
      ...(typeof ref.packageId === "string" ? { packageId: ref.packageId } : {}),
      ...(typeof ref.packageVersion === "string" ? { packageVersion: ref.packageVersion } : {}),
    } as RoleCardNode];
  });
}

export async function requireAgentStream(response: Response) {
  if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) throw new Error("登录状态已失效或无权访问。问题与引用已保留，请重新登录后重试。");
  if (!response.ok || !response.body) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error || `请求失败（${response.status}），问题与引用已保留。`);
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) throw new Error("未收到有效的岗位回答流。问题与引用已保留，请检查登录状态后重试。");
  return response.body;
}
