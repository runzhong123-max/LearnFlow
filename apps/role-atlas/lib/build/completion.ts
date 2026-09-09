import type { ColdStartBuildResult } from "./types";

/** An evidence-only draft is useful for diagnostics, not a completed kernel. */
export function assertTaskKernel(result: ColdStartBuildResult) {
  if (!result.semantic.nodes.some(node => node.type === "task")) {
    throw new Error("TASK_EVIDENCE_MISSING：未能从可用证据形成典型工作任务，本轮生成未完成。已保留资料和检索记录，请补充岗位职责或真实项目材料后重试；开启联网时将继续补研。");
  }
}
