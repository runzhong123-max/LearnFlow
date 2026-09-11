import { z } from "zod";
import type { ColdStartBuildResult } from "@/lib/build/types";
import type { IterationMode, SnapshotIterationRequest } from "./types";
import { radarAxisLabel, type RadarPresentation } from "./product-presentation";

/**
 * Turn confirmed radar directions into the next round's request.
 *
 * The radar is a suggestion layer, and a suggestion nobody can act on is
 * decoration. This is the missing link: the user picks directions, and code
 * deterministically produces the request that studies exactly those — no model
 * in the loop, because choosing scope is exactly the decision a model must not
 * make (see invariant 21).
 *
 * Two guards matter here:
 *
 *   - Scope comes from the selected items' own `affectedNodeIds`, filtered to
 *     nodes that actually exist. A selection can therefore never reach beyond
 *     what the radar pointed at.
 *   - The target list is capped. Clicking every direction is a normal thing for
 *     a person to do, and it must not silently request an unbounded study.
 */

export const MAX_SELECTED_DIRECTIONS = 8;
export const MAX_SELECTED_TARGETS = 40;

export const radarSelectionSchema = z.object({
  /** Radar item ids, as presented to the user. */
  directionIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_SELECTED_DIRECTIONS),
});
export type RadarSelection = z.infer<typeof radarSelectionSchema>;

/**
 * Axis → iteration mode. A freshness signal is a temporal question, a boundary
 * drift is a risk question, everything else is ordinary deepening. Deterministic
 * so the same selection always produces the same kind of study.
 */
const MODE_BY_AXIS: Record<string, IterationMode> = {
  freshness_signal: "freshness",
  boundary_drift: "risk_repair",
};

export function iterationModeForSelection(items: Array<{ axisId: string }>): IterationMode {
  const modes = new Set(items.map(item => MODE_BY_AXIS[item.axisId] || "deep_research"));
  // A mixed selection is ordinary deepening: picking several modalities at once
  // is not a request to run them as one specialised mode.
  return modes.size === 1 ? [...modes][0] : "deep_research";
}

export type RadarSelectionResult = {
  request: Pick<SnapshotIterationRequest, "mode" | "initiativeProfile" | "targetIds" | "prompt">;
  /** Directions whose nodes no longer exist, reported rather than dropped quietly. */
  droppedDirections: Array<{ id: string; reason: string }>;
};

/**
 * `presented` is what the user actually saw, so a selection can only be built
 * from directions that were on screen — a stale or fabricated id is refused.
 */
export function radarSelectionToIteration(input: {
  base: ColdStartBuildResult;
  selection: RadarSelection;
  /** The ranked items that were rendered, in the order the user saw them. */
  presented: Array<RadarPresentation & { id: string }>;
}): RadarSelectionResult {
  const known = new Set(input.base.semantic.nodes.map(node => node.id));
  const byId = new Map(input.presented.map(item => [item.id, item]));
  const dropped: Array<{ id: string; reason: string }> = [];
  const chosen: Array<RadarPresentation & { id: string }> = [];

  for (const id of input.selection.directionIds) {
    const item = byId.get(id);
    if (!item) {
      dropped.push({ id, reason: "该方向不在本次雷达展示的清单里，不能据此发起研究" });
      continue;
    }
    chosen.push(item);
  }

  const targets: string[] = [];
  for (const item of chosen) {
    for (const nodeId of item.affectedNodeIds) {
      if (!known.has(nodeId)) continue;
      if (!targets.includes(nodeId)) targets.push(nodeId);
      if (targets.length >= MAX_SELECTED_TARGETS) break;
    }
    if (targets.length >= MAX_SELECTED_TARGETS) break;
  }
  if (!targets.length) {
    return {
      request: { mode: "auto", initiativeProfile: "user_directed", targetIds: [], prompt: "" },
      droppedDirections: [
        ...dropped,
        ...chosen.map(item => ({ id: item.id, reason: "该方向指向的节点已不在当前快照中" })),
      ],
    };
  }

  const directions = chosen.map(item => item.direction).filter(Boolean);
  const prompt = [
    `按雷达确认的方向继续研究：${directions.join("；")}`,
    // The signal is what makes the direction checkable later; without it the
    // next round would only have a slogan to work from.
    chosen.map(item => `- ${radarAxisLabel(item.axis)}：${item.gapSignal}`).join("\n"),
  ].join("\n").slice(0, 4_000);

  return {
    request: {
      mode: iterationModeForSelection(chosen),
      // A user picked these, so the profile is user_directed: never autonomous.
      initiativeProfile: "user_directed",
      targetIds: targets,
      prompt,
    },
    droppedDirections: dropped,
  };
}
