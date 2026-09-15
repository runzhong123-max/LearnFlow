import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { layoutRadar, type RadarLayoutNode } from "../lib/hub/radar-layout";

type Point = { x: number; y: number };
type Edge = { source: string; target: string };
function crossings(points: Map<string, Point>, edges: Edge[]) {
  const side = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let count = 0;
  edges.forEach((e, i) => edges.slice(i + 1).forEach(f => {
    if (new Set([e.source, e.target, f.source, f.target]).size !== 4) return;
    const a = points.get(e.source)!, b = points.get(e.target)!, c = points.get(f.source)!, d = points.get(f.target)!;
    if (side(a, b, c) * side(a, b, d) < -1e-6 && side(c, d, a) * side(c, d, b) < -1e-6) count++;
  }));
  return count;
}
function oldLayout(nodes: RadarLayoutNode[]) {
  return new Map(nodes.map(node => {
    const peers = nodes.filter(n => n.ring === node.ring);
    const angle = -Math.PI / 2 + Math.PI * 2 * peers.indexOf(node) / peers.length + (node.ring % 2 ? 0.08 : 0);
    const r = node.ring === 0 ? 0 : 258 * (0.28 + node.ring * 0.14);
    return [node.id, { x: 450 + Math.cos(angle) * r, y: 300 + Math.sin(angle) * r }];
  }));
}
function assertSeparated(nodes: RadarLayoutNode[], points: Map<string, Point>) {
  const box = (node: RadarLayoutNode) => {
    const p = points.get(node.id)!;
    const w = Math.max(node.labelWidth, node.size) / 2;
    const top = node.ring === 0 ? Math.max(node.size, node.labelHeight) / 2 : node.size / 2;
    return { left: p.x - w, right: p.x + w, top: p.y - top, bottom: p.y + (node.ring === 0 ? top : node.size / 2 + node.labelHeight + 8) };
  };
  nodes.forEach((a, i) => nodes.slice(i + 1).forEach(b => {
    const p = box(a), q = box(b);
    assert.ok(p.right <= q.left || q.right <= p.left || p.bottom <= q.top || q.bottom <= p.top, `${a.id} overlaps ${b.id}`);
  }));
}
const node = (id: string, ring: number): RadarLayoutNode => ({ id, ring, size: ring === 0 ? 62 : 22, labelWidth: ring === 0 ? 270 : 160, labelHeight: 22 });

test("radar reduces crossed branches without changing input, and separates long labels", () => {
  const nodes = [node("root", 0), ...[1, 2, 3].flatMap(ring => Array.from({ length: 4 }, (_, i) => node(`${ring}-${i}`, ring)))];
  const edges = Array.from({ length: 4 }, (_, i) => [
    { source: "root", target: `1-${i}` },
    { source: `1-${i}`, target: `2-${3 - i}` },
    { source: `2-${3 - i}`, target: `3-${i}` },
  ]).flat();
  const before = JSON.stringify({ nodes, edges });
  const result = layoutRadar(nodes, edges, 900, 600);
  assert.ok(crossings(result, edges) < crossings(oldLayout(nodes), edges));
  assertSeparated(nodes, result);
  assert.deepEqual(result.get("root"), { x: 450, y: 300 });
  assert.equal(JSON.stringify({ nodes, edges }), before);
  assert.deepEqual(result, layoutRadar([...nodes].reverse(), [...edges].reverse(), 900, 600));
});

test("bundled role graph has fewer crossings and no label overlaps", () => {
  const graph = JSON.parse(readFileSync(new URL("../public/data/graph.json", import.meta.url), "utf8"));
  const nodes = graph.nodes.map((n: { id: string; ring: number }) => node(n.id, n.ring));
  const positions = layoutRadar(nodes, graph.edges, 900, 600);
  const before = crossings(oldLayout(nodes), graph.edges), after = crossings(positions, graph.edges);
  assert.ok(after < before, `${before} -> ${after}`);
  assertSeparated(nodes, positions);
  console.info(`Bundled radar crossings: ${before} -> ${after}`);
});

test("empty, filtered, disconnected and multiple central nodes remain finite and separated", () => {
  assert.equal(layoutRadar([], [], 520, 500).size, 0);
  for (const nodes of [[node("only", 4)], [node("a", 0), node("b", 0), node("c", 5)], Array.from({ length: 80 }, (_, i) => node(String(i), i % 4 + 1))]) {
    const result = layoutRadar(nodes, [{ source: nodes[0].id, target: "missing" }], 520, 500);
    assert.equal(result.size, nodes.length);
    assert.ok([...result.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    assertSeparated(nodes, result);
  }
});
