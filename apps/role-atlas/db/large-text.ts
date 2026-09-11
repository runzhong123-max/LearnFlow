/**
 * D1 (workerd SQLite) rejects a single column value above roughly 2 MB with
 * SQLITE_TOOBIG. Run checkpoints/results and committed packages carry full
 * graph state, and they cross that limit as research budgets grow.
 *
 * Large values are split into UTF-8-safe chunks in `chunked_blobs`; the owner
 * column stores a `chunked:v1:<count>` marker so every read path can
 * reassemble deterministically. Values at or below LARGE_TEXT_THRESHOLD_BYTES
 * are stored inline exactly as before — existing rows and small writes are
 * untouched.
 */

export const LARGE_TEXT_THRESHOLD_BYTES = 1_000_000;
export const LARGE_TEXT_CHUNK_BYTES = 800_000;
const MARKER_PREFIX = "chunked:v1:";

export type LargeTextOwner = { table: string; id: string; column: string };

export function isChunkedLargeText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(MARKER_PREFIX);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Split on UTF-8 character boundaries so every chunk decodes independently. */
export function chunkLargeText(text: string, chunkBytes = LARGE_TEXT_CHUNK_BYTES): string[] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= chunkBytes) return [text];
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(offset + chunkBytes, bytes.byteLength);
    while (end > offset && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(decoder.decode(bytes.subarray(offset, end)));
    offset = end;
  }
  return chunks;
}

/**
 * Persist `text` for the owner column and return the value to store inline.
 * Returns the text itself when small enough; otherwise writes chunks and
 * returns the marker. Stale chunks from previous writes are always cleared,
 * so repeated checkpoint writes cannot accumulate orphan rows.
 */
export async function storeLargeText(d1: D1Database, owner: LargeTextOwner, text: string | null): Promise<string | null> {
  await d1.prepare("DELETE FROM chunked_blobs WHERE owner_table=? AND owner_id=? AND column_name=?")
    .bind(owner.table, owner.id, owner.column).run();
  if (text === null) return null;
  if (byteLength(text) <= LARGE_TEXT_THRESHOLD_BYTES) return text;
  const chunks = chunkLargeText(text);
  await d1.batch(chunks.map((chunk, seq) => d1
    .prepare("INSERT INTO chunked_blobs(owner_table,owner_id,column_name,seq,chunk) VALUES(?,?,?,?,?)")
    .bind(owner.table, owner.id, owner.column, seq, chunk)));
  return `${MARKER_PREFIX}${chunks.length}`;
}

/** Reassemble a chunked value; returns inline values unchanged. */
export async function loadLargeText(d1: D1Database, owner: LargeTextOwner, value: string | null): Promise<string | null> {
  if (!isChunkedLargeText(value)) return value;
  const expected = Number(value.slice(MARKER_PREFIX.length));
  const rows = await d1.prepare("SELECT chunk FROM chunked_blobs WHERE owner_table=? AND owner_id=? AND column_name=? ORDER BY seq")
    .bind(owner.table, owner.id, owner.column).all<{ chunk: string }>();
  if (!Number.isInteger(expected) || rows.results.length !== expected) {
    throw new Error(`CHUNKED_BLOB_INCOMPLETE:${owner.table}.${owner.column}:${owner.id}`);
  }
  return rows.results.map((row) => row.chunk).join("");
}
