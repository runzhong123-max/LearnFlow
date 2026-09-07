import type { ColdStartBuildResult } from "@/lib/build/types";

/** The same nodes can be selected in the radar or the work-process view. */
export function iterationTargetNodes(result: ColdStartBuildResult) {
  return [
    ...result.semantic.nodes.map(({ id, label }) => ({ id, label })),
    ...result.process.scenarios.map(({ id, label }) => ({ id, label })),
    ...result.process.nodes.map(({ id, label }) => ({ id, label })),
  ];
}
