import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { cleanText } from "./search/web-research";
import { materialSource, MAX_MATERIAL_BYTES } from "./source-materials";
import type { SourceInput } from "./build/types";

export function isPublicV4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}

export function validateMaterialUrl(raw: string) {
  const url = new URL(raw);
  if (raw.length > 500 || url.protocol !== "https:" || url.username || url.password ||
    (url.port && url.port !== "443") || !url.hostname.includes(".") ||
    /\.(local|localhost|internal|lan|test|invalid)$/i.test(url.hostname) ||
    (isIP(url.hostname) && !isPublicV4(url.hostname))) throw new Error("请提供公开网站的 HTTPS URL。");
  return url;
}

export async function readMaterialUrl(raw: string, title: string, kind: SourceInput["kind"], signal?: AbortSignal) {
  const isWorker = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  let url = validateMaterialUrl(raw);
  for (let redirects = 0; redirects < 4; redirects++) {
    const resolveViaDoh = async () => {
      // Worker DNS shims may not implement OS lookup. Resolve only the public hostname,
      // then use exactly the same IP validation and pinned TLS connection below.
      const answer = await fetch(`https://dns.alidns.com/resolve?name=${encodeURIComponent(url.hostname)}&type=A`, {
        headers: { accept: "application/dns-json" }, signal,
      });
      if (!answer.ok) throw new Error("域名解析失败，请稍后重试。");
      const data = await answer.json() as { Answer?: Array<{ type: number; data: string }> };
      return (data.Answer || []).filter((item) => item.type === 1).map((item) => ({ address: item.data, family: 4 }));
    };
    const addresses = isWorker ? await resolveViaDoh() : await lookup(url.hostname, { all: true, family: 4 });
    if (!addresses.length || addresses.some(({ address }) => !isPublicV4(address))) throw new Error("不支持访问内网地址。");
    // Node pins the checked IP. Workers use platform HTTPS fetch (public egress only),
    // with redirects disabled so each new host passes the same URL/DNS checks.
    const response = isWorker
      ? await readWorkerPage(url, signal)
      : await new Promise<{ status: number; location?: string; type: string; text: string }>((resolve, reject) => {
      const req = request(url, { signal, family: 4, ...{ autoSelectFamily: false }, lookup: (_host, _options, cb) => cb(null, addresses[0].address, 4),
        headers: { "user-agent": "RoleAtlasSourceReader/1.0" } }, (res) => {
        const status = res.statusCode || 500;
        if (status >= 300 && status < 400) { res.resume(); resolve({ status, location: res.headers.location, type: "", text: "" }); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_MATERIAL_BYTES) { res.destroy(new Error("网页超过 5 MB，请改用文本摘录。")); return; }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status, type: res.headers["content-type"] || "", text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.setTimeout(12_000, () => req.destroy(new Error("网页读取超时，请改用附件或文本。")));
      req.on("error", reject); req.end();
    });
    if (response.status >= 300 && response.status < 400 && response.location) {
      url = validateMaterialUrl(new URL(response.location, url).href); continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error("网页无法读取，请检查链接或改用附件、文本。");
    if (!/text\/(html|plain)|application\/(json|xml)|text\/xml/i.test(response.type)) throw new Error("URL 仅支持文字网页；PDF 或 Word 请下载后上传附件。");
    const pageTitle = response.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return materialSource(title.trim() || cleanText(pageTitle || url.hostname).slice(0, 240), cleanText(response.text), kind, url.href);
  }
  throw new Error("网页跳转次数过多，请提供最终页面地址。");
}

async function readWorkerPage(url: URL, signal?: AbortSignal) {
  const response = await fetch(url, { redirect: "manual", signal, headers: { "user-agent": "RoleAtlasSourceReader/1.0" } });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { status: response.status, location: response.headers.get("location") || undefined, type: "", text: "" };
  }
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_MATERIAL_BYTES) { await reader.cancel(); throw new Error("网页超过 5 MB，请改用文本摘录。"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { status: response.status, type: response.headers.get("content-type") || "", text: new TextDecoder().decode(bytes) };
}
