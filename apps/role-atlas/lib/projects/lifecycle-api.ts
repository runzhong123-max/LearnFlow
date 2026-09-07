import { ensureAppSchema, getD1 } from "@/db";
import { accessErrorResponse, requestActor } from "@/lib/access";
import { mayManageProject, projectLifecycleStatements, type ProjectActor } from "./lifecycle";

export async function projectActor(request: Request): Promise<ProjectActor | Response> {
  try { return await requestActor(request); }
  catch (error) { return accessErrorResponse(error); }
}

export async function manageProject(request: Request, projectId: string, action: "delete" | "restore") {
  try {
    const actor = await projectActor(request);
    if (actor instanceof Response) return actor;
    await ensureAppSchema();
    const d1 = getD1();
    const project = await d1.prepare("SELECT id, owner_subject_id FROM projects WHERE id=?").bind(projectId)
      .first<{ id: string; owner_subject_id: string | null }>();
    if (!project) return Response.json({ error: "项目不存在。" }, { status: 404 });
    if (!mayManageProject(project.owner_subject_id, actor)) return Response.json({ error: project.owner_subject_id
      ? "只有项目所有者或管理员可以执行此操作。" : "此历史项目尚未登记所有者，只有管理员可以删除或恢复。" }, { status: 403 });
    await d1.batch(projectLifecycleStatements(d1, { projectId, actor, action, now: new Date().toISOString() }));
    return Response.json({ projectId, status: action === "delete" ? "deleted" : "restored", recoverable: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "项目管理服务暂时不可用，请稍后重试。" }, { status: 503 });
  }
}
