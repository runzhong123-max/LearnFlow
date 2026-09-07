import { strFromU8, unzipSync } from "fflate";
import { sourceInputSchema, type SourceInput } from "./build/types";

export const MAX_MATERIAL_BYTES = 5 * 1024 * 1024;
export const MATERIAL_ACCEPT = ".pdf,.docx,.txt,.md,.csv,.json";

export function materialSource(title: string, content: string, kind: SourceInput["kind"], locator?: string): SourceInput {
  const text = content.trim();
  if (!text) throw new Error("未提取到文字。扫描件请先 OCR，或改用文本输入。");
  if (text.length > 60_000) throw new Error("资料超过 60000 字符，请拆分后添加；不会自动截断内容。");
  return sourceInputSchema.parse({ title, content: text, kind, locator, fetchedAt: new Date().toISOString() });
}

export async function parseMaterialFile(file: File, kind: SourceInput["kind"]): Promise<SourceInput> {
  if (!file.size || file.size > MAX_MATERIAL_BYTES) throw new Error("请选择非空且不超过 5 MB 的附件。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.toLowerCase().split(".").pop();
  let content: string;
  if (ext === "pdf") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    try {
      if (pdf.numPages > 100) throw new Error("PDF 超过 100 页，请拆分后添加。");
      content = (await extractText(pdf, { mergePages: true })).text;
    } finally { await pdf.loadingTask.destroy(); }
  } else if (ext === "docx") {
    const entries = unzipSync(bytes, { filter: (entry) => {
      if (entry.name !== "word/document.xml") return false;
      if (entry.originalSize > MAX_MATERIAL_BYTES) throw new Error("Word 文档解压后过大，请拆分。");
      return true;
    } });
    if (!entries["word/document.xml"]) throw new Error("不是有效的 DOCX 文档。");
    content = strFromU8(entries["word/document.xml"])
      .replace(/<w:tab\b[^>]*\/>/g, "\t").replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  } else if (["txt", "md", "csv", "json"].includes(ext || "")) {
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("文本附件请使用 UTF-8 编码。"); }
    if (content.includes("\u0000")) throw new Error("附件包含二进制内容，请选择文字文件。");
  } else throw new Error("支持 PDF、DOCX、TXT、Markdown、CSV 和 JSON。");
  return materialSource(file.name, content, kind, `attachment:${file.name}`);
}
