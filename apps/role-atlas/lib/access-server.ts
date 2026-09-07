import { headers } from "next/headers";
import { requestActor, requireProjectAccess, type AccessActor } from "@/lib/access";

/** SSR and JSON endpoints share the same credential verification and ownership policy. */
export async function serverActor(): Promise<AccessActor | null> {
  const incoming = new Headers(await headers());
  try { return await requestActor(new Request(process.env.ROLE_ATLAS_PUBLIC_URL || "http://localhost:3000", { headers: incoming })); }
  catch { return null; }
}
export async function serverMayReadProject(projectId: string) {
  const actor = await serverActor();
  if (!actor) return false;
  try { await requireProjectAccess(actor, projectId); return true; }
  catch { return false; }
}
