import { authorizeApiRequest, requestActor } from "@/lib/access";
import { confirmIntake } from "@/lib/intake/server";
import { intakeConfirmSchema } from "@/lib/intake/types";
import { intakeErrorResponse, intakeHeaders } from "@/lib/intake/http";

export const runtime = "edge";
export async function POST(request: Request, context: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const parsed = intakeConfirmSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请确认当前版本的岗位说明。", code: "INTAKE_CONFIRMATION_INVALID" }, { status: 400, headers: intakeHeaders });
  try {
    const actor = await requestActor(request), params = await context.params;
    return Response.json({ intake: await confirmIntake({ ...params, actor, ...parsed.data }) }, { headers: intakeHeaders });
  } catch (error) { return intakeErrorResponse(error); }
}
