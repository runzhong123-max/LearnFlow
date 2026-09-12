import type { ColdStartBuildResult } from "@/lib/build/types";

/** Old Hub forks copied the upstream routing ID at the top level. Repair only
 * this known envelope defect when reading the owner's version. Stored bytes and
 * historical hashes remain untouched; subsequent iterations commit new versions. */
export function projectResultIdentity(result: ColdStartBuildResult, projectId: string): ColdStartBuildResult {
  if (/^fork:[a-f0-9]{64}$/.test(projectId) && result.brief.projectId === projectId && result.projectId !== projectId) {
    return { ...result, projectId };
  }
  return result;
}
