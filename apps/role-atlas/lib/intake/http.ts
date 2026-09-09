import { AccessError } from "@/lib/access";
import { IntakeError } from "./types";

export const intakeHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export function intakeErrorResponse(error: unknown) {
  if (error instanceof IntakeError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: intakeHeaders });
  if (error instanceof AccessError) return Response.json({ error: error.code, code: error.code }, { status: error.status, headers: intakeHeaders });
  return Response.json({ error: "岗位说明暂时无法保存或读取，请稍后重试。", code: "INTAKE_UNAVAILABLE" }, { status: 503, headers: intakeHeaders });
}
