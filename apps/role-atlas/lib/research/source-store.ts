import { prepareBuildInput } from "@/lib/build/compiler";
import type { ColdStartRequest, SourceAsset, SourceInput, SourceSegment } from "@/lib/build/types";
export class ResearchSourceStore {
  readonly assets: SourceAsset[];
  readonly segments: SourceSegment[];
  readonly collected: SourceInput[] = [];
  constructor(assets: SourceAsset[] = [], segments: SourceSegment[] = []) { this.assets = structuredClone(assets); this.segments = structuredClone(segments); }
  ingest(request: ColdStartRequest, sources: SourceInput[]) {
    const added: SourceSegment[] = [];
    for (const source of sources) {
      const prepared = prepareBuildInput({ ...request, sources: [source] });
      const asset = prepared.assets.find(item => item.kind !== "user_brief");
      if (!asset) continue;
      const existing = this.assets.find(item => item.contentHash === asset.contentHash && item.locator === asset.locator);
      if (existing) { added.push(...this.segments.filter(segment => segment.sourceId === existing.id)); continue; }
      this.assets.push(asset); this.collected.push(source);
      const segments = prepared.segments.filter(segment => segment.sourceId === asset.id);
      this.segments.push(...segments); added.push(...segments);
    }
    return added;
  }
  verify(segmentId: string, quote: string) { return this.segments.some(segment => segment.id === segmentId && Boolean(quote.trim()) && segment.text.includes(quote)); }
}
