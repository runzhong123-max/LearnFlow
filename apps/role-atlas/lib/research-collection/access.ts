import { AccessError, requestActor } from "@/lib/access";
export async function requireResearchAdmin(request: Request) {
 const actor=await requestActor(request);
 if(actor.role!=="admin")throw new AccessError(403,"ADMIN_REQUIRED");
 return actor;
}
