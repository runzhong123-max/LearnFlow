/** Pure presentation layout: never changes graph membership, rings or relations. */
export type RadarLayoutNode = {
  id: string;
  ring: number;
  size: number;
  labelWidth: number;
  labelHeight: number;
};
type Edge = { source: string; target: string };
type Point = { x: number; y: number };
const TAU = 2 * Math.PI;
const normalize = (angle: number) => (angle % TAU + TAU) % TAU;

export function layoutRadar(nodes: readonly RadarLayoutNode[], edges: readonly Edge[], width: number, height: number): Map<string, Point> {
  const sorted = [...nodes].sort((a, b) => a.ring - b.ring || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(sorted.map(node => [node.id, node]));
  const links = edges.filter(edge => edge.source !== edge.target && byId.has(edge.source) && byId.has(edge.target));
  const neighbors = new Map(sorted.map(node => [node.id, new Set<string>()]));
  for (const edge of links) {
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
  }
  const rings = new Map<number, RadarLayoutNode[]>();
  for (const node of sorted) {
    if (!rings.has(node.ring)) rings.set(node.ring, []);
    rings.get(node.ring)!.push(node);
  }
  const levels = [...rings.keys()].filter(ring => ring !== 0);
  const step = Math.max(100, Math.min(width, height) * 0.4 / Math.max(1, levels.length));
  const radius = (ring: number) => ring === 0 ? 0 : 150 + levels.indexOf(ring) * step;
  let points = new Map<string, Point>();
  const angles = new Map<string, number>();
  const place = (ring: number, peers: RadarLayoutNode[], offset: number) => {
    peers.forEach((node, index) => {
      // Multiple central nodes are unusual but must not share a coordinate.
      const r = ring === 0 && peers.length > 1 ? 65 : radius(ring);
      const angle = offset + TAU * index / peers.length;
      angles.set(node.id, angle);
      points.set(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    });
  };
  for (const [ring, peers] of rings) place(ring, peers, -Math.PI / 2);

  const score = () => {
    let crossings = 0;
    let length = 0;
    const segments = links.map(edge => ({ ...edge, a: points.get(edge.source)!, b: points.get(edge.target)! }));
    const side = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    for (let i = 0; i < segments.length; i++) {
      const e = segments[i];
      length += Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y);
      for (let j = i + 1; j < segments.length; j++) {
        const f = segments[j];
        if (e.source === f.source || e.source === f.target || e.target === f.source || e.target === f.target) continue;
        if (side(e.a, e.b, f.a) * side(e.a, e.b, f.b) < -1e-6 && side(f.a, f.b, e.a) * side(f.a, f.b, e.b) < -1e-6) crossings++;
      }
    }
    return { crossings, length };
  };
  const better = (a: ReturnType<typeof score>, b: ReturnType<typeof score>) => a.crossings < b.crossings || (a.crossings === b.crossings && a.length < b.length - 1e-6);
  let best = score();
  let bestPoints = new Map(points);
  // Circular barycentres put shared neighbors near each other, including across
  // the 0/2π seam. Alternate outward/inward sweeps; ignore the central hub.
  for (let sweep = 0; sweep < 6; sweep++) {
    for (const ring of sweep % 2 ? [...levels].reverse() : levels) {
      const peers = rings.get(ring)!;
      const preferred = new Map(peers.map(node => {
        const adjacent = [...neighbors.get(node.id)!].filter(id => byId.get(id)!.ring !== 0).sort();
        const x = adjacent.reduce((sum, id) => sum + Math.cos(angles.get(id)!), 0);
        const y = adjacent.reduce((sum, id) => sum + Math.sin(angles.get(id)!), 0);
        return [node.id, Math.hypot(x, y) > 1e-6 ? Math.atan2(y, x) : angles.get(node.id)!];
      }));
      peers.sort((a, b) => normalize(preferred.get(a.id)! + Math.PI / 2) - normalize(preferred.get(b.id)! + Math.PI / 2) || (a.id < b.id ? -1 : 1));
      let x = 0, y = 0;
      peers.forEach((node, index) => {
        const offset = preferred.get(node.id)! - TAU * index / peers.length;
        x += Math.cos(offset);
        y += Math.sin(offset);
      });
      place(ring, peers, Math.hypot(x, y) > 1e-6 ? Math.atan2(y, x) : -Math.PI / 2);
    }
    const candidate = score();
    if (better(candidate, best)) { best = candidate; bestPoints = new Map(points); }
  }
  points = bestPoints;
  // Bounded local refinement: exchange neighboring slots only when the actual
  // straight-edge crossing count improves (edge length breaks ties).
  if (nodes.length <= 120 && links.length <= 300) {
    for (let pass = 0; pass < 2; pass++) {
      for (const ring of levels) {
        const peers = [...rings.get(ring)!].sort((a, b) => {
          const p = points.get(a.id)!, q = points.get(b.id)!;
          return Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x);
        });
        for (let i = 0; i < peers.length - 1; i++) {
          const a = peers[i].id, b = peers[i + 1].id;
          const p = points.get(a)!, q = points.get(b)!;
          points.set(a, q); points.set(b, p);
          const candidate = score();
          if (better(candidate, best)) best = candidate;
          else { points.set(a, p); points.set(b, q); }
        }
      }
    }
  }
  // Scale the radial geometry just enough to separate node + label rectangles.
  // Uniform expansion preserves angular ordering and all crossing improvements.
  let scale = 1;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i], p = points.get(a.id)!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j], q = points.get(b.id)!;
      const horizontal = (Math.max(a.size, a.labelWidth) / 2 + Math.max(b.size, b.labelWidth) / 2 + 12) / Math.max(1e-9, Math.abs(p.x - q.x));
      // Labels remain below nodes; the central label is centered.
      const top = (node: RadarLayoutNode) => node.ring === 0 ? Math.max(node.size, node.labelHeight) / 2 : node.size / 2;
      const bottom = (node: RadarLayoutNode) => node.ring === 0 ? top(node) : node.size / 2 + node.labelHeight + 8;
      const vertical = ((p.y < q.y ? bottom(a) + top(b) : bottom(b) + top(a)) + 12) / Math.max(1e-9, Math.abs(p.y - q.y));
      scale = Math.max(scale, Math.min(horizontal, vertical));
    }
  }
  return new Map(sorted.map(node => {
    const p = points.get(node.id)!;
    return [node.id, { x: width / 2 + p.x * scale, y: height / 2 + p.y * scale }];
  }));
}
