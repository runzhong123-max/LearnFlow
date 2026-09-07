import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { cleanText } from "./search/web-research";
import { materialSource, MAX_MATERIAL_BYTES } from "./source-materials";
import type { SourceInput } from "./build/types";

export const MATERIAL_URL_TIMEOUT_MS = 12_000;
const DNS_TIMEOUT_MS = 3_000;
type Stage = "url" | "dns" | "page" | "content";
type Address = { address: string; family: number };
type Page = { status: number; location?: string; type: string; text: string };

export class MaterialUrlError extends Error {
  constructor(public code: string, message: string, public status = 422, public stage: Stage = "page", public upstreamStatus?: number) {
    super(message);
    this.name = "MaterialUrlError";
  }
}

/** Transport substitution keeps Node and Workers paths independently testable without network access. */
export type MaterialUrlReaderOptions = {
  platform?: "node" | "worker";
  timeoutMs?: number;
  dnsTimeoutMs?: number;
  lookup?: (hostname: string) => Promise<Address[]>;
  fetch?: typeof fetch;
  request?: typeof request;
};

export function isPublicV4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}

export function validateMaterialUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new MaterialUrlError("URL_INVALID", "请提供公开网站的 HTTPS URL。", 400, "url"); }
  if (raw.length > 500 || url.protocol !== "https:" || url.username || url.password ||
    (url.port && url.port !== "443") || !url.hostname.includes(".") ||
    /\.(local|localhost|internal|lan|test|invalid)$/i.test(url.hostname) ||
    (isIP(url.hostname) && !isPublicV4(url.hostname))) throw new MaterialUrlError("URL_INVALID", "请提供公开网站的 HTTPS URL。", 400, "url");
  url.hash = "";
  return url;
}

function budget(milliseconds: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("读取预算已用尽", "TimeoutError")), milliseconds);
  return { signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal, stop: () => clearTimeout(timer) };
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException("已取消读取", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    // Attach both handlers even when already aborted: an OS DNS lookup cannot be cancelled.
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function readError(error: unknown, signal: AbortSignal, stage: Stage): MaterialUrlError {
  if (error instanceof MaterialUrlError && !signal.aborted) return error;
  const cause = signal.aborted ? signal.reason : error;
  if (cause instanceof Error && cause.name === "TimeoutError") return new MaterialUrlError(
    stage === "dns" ? "URL_DNS_TIMEOUT" : "URL_TIMEOUT",
    stage === "dns" ? "网站域名解析超时，请稍后重试或改用文本。" : "网站响应超时，已停止等待。请稍后重试或粘贴网页正文。", 504, stage,
  );
  if (signal.aborted || (cause instanceof Error && cause.name === "AbortError")) return new MaterialUrlError("URL_CANCELLED", "已取消读取该链接。", 499, stage);
  if (stage === "dns") return new MaterialUrlError("URL_DNS_FAILED", "无法解析网站域名，请检查链接或稍后重试。", 502, stage);
  return new MaterialUrlError("URL_CONNECTION_FAILED", "无法连接网站或连接中断，请稍后重试或粘贴网页正文。", 502, stage);
}

function assertPageHeaders(status: number, type: string, length?: string | number) {
  if (status === 401) throw new MaterialUrlError("URL_LOGIN_REQUIRED", "网站要求登录（401）。请在浏览器打开后粘贴正文，或上传附件。", 422, "page", status);
  if (status === 403) throw new MaterialUrlError("URL_FORBIDDEN", "网站拒绝自动读取（403），可能需要登录或验证码。请在浏览器打开后粘贴正文，或上传附件。", 422, "page", status);
  if (status === 429) throw new MaterialUrlError("URL_RATE_LIMITED", "网站请求过于频繁（429），请稍后重试。", 429, "page", status);
  if (status === 404 || status === 410) throw new MaterialUrlError("URL_NOT_FOUND", `网页不存在或已下架（${status}），请检查链接。`, 422, "page", status);
  if (status < 200 || status >= 300) throw new MaterialUrlError("URL_HTTP_ERROR", `网站返回错误（${status}），请稍后重试或改用文本。`, 502, "page", status);
  if (!/text\/(html|plain)|application\/(json|xml|xhtml\+xml)|text\/xml/i.test(type)) throw new MaterialUrlError("URL_UNSUPPORTED_CONTENT", "URL 仅支持文字网页；PDF 或 Word 请下载后上传附件。", 415, "content");
  if (Number(length) > MAX_MATERIAL_BYTES) throw tooLarge();
}
function tooLarge() { return new MaterialUrlError("URL_TOO_LARGE", "网页超过 5 MB，请改用文本摘录。", 413, "content"); }
function decode(bytes: Uint8Array, type: string) {
  const charset = type.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] || "utf-8";
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

async function readWorkerPage(url: URL, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Page> {
  const response = await abortable(fetchImpl(url, { redirect: "manual", signal, headers: { "user-agent": "RoleAtlasSourceReader/1.0", accept: "text/html, text/plain, application/json, application/xml" } }), signal);
  const type = response.headers.get("content-type") || "";
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    return { status: response.status, location: response.headers.get("location") || undefined, type, text: "" };
  }
  try { assertPageHeaders(response.status, type, response.headers.get("content-length") || undefined); }
  catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal); if (done) break;
      size += value.byteLength;
      if (size > MAX_MATERIAL_BYTES) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { status: response.status, type, text: decode(bytes, type) };
}

function readNodePage(url: URL, addresses: Address[], signal: AbortSignal, requestImpl: typeof request): Promise<Page> {
  return abortable(new Promise<Page>((resolve, reject) => {
    const req = requestImpl(url, { signal, family: 4, ...{ autoSelectFamily: false },
      lookup: (_host, _options, cb) => cb(null, addresses[0].address, 4),
      headers: { "user-agent": "RoleAtlasSourceReader/1.0", accept: "text/html, text/plain, application/json, application/xml", "accept-encoding": "identity" },
    }, (res) => {
      const status = res.statusCode || 500, type = res.headers["content-type"] || "";
      if (status >= 300 && status < 400) { res.destroy(); resolve({ status, location: res.headers.location, type, text: "" }); return; }
      try { assertPageHeaders(status, type, res.headers["content-length"]); }
      catch (error) { res.destroy(); reject(error); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_MATERIAL_BYTES) { reject(tooLarge()); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("aborted", () => reject(new MaterialUrlError("URL_CONNECTION_FAILED", "网站在正文传输完成前断开，请重试或改用文本。", 502, "content")));
      res.on("error", reject);
      res.on("end", () => resolve({ status, type, text: decode(Buffer.concat(chunks), type) }));
    });
    req.on("error", reject); req.end();
  }), signal);
}

export async function readMaterialUrl(raw: string, title: string, kind: SourceInput["kind"], signal?: AbortSignal, options: MaterialUrlReaderOptions = {}) {
  const isWorker = options.platform ? options.platform === "worker" : typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  const overall = budget(Math.max(1, options.timeoutMs || MATERIAL_URL_TIMEOUT_MS), signal);
  const fetchImpl = options.fetch || fetch;
  const addressesByHost = new Map<string, Address[]>();
  let stage: Stage = "url";
  try {
    if (title.trim().length > 240) throw new MaterialUrlError("URL_REQUEST_INVALID", "资料标题不能超过 240 字符。", 400, "url");
    let url = validateMaterialUrl(raw);
    for (let redirects = 0; redirects < 4; redirects++) {
      overall.signal.throwIfAborted();
      stage = "dns";
      let addresses = addressesByHost.get(url.hostname);
      if (!addresses) {
        const dns = budget(Math.max(1, options.dnsTimeoutMs || DNS_TIMEOUT_MS), overall.signal);
        try {
          const resolution = options.lookup ? options.lookup(url.hostname) : isWorker ? (async () => {
            // Workers do not provide OS lookup. Check every A record before public HTTPS fetch.
            const answer = await fetchImpl(`https://dns.alidns.com/resolve?name=${encodeURIComponent(url.hostname)}&type=A`, { headers: { accept: "application/dns-json" }, signal: dns.signal });
            if (!answer.ok) throw new Error("DNS_HTTP_ERROR");
            const data = await answer.json() as { Answer?: Array<{ type: number; data: string }> };
            return (data.Answer || []).filter((item) => item.type === 1).map((item) => ({ address: item.data, family: 4 }));
          })() : lookup(url.hostname, { all: true, family: 4 });
          addresses = await abortable(resolution, dns.signal);
        } catch (error) { throw readError(error, dns.signal, "dns"); }
        finally { dns.stop(); }
        if (!addresses.length) throw new MaterialUrlError("URL_DNS_FAILED", "网站域名没有可用的公网 IPv4 地址。", 502, "dns");
        if (addresses.some(({ address }) => !isPublicV4(address))) throw new MaterialUrlError("URL_PRIVATE_ADDRESS", "不支持访问内网地址。", 400, "dns");
        addressesByHost.set(url.hostname, addresses);
      }
      stage = "page";
      // Node pins the checked address; Workers retain platform public egress. Every redirect is checked again.
      const response = isWorker ? await readWorkerPage(url, overall.signal, fetchImpl) : await readNodePage(url, addresses, overall.signal, options.request || request);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location) throw new MaterialUrlError("URL_REDIRECT_INVALID", "网站跳转未提供目标地址，请在浏览器打开后复制最终链接。", 422);
        let target: URL;
        try { target = new URL(response.location, url); }
        catch { throw new MaterialUrlError("URL_REDIRECT_INVALID", "网站跳转地址无效，请提供最终页面地址。", 422); }
        url = validateMaterialUrl(target.href); continue;
      }
      stage = "content";
      const pageTitle = response.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      const isHtml = /html/i.test(response.type);
      const body = isHtml ? response.text.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? response.text : response.text;
      const text = cleanText(body);
      const shellMessage = /^(?:loading|加载中|載入中|正在加载|just a moment|checking your browser)[\s.!…。]*$/i.test(text);
      const javascriptNotice = /(?:enable|启用|啟用|开启).{0,30}javascript|(?:without|requires?|需要).{0,25}javascript|javascript.{0,25}(?:enabled|disabled|启用|啟用)/i.test(text);
      // Short server-rendered pages may also use app/root containers; those are not proof of a JS shell.
      if (isHtml && /<script\b/i.test(response.text) && (!text || shellMessage || (text.length < 600 && javascriptNotice))) {
        throw new MaterialUrlError("URL_JAVASCRIPT_REQUIRED", "该网页需要 JavaScript 或浏览器验证，未返回可读取的正文。请在浏览器打开后粘贴正文，或上传附件。", 422, "content");
      }
      if (!text) throw new MaterialUrlError("URL_EMPTY_CONTENT", "网页未返回可读取的正文，请改用文本或附件。", 422, "content");
      if (text.length > 60_000) throw new MaterialUrlError("URL_TEXT_TOO_LONG", "网页正文超过 60000 字符，请选取相关内容后分段添加。", 413, "content");
      return materialSource(title.trim() || cleanText(pageTitle || "").slice(0, 240) || url.hostname, text, kind, url.href);
    }
    throw new MaterialUrlError("URL_REDIRECT_LIMIT", "网页跳转次数过多，请提供最终页面地址。", 422);
  } catch (error) { throw readError(error, overall.signal, stage); }
  finally { overall.stop(); }
}
