import { ensureAppSchema, getD1 } from "@/db";
import { getPackageArtifact } from "@/lib/packages/artifact-store";
import { createEcosystemRepository } from "./repository-core";
export const ecosystemRepository = createEcosystemRepository(async () => { await ensureAppSchema(); return getD1(); }, getPackageArtifact);
