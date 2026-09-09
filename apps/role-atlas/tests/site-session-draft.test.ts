import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

const script = readFileSync(new URL("../../../frontend/public/site-session.js", import.meta.url), "utf8");
async function runSessionBar(preserveDraft: boolean, statusOk = true) {
  const window = new EventTarget();
  const redirects: string[] = [];
  const events: Array<{ href: string }> = [];
  if (preserveDraft) window.addEventListener("learnflow:session-expired", (event) => {
    event.preventDefault();
    events.push({ href: (event as Event & { detail: { loginUrl: string } }).detail.loginUrl });
  });
  const element = () => ({ style: {}, append() {}, setAttribute() {}, textContent: "" });
  runInNewContext(script, {
    window, CustomEvent: class extends Event { detail; constructor(type: string, options: CustomEventInit) { super(type, options); this.detail = options.detail; } },
    document: { getElementById() { return null; }, createElement: element, body: element(), addEventListener() {}, hidden: false },
    location: { hostname: "roles.learnflow.club", href: "https://roles.learnflow.club/projects/p?conversation=c", pathname: "/projects/p", replace: (url: string) => redirects.push(url) },
    URL, URLSearchParams, fetch: async () => ({ ok: statusOk, json: async () => ({ authenticated: false }) }), setInterval() {},
  });
  await setImmediate();
  return { redirects, events };
}

test("Role Atlas 接管失效通知时保留页面，登录链接保留项目和对话", async () => {
  const { redirects, events } = await runSessionBar(true);
  assert.deepEqual(redirects, []);
  assert.equal(events.length, 1);
  const url = new URL(events[0].href);
  assert.equal(url.origin, "https://learn.learnflow.club");
  assert.equal(url.searchParams.get("return_to"), "https://roles.learnflow.club/projects/p?conversation=c");
});

test("未订阅的其他页面仍按原逻辑跳登录，身份服务故障不作失效判断", async () => {
  assert.equal((await runSessionBar(false)).redirects.length, 1);
  assert.equal((await runSessionBar(false, false)).redirects.length, 0);
});
