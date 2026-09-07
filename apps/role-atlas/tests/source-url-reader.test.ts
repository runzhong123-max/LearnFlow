import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ClientRequest } from "node:http";
import type { RequestOptions, request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { MaterialUrlError, readMaterialUrl, type MaterialUrlReaderOptions } from "@/lib/source-url";
import { MAX_MATERIAL_BYTES } from "@/lib/source-materials";

const publicAddresses = [{ address: "1.1.1.1", family: 4 }];
const article = '<html><head><title>网络运维岗位</title></head><body><article>负责网络部署、故障定位与回滚。</article><script>analytics()</script></body></html>';
type PageFixture = { status?: number; headers?: Record<string, string>; body?: string | Uint8Array; stalled?: "headers" | "body" };

// Substitute only HTTPS transport; production validation, resolver policy,
// deadlines, redirects, extraction and errors run unchanged on both paths.
function transport(platform: "node" | "worker", pages: PageFixture[]) {
  const urls: string[] = [], signals: AbortSignal[] = [], pinned: string[] = [];
  let cancelled = 0;
  const next = (url: string, signal: AbortSignal) => { urls.push(url); signals.push(signal); const page = pages.shift(); assert.ok(page, "unexpected extra request"); return page; };
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "manual");
    const page = next(String(input), init!.signal!);
    if (page.stalled === "headers") return new Promise<Response>(() => {});
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (page.body) controller.enqueue(typeof page.body === "string" ? new TextEncoder().encode(page.body) : page.body);
        if (page.stalled !== "body") controller.close();
      },
      cancel() { cancelled++; },
    });
    return new Response(body, { status: page.status || 200, headers: { "content-type": "text/html; charset=utf-8", ...page.headers } });
  };
  const requestImpl = ((input: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const signal = options.signal as AbortSignal;
    const page = next(input.href, signal);
    (options.lookup as unknown as (host: string, opts: object, cb: (error: unknown, ip: string, family: number) => void) => void)(input.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(family, 4); pinned.push(address);
    });
    const req = new EventEmitter() as ClientRequest;
    const res = new PassThrough() as unknown as IncomingMessage;
    res.statusCode = page.status || 200; res.headers = { "content-type": "text/html; charset=utf-8", ...page.headers };
    const abort = () => { cancelled++; res.destroy(); req.emit("error", signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    res.on("close", () => signal.removeEventListener("abort", abort));
    req.end = (() => {
      queueMicrotask(() => {
        if (page.stalled === "headers") return;
        callback(res);
        if (res.destroyed) { cancelled++; return; }
        if (page.body) (res as unknown as PassThrough).write(page.body);
        if (page.stalled !== "body") (res as unknown as PassThrough).end();
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as unknown as typeof httpsRequest;
  const options: MaterialUrlReaderOptions = { platform, lookup: async () => publicAddresses, fetch: fetchImpl, request: requestImpl, timeoutMs: 500, dnsTimeoutMs: 200 };
  return { options, urls, signals, pinned, cancelled: () => cancelled };
}
function errorCode(code: string, status?: number, upstreamStatus?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof MaterialUrlError);
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    if (upstreamStatus) assert.equal(error.upstreamStatus, upstreamStatus);
    return true;
  };
}

for (const platform of ["node", "worker"] as const) {
  test(`${platform}: extracts pages with scripts, preserves title, provenance and checked Node address`, async () => {
    const h = transport(platform, [{ body: article }]);
    const result = await readMaterialUrl("https://example.com/job#section", "", "public_document", undefined, h.options);
    assert.equal(result.title, "网络运维岗位"); assert.equal(result.content, "负责网络部署、故障定位与回滚。");
    assert.equal(result.locator, "https://example.com/job"); assert.equal(result.kind, "public_document"); assert.ok(result.fetchedAt);
    assert.deepEqual(h.urls, ["https://example.com/job"]);
    if (platform === "node") assert.deepEqual(h.pinned, ["1.1.1.1"]);
  });

  test(`${platform}: rejects 403/429 at headers without waiting for endless bodies`, async () => {
    for (const [status, code, resultStatus] of [[403, "URL_FORBIDDEN", 422], [429, "URL_RATE_LIMITED", 429]] as const) {
      const h = transport(platform, [{ status, stalled: "body" }]);
      await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, h.options), errorCode(code, resultStatus, status));
      assert.equal(h.cancelled(), 1); assert.equal(h.urls.length, 1);
      assert.equal(h.signals[0].aborted, false, "header error must not wait for timeout");
    }
  });

  test(`${platform}: rejects unsupported/oversized headers and bounds streamed bodies`, async () => {
    for (const [page, code] of [
      [{ headers: { "content-type": "application/pdf" }, stalled: "body" }, "URL_UNSUPPORTED_CONTENT"],
      [{ headers: { "content-length": String(MAX_MATERIAL_BYTES + 1) }, stalled: "body" }, "URL_TOO_LARGE"],
      [{ body: new Uint8Array(MAX_MATERIAL_BYTES + 1) }, "URL_TOO_LARGE"],
    ] as Array<[PageFixture, string]>) {
      const h = transport(platform, [page]);
      await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, h.options), errorCode(code));
    }
  });

  test(`${platform}: overall deadline covers stalled headers and bodies`, async () => {
    for (const stalled of ["headers", "body"] as const) {
      const h = transport(platform, [{ stalled }]);
      await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, { ...h.options, timeoutMs: 15 }), errorCode("URL_TIMEOUT", 504));
      assert.equal(h.signals[0].aborted, true);
      if (platform === "node" || stalled === "body") assert.equal(h.cancelled(), 1);
    }
  });

  test(`${platform}: caller cancellation is distinguishable from timeout/failure`, async () => {
    const beforeStart = new AbortController(); beforeStart.abort();
    const unused = transport(platform, []);
    await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", beforeStart.signal, unused.options), errorCode("URL_CANCELLED", 499));
    assert.equal(unused.urls.length, 0);
    const controller = new AbortController(); const h = transport(platform, [{ stalled: "body" }]);
    const pending = readMaterialUrl("https://example.com", "", "public_document", controller.signal, h.options);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(pending, errorCode("URL_CANCELLED", 499)); assert.equal(h.cancelled(), 1);

    const dnsController = new AbortController(); let resolveDns!: (addresses: typeof publicAddresses) => void;
    const dnsPending = readMaterialUrl("https://example.com", "", "public_document", dnsController.signal, {
      ...unused.options, lookup: () => new Promise(resolve => { resolveDns = resolve; }),
    });
    dnsController.abort(); await assert.rejects(dnsPending, errorCode("URL_CANCELLED", 499));
    resolveDns(publicAddresses); await new Promise(resolve => setImmediate(resolve));
    assert.equal(unused.urls.length, 0, "late OS DNS completion must not begin a cancelled HTTPS request");
  });

  test(`${platform}: DNS deadline and all returned addresses are checked before HTTPS`, async () => {
    const h = transport(platform, []);
    await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, {
      ...h.options, dnsTimeoutMs: 10, lookup: () => new Promise(() => {}),
    }), errorCode("URL_DNS_TIMEOUT", 504));
    await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, {
      ...h.options, lookup: async () => [...publicAddresses, { address: "127.0.0.1", family: 4 }],
    }), errorCode("URL_PRIVATE_ADDRESS", 400));
    assert.equal(h.urls.length, 0);
  });

  test(`${platform}: redirects revalidate host/DNS, reusing only approved same-host results`, async () => {
    const h = transport(platform, [
      { status: 302, headers: { location: "/final" }, stalled: "body" },
      { status: 301, headers: { location: "https://private.example.com/job" }, stalled: "body" },
    ]);
    const lookedUp: string[] = [];
    await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, {
      ...h.options, lookup: async host => { lookedUp.push(host); return host.startsWith("private.") ? [{ address: "10.0.0.1", family: 4 }] : publicAddresses; },
    }), errorCode("URL_PRIVATE_ADDRESS", 400));
    assert.deepEqual(lookedUp, ["example.com", "private.example.com"]);
    assert.deepEqual(h.urls, ["https://example.com/", "https://example.com/final"]); assert.equal(h.cancelled(), 2);
    const insecure = transport(platform, [{ status: 302, headers: { location: "http://example.com/final" } }]);
    await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, insecure.options), errorCode("URL_INVALID", 400));
    assert.equal(insecure.urls.length, 1);
  });

  test(`${platform}: JavaScript shells and empty pages never become successful materials`, async () => {
    for (const [body, code] of [
      ['<html><title>岗位</title><body><div id="app"></div><script src="/app.js"></script></body></html>', "URL_JAVASCRIPT_REQUIRED"],
      ['<body><noscript>Please enable JavaScript to continue.</noscript><script src="/app.js"></script></body>', "URL_JAVASCRIPT_REQUIRED"],
      ["<body><noscript>We're sorry but vue-start doesn't work properly without JavaScript enabled. Please enable it to continue.</noscript><script src='/app.js'></script></body>", "URL_JAVASCRIPT_REQUIRED"],
      ['<body><div id="app">Loading...</div><script src="/app.js"></script></body>', "URL_JAVASCRIPT_REQUIRED"],
      ["<html><title>Empty page</title><body> </body></html>", "URL_EMPTY_CONTENT"],
      ["<html><title>Title is not evidence</title><body></body></html>", "URL_EMPTY_CONTENT"],
    ]) {
      const h = transport(platform, [{ body }]);
      await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, h.options), errorCode(code, 422));
    }
    const rendered = transport(platform, [{ body: '<body><div id="app"><p>负责部署与回滚。</p></div><script src="/app.js"></script></body>' }]);
    assert.equal((await readMaterialUrl("https://example.com", "", "public_document", undefined, rendered.options)).content, "负责部署与回滚。");
  });
}

test("Workers DoH has its own budget and validates all A records without OS DNS", async () => {
  const requested: string[] = [];
  const options: MaterialUrlReaderOptions = {
    platform: "worker", dnsTimeoutMs: 10, timeoutMs: 500,
    fetch: async (input, init) => {
      requested.push(String(input)); assert.ok(init?.signal);
      return Response.json({ Answer: [{ type: 5, data: "alias.example.com" }, { type: 1, data: "1.1.1.1" }, { type: 1, data: "169.254.169.254" }] });
    },
  };
  await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, options), errorCode("URL_PRIVATE_ADDRESS"));
  assert.deepEqual(requested, ["https://dns.alidns.com/resolve?name=example.com&type=A"]);
  let dnsSignal: AbortSignal | undefined;
  await assert.rejects(readMaterialUrl("https://example.com", "", "public_document", undefined, {
    ...options, fetch: async (_url, init) => { dnsSignal = init!.signal!; return new Promise<Response>(() => {}); },
  }), errorCode("URL_DNS_TIMEOUT", 504));
  assert.equal(dnsSignal?.aborted, true);
});

// Exercise the real API route with only auth and outbound reading substituted.
async function routeHarness() {
  const key = `__materialUrlRoute${Math.random().toString(36).slice(2)}`;
  const state = { denied: false, calls: 0, error: undefined as MaterialUrlError | undefined, signal: undefined as AbortSignal | undefined };
  (globalThis as unknown as Record<string, unknown>)[key] = {
    authorizeApiRequest: async () => state.denied ? Response.json({ error: "LOGIN_REQUIRED" }, { status: 401 }) : undefined,
    MaterialUrlError,
    readMaterialUrl: async (_url: string, _title: string, _kind: string, signal: AbortSignal) => {
      state.calls++; state.signal = signal; if (state.error) throw state.error;
      return { title: "Example", content: "Job requirements", kind: "public_document", locator: "https://example.com" };
    },
  };
  let source = await readFile(resolve("app/api/source-materials/route.ts"), "utf8");
  source = source.replace('import { authorizeApiRequest } from "@/lib/access";', `const { authorizeApiRequest } = globalThis[${JSON.stringify(key)}];`)
    .replace('import { MaterialUrlError, readMaterialUrl } from "@/lib/source-url";', `const { MaterialUrlError, readMaterialUrl } = globalThis[${JSON.stringify(key)}];`)
    .replace(/(["'])@\/([^"']+)\1/gu, (_, _quote, path) => JSON.stringify(pathToFileURL(resolve(`${path}.ts`)).href));
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const route = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`) as { POST: (request: Request) => Promise<Response> };
  const request = (body: unknown = { url: "https://example.com", kind: "public_document" }, origin?: string) => new Request("https://roles.example/api/source-materials", {
    method: "POST", headers: origin ? { origin } : {}, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { route, state, request, cleanup: () => { delete (globalThis as unknown as Record<string, unknown>)[key]; } };
}

test("API preserves auth/origin checks and returns per-URL failure codes and elapsed time", async () => {
  const h = await routeHarness();
  try {
    h.state.denied = true; assert.equal((await h.route.POST(h.request())).status, 401); h.state.denied = false;
    assert.equal((await h.route.POST(h.request(undefined, "https://untrusted.example"))).status, 403);
    for (const body of ["{broken", { url: 42 }, { url: "https://example.com", kind: "unknown" }, "x".repeat(4097)]) {
      const response = await h.route.POST(h.request(body)); assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, "URL_REQUEST_INVALID");
    }
    assert.equal(h.state.calls, 0);
    h.state.error = new MaterialUrlError("URL_FORBIDDEN", "网站拒绝自动读取（403）。", 422, "page", 403);
    const response = await h.route.POST(h.request());
    assert.equal(response.status, 422); assert.equal(response.headers.get("cache-control"), "private, no-store");
    const json = await response.json() as { code: string; stage: string; upstreamStatus: number; elapsedMs: number; error: string };
    assert.equal(json.code, "URL_FORBIDDEN"); assert.equal(json.stage, "page"); assert.equal(json.upstreamStatus, 403);
    assert.ok(json.elapsedMs >= 0); assert.match(json.error, /403/);
    h.state.error = undefined;
    const request = h.request(); const success = await h.route.POST(request);
    assert.equal(success.status, 200); assert.equal(h.state.signal, request.signal);
    assert.equal((await success.json() as { source: { title: string } }).source.title, "Example");
  } finally { h.cleanup(); }
});
