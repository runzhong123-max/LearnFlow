import { authorizeApiRequest, requestActor } from "@/lib/access";
import { turnIntake } from "@/lib/intake/server";
import { intakeTurnSchema } from "@/lib/intake/types";
import { intakeErrorResponse, intakeHeaders } from "@/lib/intake/http";

export const runtime = "edge";
export async function POST(request: Request, context: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 800_000) return Response.json({ error: "岗位说明请求过大。", code: "INTAKE_INPUT_TOO_LARGE" }, { status: 413, headers: intakeHeaders });
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  const parsed = intakeTurnSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "岗位说明输入无效，请检查岗位、资料或操作标识。", code: "INTAKE_INPUT_INVALID" }, { status: 400, headers: intakeHeaders });
  try {
    const actor = await requestActor(request), params = await context.params;
    return Response.json({ intake: await turnIntake({ ...params, actor, request, turn: parsed.data }) }, { headers: intakeHeaders });
  } catch (error) { return intakeErrorResponse(error); }
}
