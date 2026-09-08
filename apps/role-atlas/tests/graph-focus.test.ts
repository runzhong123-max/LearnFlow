import assert from "node:assert/strict";
import test from "node:test";
import { graphFocusStates } from "@/lib/hub/graph-focus";

test("聚焦包含双向一跳邻居，淡化无关节点并保留原关系方向", () => {
  const nodes = ["a", "b", "c", "d"].map(id => ({ id }));
  const edges = [{ id: "ab", source: "a", target: "b" }, { id: "ca", source: "c", target: "a" }, { id: "bd", source: "b", target: "d" }];
  const states = graphFocusStates(nodes, edges, "a");
  assert.deepEqual(states.a, ["selected"]);
  assert.deepEqual(states.b, ["related"]);
  assert.deepEqual(states.c, ["related"]);
  assert.deepEqual(states.d, ["inactive"]);
  assert.deepEqual(states.ca, ["related"]);
  assert.deepEqual(states.bd, ["inactive"]);
  assert.equal(edges[1].source, "c");
  assert.ok(Object.values(graphFocusStates(nodes, edges, "missing")).every(value => !value.length));
});


test("鼠标移开后恢复所有节点和关系，详情选中仅保留自身描边", () => {
  const nodes = ["a", "b", "c"].map(id => ({ id }));
  const edges = [{ id: "ab", source: "a", target: "b" }];
  assert.deepEqual(graphFocusStates(nodes, edges, "a", "a").c, ["inactive"]);
  const restored = graphFocusStates(nodes, edges, "", "a");
  assert.deepEqual(restored, { a: ["selected"], b: [], c: [], ab: [] });
  assert.ok(Object.values(graphFocusStates(nodes, edges, "")).every(states => !states.length));
  assert.ok(Object.values(graphFocusStates(nodes, edges, "removed", "a")).every(states => !states.includes("inactive")));
});
