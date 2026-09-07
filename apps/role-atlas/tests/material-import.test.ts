import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { detectMaterialUrls, MaterialImportQueue, type ImportItem } from "@/lib/material-import";

test("粘贴列表、中文说明和Markdown可提取多个链接，保留查询并去重", () => {
  const found = detectMaterialUrls("参考 [标准](https://EXAMPLE.com/a?q=1,2&sort=desc)，还有 https://docs.example.com/wiki/Test_(system)。\nwww.example.org/help；https://example.com/a?q=1,2&sort=desc#part\nhttps://one.example.com,https://two.example.com");
  assert.deepEqual(found.urls, ["https://EXAMPLE.com/a?q=1,2&sort=desc", "https://docs.example.com/wiki/Test_(system)", "https://www.example.org/help", "https://one.example.com", "https://two.example.com"]);
  assert.equal(found.duplicates, 1);
  assert.deepEqual(detectMaterialUrls("职责：服务器运维，故障定位与回滚").urls, []);
  assert.deepEqual(detectMaterialUrls("http://example.com/private").urls, ["http://example.com/private"], "非HTTPS仍识别为独立项，由安全读取器明确拒绝，不悄悄遗漏");
});

test("三个并发槽及时交付结果，慢链接不阻塞后续，失败可独立重试", async () => {
  const gates = new Map<number, { resolve: (value: number) => void; reject: (error: Error) => void }>();
  const started: number[] = []; const results: number[] = [];
  let current: ImportItem<number>[] = []; let busy = false;
  const queue = new MaterialImportQueue<number, number>({ concurrency: 3,
    load: (input) => { started.push(input); return new Promise((resolve, reject) => gates.set(input, { resolve, reject })); },
    onResult: (result) => { results.push(result); }, onUpdate: (items, active) => { current = items; busy = active; },
  });
  queue.enqueue([1, 2, 3, 4].map((input) => ({ id: String(input), label: String(input), input })));
  await setImmediate(); assert.deepEqual(started, [1, 2, 3]); assert.equal(busy, true);
  gates.get(2)!.resolve(2); await setImmediate();
  assert.deepEqual(results, [2]); assert.deepEqual(started, [1, 2, 3, 4]);
  gates.get(3)!.reject(new Error("网站拒绝读取（403）")); await setImmediate();
  assert.equal(current.find((item) => item.id === "3")?.status, "failed");
  assert.equal(current.find((item) => item.id === "3")?.canRetry, true);
  queue.retry("3"); await setImmediate(); gates.get(3)!.resolve(30);
  gates.get(4)!.resolve(4); gates.get(1)!.resolve(1); await setImmediate();
  assert.deepEqual(results, [2, 30, 4, 1]); assert.equal(busy, false);
  assert.ok(current.every((item) => item.status === "ready"));
});

test("取消排队项不发请求，已取消的慢解析晚到也不能加入资料；重试与卸载有界", async () => {
  let finish!: (value: number) => void;
  const started: number[] = []; const results: number[] = []; let items: ImportItem<number>[] = [];
  const queue = new MaterialImportQueue<number, number>({ concurrency: 1,
    load: (input) => { started.push(input); return new Promise((resolve) => { finish = resolve; }); },
    onResult: (result) => { results.push(result); }, onUpdate: (next) => { items = next; },
  });
  queue.enqueue([1, 2].map((input) => ({ id: String(input), label: String(input), input })));
  await setImmediate(); queue.cancel("2"); queue.cancel("1"); queue.retry("1");
  assert.equal(items[0].canRetry, false, "旧执行释放并发槽前不可重复启动同一项");
  finish(1); await setImmediate(); assert.deepEqual(results, []); assert.deepEqual(started, [1]);
  queue.retry("2"); await setImmediate(); assert.deepEqual(started, [1, 2]);
  queue.dispose(); finish(2); await setImmediate(); assert.deepEqual(results, []);
});
