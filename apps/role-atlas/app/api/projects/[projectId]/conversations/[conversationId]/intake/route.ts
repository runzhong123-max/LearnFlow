import { authorizeApiRequest, requestActor } from "@/lib/access";
import { getIntake } from "@/lib/intake/server";
import { intakeErrorResponse, intakeHeaders } from "@/lib/intake/http";

export const runtime = "edge";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const actor = await requestActor(request), params = await context.params;
    return Response.json({ intake: await getIntake({ ...params, actor }) }, { headers: intakeHeaders });
  } catch (error) { return intakeErrorResponse(error); }
}
