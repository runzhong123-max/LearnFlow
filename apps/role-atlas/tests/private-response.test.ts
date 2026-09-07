import assert from "node:assert/strict";
import test from "node:test";
import { privateAppResponse } from "../lib/private-response";

test("private API, exports and RSC responses cannot be cached between users", async () => {
  for (const path of ["/api/projects", "/api/registry", "/api/releases/private/export", "/projects/owned?_rsc=1", "/registry"]) {
    const result = privateAppResponse(new Request(`https://roles.example${path}`), new Response("private data", { headers: { "Cache-Control": "public, max-age=3600", Vary: "RSC" } }));
    assert.equal(result.headers.get("Cache-Control"), "private, no-store");
    assert.equal(result.headers.get("CDN-Cache-Control"), "no-store");
    assert.equal(result.headers.get("Vary"), "RSC, Cookie");
    assert.equal(await result.text(), "private data");
  }
});

test("public discovery retains its explicit cache policy", () => {
  const response = new Response("public", { headers: { "Cache-Control": "public, max-age=60" } });
  assert.equal(privateAppResponse(new Request("https://roles.example/api/hub/search?q=cloud"), response), response);
});
